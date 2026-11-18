// Liveness probe: follows master playlist -> media playlist -> first segment, so a stale manifest
// fails. Returns why a stream failed, limits requests per host (the Pluto proxy throttles), and
// retries once on a timeout or network error. fetch is passed in, so tests use a scripted fake.

export type Probeable = { url: string; opts: string[] }
export type Result = { ok: boolean; reason: string }
export type FetchFn = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<Response>

class Failure extends Error {
  readonly reason: string
  readonly retryable: boolean
  constructor(reason: string, retryable = false) {
    super(reason)
    this.reason = reason
    this.retryable = retryable
  }
}

class Semaphore {
  private active = 0
  private waiting: (() => void)[] = []
  private readonly limit: number
  constructor(limit: number) {
    this.limit = limit
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>(resolve => this.waiting.push(resolve))
    this.active++
    try {
      return await task()
    } finally {
      this.active--
      this.waiting.shift()?.()
    }
  }
}

export function getHeaders(stream: Probeable): Record<string, string> {
  const headers: Record<string, string> = { 'User-Agent': 'VLC/3.0.20 LibVLC/3.0.20' }
  for (const opt of stream.opts) {
    const value = opt.slice(opt.indexOf('=') + 1)
    if (opt.startsWith('http-user-agent')) headers['User-Agent'] = value
    if (opt.startsWith('http-referrer')) headers['Referer'] = value
  }

  return headers
}

function firstUri(manifest: string, base: string, after: string): string | null {
  const lines = manifest.split('\n').map(line => line.trim())
  const index = lines.findIndex(line => line.startsWith(after))
  if (index < 0) return null
  const uri = lines.slice(index + 1).find(line => line && !line.startsWith('#'))

  return uri ? new URL(uri, base).href : null
}

function describe(error: unknown): Failure {
  if (error instanceof Failure) return error
  const err = error as { name?: string; message?: string; cause?: { code?: string } }
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return new Failure('timeout', true)

  return new Failure(`network ${err?.cause?.code ?? err?.message ?? 'error'}`, true)
}

export type ProberOptions = { fetchFn?: FetchFn; timeout?: number; perHost?: number; total?: number; retries?: number }

export function createProber(options: ProberOptions = {}) {
  const fetchFn = options.fetchFn ?? (fetch as FetchFn)
  const timeout = options.timeout ?? 20000
  const retries = options.retries ?? 1
  const total = new Semaphore(options.total ?? 75)
  const hosts = new Map<string, Semaphore>()
  const cache = new Map<string, Promise<Result>>()

  async function read(url: string, headers: Record<string, string>, limit: number) {
    try {
      const response = await fetchFn(url, { headers, signal: AbortSignal.timeout(timeout) })
      if (!response.ok || !response.body) throw new Failure(`HTTP ${response.status}`)
      const chunks: Uint8Array[] = []
      let size = 0
      const reader = response.body.getReader()
      while (size < limit) {
        const { done, value } = await reader.read()
        if (done) break
        chunks.push(value)
        size += value.length
      }
      await reader.cancel().catch(() => {})

      return {
        // a Response built by hand (tests) has no url
        url: response.url || url,
        type: response.headers.get('content-type') ?? '',
        size,
        text: Buffer.concat(chunks).toString('latin1')
      }
    } catch (error) {
      throw describe(error)
    }
  }

  async function check(stream: Probeable): Promise<Result> {
    const headers = getHeaders(stream)
    let result = await read(stream.url, headers, 512 * 1024)
    if (result.text.startsWith('#EXTM3U')) {
      const variant = firstUri(result.text, result.url, '#EXT-X-STREAM-INF')
      if (variant) result = await read(variant, headers, 512 * 1024)
      if (/#EXT-X-(SESSION-)?KEY:.*METHOD=SAMPLE-AES/.test(result.text)) return { ok: false, reason: 'SAMPLE-AES' }
      const segment = firstUri(result.text, result.url, '#EXTINF')
      if (!segment) return { ok: false, reason: 'no segment' }
      const first = await read(segment, headers, 4096)
      if (first.size === 0) return { ok: false, reason: 'empty segment' }
      if (first.type.includes('text/html')) return { ok: false, reason: 'html segment' }

      return { ok: true, reason: 'ok' }
    }
    if (result.text.includes('<MPD')) {
      return result.text.includes('<ContentProtection') ? { ok: false, reason: 'DRM' } : { ok: true, reason: 'ok' }
    }
    if (result.size === 0) return { ok: false, reason: 'empty' }
    if (result.type.includes('text/html')) return { ok: false, reason: 'html' }

    return { ok: true, reason: 'ok' }
  }

  async function attempt(stream: Probeable): Promise<Result> {
    for (let tries = 0; ; tries++) {
      try {
        return await check(stream)
      } catch (error) {
        const failure = describe(error)
        if (!failure.retryable || tries >= retries) return { ok: false, reason: failure.reason }
      }
    }
  }

  function hostOf(url: string): string {
    try {
      return new URL(url).host
    } catch {
      return ''
    }
  }

  // Each URL is tested once per run: Kerala Vision and 4K copies share streams with their folder
  function probe(stream: Probeable): Promise<Result> {
    const cached = cache.get(stream.url)
    if (cached) return cached
    const host = hostOf(stream.url)
    if (!hosts.has(host)) hosts.set(host, new Semaphore(options.perHost ?? 4))
    // host slot first, so streams queued behind a busy host don't hold one of the total slots
    const result = hosts.get(host)!.run(() => total.run(() => attempt(stream)))
    cache.set(stream.url, result)

    return result
  }

  return { probe }
}
