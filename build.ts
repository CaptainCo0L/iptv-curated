// Builds my-playlist/playlist.m3u from ../streams. Run from anywhere with:
//   node "D:\Claude Apps\iptv\my-playlist\build.ts" [older-playlist.m3u ...]
// Channels already in playlist.m3u are kept as they are and never retested, because a stream
// that fails at one time of day often works at another. Only channels new to the playlist are
// tested. Older playlists passed as arguments are merged in too, which restores what they had
import { readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

type Stream = {
  id: string
  title: string
  url: string
  opts: string[]
  isIndianFile: boolean
}
type Channel = {
  id: string
  country: string
  categories: string[]
  is_nsfw: boolean
  closed: string | null
}
type Feed = { channel: string; id: string; is_main: boolean; languages: string[] }
type Logo = { channel: string; feed: string | null; in_use: boolean; format: string; url: string }

const API = 'https://iptv-org.github.io/api'
const OUTPUT = join(import.meta.dirname, 'playlist.m3u')
const STREAMS_DIR = join(import.meta.dirname, '..', 'streams')
const TIMEOUT = 20000
const CONCURRENCY = 75
const PER_CHANNEL = 2 // best stream plus one backup

const FOLDERS = [
  'Kerala Vision',
  'Indian',
  'English',
  'Sports',
  'Travel & Lifestyle',
  'Fashion',
  'Science',
  '4K',
  'Movies',
  'TV Series',
  'Music'
]
const EXCLUDED_CATEGORIES = ['religious', 'shop', 'xxx']
const FASHION = /\b(fashion|ftv)\b/i
// Always in Fashion, whatever their language tag says. FashionTV.in is left out on purpose
const FASHION_CHANNELS = [
  'FashionBox.nl',
  'FashionTV.ru',
  'FashionTV.ua',
  'FashionTVEurope.fr',
  'FashionTVParisLOriginal.fr',
  'FashionTVSecrets.fr'
]
const SCIENCE =
  /\b(discovery|nat ?geo|national geographic|animal planet|bbc earth|history|smithsonian|love nature)\b/i
const UHD = /\b(4k|uhd|2160p)\b/i
// Kerala Vision cable lineup (kccl.tv/pdf/FULL-CHANNEL-LIST.pdf), hand-mapped to channel ids.
// Its channels get a copy in the Kerala Vision folder, ordered by cable channel number
const KERALA_VISION_FILE = join(import.meta.dirname, 'keralavision.json')
const KERALA_VISION = 'Kerala Vision'

function parsePlaylist(file: string): Stream[] {
  const streams: Stream[] = []
  const isIndianFile = /^in(_|\.)/.test(file)
  let entry: { id: string; title: string; opts: string[] } | null = null

  for (const raw of readFileSync(join(STREAMS_DIR, file), 'utf8').split('\n')) {
    const line = raw.trim()
    if (line.startsWith('#EXTINF')) {
      const title = line.match(/^#EXTINF:[^,"]*(?:"[^"]*"[^,"]*)*,(.*)$/)?.[1] ?? ''
      entry = { id: line.match(/tvg-id="([^"]*)"/)?.[1] ?? '', title: title.trim(), opts: [] }
    } else if (line.startsWith('#EXTVLCOPT:') && entry) {
      // some entries repeat the prefix: #EXTVLCOPT:http-user-agent=#EXTVLCOPT:http-user-agent=...
      entry.opts.push(line.slice(line.lastIndexOf('#EXTVLCOPT:') + '#EXTVLCOPT:'.length))
    } else if (line && !line.startsWith('#') && entry) {
      streams.push({ ...entry, url: line, isIndianFile })
      entry = null
    }
  }

  return streams
}

function getHeaders(stream: Stream): Record<string, string> {
  const headers: Record<string, string> = { 'User-Agent': 'VLC/3.0.20 LibVLC/3.0.20' }
  for (const opt of stream.opts) {
    const separator = opt.indexOf('=')
    const value = opt.slice(separator + 1)
    if (opt.startsWith('http-user-agent')) headers['User-Agent'] = value
    if (opt.startsWith('http-referrer')) headers['Referer'] = value
  }

  return headers
}

async function read(url: string, headers: Record<string, string>, limit: number) {
  const signal = AbortSignal.timeout(TIMEOUT)
  const response = await fetch(url, { headers, signal })
  if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`)

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
    url: response.url,
    type: response.headers.get('content-type') ?? '',
    size,
    text: Buffer.concat(chunks).toString('latin1')
  }
}

function firstUri(manifest: string, base: string, after: string): string | null {
  const lines = manifest.split('\n').map(line => line.trim())
  const index = lines.findIndex(line => line.startsWith(after))
  if (index < 0) return null
  const uri = lines.slice(index + 1).find(line => line && !line.startsWith('#'))

  return uri ? new URL(uri, base).href : null
}

// Kerala Vision copies share streams with their normal folder, so each URL is tested once
const playable = new Map<string, Promise<boolean>>()
function isPlayable(stream: Stream): Promise<boolean> {
  const cached = playable.get(stream.url) ?? checkPlayable(stream)
  playable.set(stream.url, cached)

  return cached
}

// Follows master playlist -> media playlist -> first segment, so a stale manifest fails
async function checkPlayable(stream: Stream): Promise<boolean> {
  const headers = getHeaders(stream)
  try {
    let result = await read(stream.url, headers, 512 * 1024)
    if (result.text.startsWith('#EXTM3U')) {
      const variant = firstUri(result.text, result.url, '#EXT-X-STREAM-INF')
      if (variant) result = await read(variant, headers, 512 * 1024)
      if (/#EXT-X-(SESSION-)?KEY:.*METHOD=SAMPLE-AES/.test(result.text)) return false
      const segment = firstUri(result.text, result.url, '#EXTINF')
      if (!segment) return false
      const first = await read(segment, headers, 4096)

      return first.size > 0 && !first.type.includes('text/html')
    }
    if (result.text.includes('<MPD')) return !result.text.includes('<ContentProtection')

    return result.size > 0 && !result.type.includes('text/html')
  } catch {
    return false
  }
}

function getResolution(title: string): number {
  return Number(title.match(/\((\d+)[pi]\)/)?.[1] ?? 0)
}

function rank(a: Stream, b: Stream): number {
  const score = (stream: Stream) => [
    Number(stream.title.includes('Not 24/7')),
    -getResolution(stream.title),
    Number(stream.url.startsWith('http://'))
  ]
  const [left, right] = [score(a), score(b)]

  return left[0] - right[0] || left[1] - right[1] || left[2] - right[2]
}

function getFolder(categories: string[], title: string, country: string): string {
  const has = (...names: string[]) => names.some(name => categories.includes(name))

  if (has('sports')) return 'Sports'
  if (FASHION.test(title)) return 'Fashion'
  if (has('travel', 'outdoor')) return 'Travel & Lifestyle'
  if (has('science', 'documentary', 'education') || SCIENCE.test(title)) return 'Science'
  if (has('movies', 'classic')) return 'Movies'
  if (has('series')) return 'TV Series'
  if (has('music')) return 'Music'
  if (has('lifestyle')) return 'Travel & Lifestyle'

  return country === 'IN' ? 'Indian' : 'English'
}

async function pool<T>(items: T[], worker: (item: T) => Promise<void>) {
  let next = 0
  const run = async () => {
    while (next < items.length) await worker(items[next++])
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, run))
}

async function fetchJson<T>(name: string): Promise<T> {
  const response = await fetch(`${API}/${name}.json`)
  if (!response.ok) throw new Error(`Could not load ${name}.json: HTTP ${response.status}`)

  return response.json() as Promise<T>
}

// Feed logo first, then the channel's own, then any feed's. SVG is skipped: not safe to assume players draw it
function indexLogos(logos: Logo[]): Map<string, string> {
  const usable = logos.filter(logo => logo.in_use && logo.format !== 'SVG')
  const index = new Map<string, string>()
  for (const logo of [...usable].sort((a, b) => Number(!!a.feed) - Number(!!b.feed))) {
    const keys = logo.feed ? [`${logo.channel}@${logo.feed}`, logo.channel] : [logo.channel]
    for (const key of keys) if (!index.has(key)) index.set(key, logo.url)
  }

  return index
}

// Lowest cable number per channel: Kerala Vision often lists the SD and HD versions separately
function loadKeralaVision(): Map<string, number> {
  const lineup: { sid: number; id: string | null }[] = JSON.parse(readFileSync(KERALA_VISION_FILE, 'utf8'))
  const numbers = new Map<string, number>()
  for (const { sid, id } of lineup) {
    const current = id ? numbers.get(id) : undefined
    if (id && (current === undefined || sid < current)) numbers.set(id, sid)
  }

  return numbers
}

// Matches the group keys built in main, so a kept entry blocks retesting the same channel
function getKey(id: string, title: string, folder: string): string {
  const [channelId] = id.split('@')
  const base = channelId || `untagged:${title.replace(/[([].*$/, '').trim().toLowerCase()}`
  if (folder === KERALA_VISION) return `kv:${base}`
  if (folder === '4K') return `4k:${base}`

  return base
}

type Entry = { key: string; folder: string; sortKey: string; text: string }

function getSortKey(title: string, isBackup: boolean, number?: number): string {
  return (number ? String(number).padStart(4, '0') : title.toLowerCase()) + (isBackup ? ' ~backup' : '')
}

// The first file listing a channel wins, so the current playlist beats older ones
function loadExisting(files: string[]): Entry[] {
  const entries: Entry[] = []
  const seen = new Set<string>()
  for (const file of files) {
    let lines: string[]
    try {
      lines = readFileSync(file, 'utf8').split('\n')
    } catch {
      continue
    }
    const fromFile: Entry[] = []
    let block: string[] = []
    for (const raw of lines) {
      const line = raw.trimEnd()
      if (line.startsWith('#EXTINF')) block = [line]
      else if (line.startsWith('#EXTVLCOPT:') && block.length) block.push(line)
      else if (line && !line.startsWith('#') && block.length) {
        const extinf = block[0]
        const fullTitle = extinf.match(/^#EXTINF:[^,"]*(?:"[^"]*"[^,"]*)*,(.*)$/)?.[1]?.trim() ?? ''
        const isBackup = fullTitle.endsWith(' - Backup')
        const title = isBackup ? fullTitle.slice(0, -' - Backup'.length) : fullTitle
        const folder = extinf.match(/group-title="([^"]*)"/)?.[1] ?? ''
        const id = extinf.match(/tvg-id="([^"]*)"/)?.[1] ?? ''
        const number = Number(extinf.match(/tvg-chno="(\d+)"/)?.[1] ?? 0)
        fromFile.push({
          key: getKey(id, title, folder),
          folder,
          sortKey: getSortKey(title, isBackup, number),
          text: [...block, line].join('\n')
        })
        block = []
      }
    }
    const added = fromFile.filter(entry => !seen.has(entry.key))
    for (const entry of added) seen.add(entry.key)
    entries.push(...added)
  }

  return entries
}

function toEntry(
  stream: Stream,
  folder: string,
  isBackup: boolean,
  logos: Map<string, string>,
  number?: number
): string {
  const title = isBackup ? `${stream.title} - Backup` : stream.title
  const logo = logos.get(stream.id) ?? logos.get(stream.id.split('@')[0])
  const logoAttr = logo ? ` tvg-logo="${logo}"` : ''
  const numberAttr = number ? ` tvg-chno="${number}"` : ''
  const extinf = `#EXTINF:-1 tvg-id="${stream.id}"${numberAttr}${logoAttr} group-title="${folder}",${title}`
  const opts = stream.opts.map(opt => `#EXTVLCOPT:${opt}`)

  return [extinf, ...opts, stream.url].join('\n')
}

async function main() {
  const [channels, feeds, logoList] = await Promise.all([
    fetchJson<Channel[]>('channels'),
    fetchJson<Feed[]>('feeds'),
    fetchJson<Logo[]>('logos')
  ])
  const logos = indexLogos(logoList)
  const keralaVision = loadKeralaVision()
  const channelsById = new Map(channels.map(channel => [channel.id, channel]))
  const feedsById = new Map(feeds.map(feed => [`${feed.channel}@${feed.id}`, feed]))
  const mainFeeds = new Map(feeds.filter(feed => feed.is_main).map(feed => [feed.channel, feed]))

  const files = readdirSync(STREAMS_DIR).filter(file => file.endsWith('.m3u'))
  const groups = new Map<string, { folder: string; number?: number; streams: Stream[] }>()
  const add = (key: string, folder: string, stream: Stream, number?: number) => {
    const group = groups.get(key) ?? { folder, number, streams: [] }
    if (!group.streams.some(item => item.url === stream.url)) group.streams.push(stream)
    groups.set(key, group)
  }

  let skippedLanguage = 0
  for (const stream of files.flatMap(parsePlaylist)) {
    const [channelId] = stream.id.split('@')
    const channel = channelsById.get(channelId)

    if (!channel) {
      // no metadata to classify by, so only the Indian files can be trusted for scope
      if (!stream.isIndianFile) {
        skippedLanguage++
        continue
      }
      const name = stream.title.replace(/[([].*$/, '').trim().toLowerCase()
      add(`untagged:${name}`, 'Indian', stream)
      if (UHD.test(stream.title)) add(`4k:untagged:${name}`, '4K', stream)
      continue
    }

    if (channel.is_nsfw || channel.closed) continue
    if (channel.categories.some(name => EXCLUDED_CATEGORIES.includes(name))) continue

    // on the cable lineup, so wanted whatever the language
    const number = keralaVision.get(channelId)
    if (number) add(`kv:${channelId}`, KERALA_VISION, stream, number)

    const feed = feedsById.get(stream.id) ?? mainFeeds.get(channelId)
    const isFashion = FASHION_CHANNELS.includes(channelId)
    if (!isFashion && channel.country !== 'IN' && !feed?.languages.includes('eng')) {
      skippedLanguage++
      continue
    }

    const folder = isFashion ? 'Fashion' : getFolder(channel.categories, stream.title, channel.country)
    add(channelId, folder, stream)
    if (UHD.test(stream.title)) add(`4k:${channelId}`, '4K', stream)
  }

  const existing = loadExisting([OUTPUT, ...process.argv.slice(2)])
  const known = new Set(existing.map(entry => entry.key))
  const entries = new Map<string, { title: string; text: string }[]>()
  for (const folder of FOLDERS) entries.set(folder, [])
  for (const entry of existing) {
    if (!entries.has(entry.folder)) entries.set(entry.folder, [])
    entries.get(entry.folder)?.push({ title: entry.sortKey, text: entry.text })
  }
  console.log(`Kept ${known.size} channels (${existing.length} entries) without retesting`)

  const candidates = [...groups].filter(([key]) => !known.has(key)).map(([, group]) => group)
  const total = candidates.reduce((sum, group) => sum + group.streams.length, 0)
  console.log(`${candidates.length} new channels, ${total} streams to test`)

  let tested = 0
  let passed = 0
  await pool(candidates, async group => {
    let found = 0
    for (const stream of group.streams.sort(rank)) {
      if (found === PER_CHANNEL) break
      tested++
      if (tested % 500 === 0) console.log(`tested ${tested}, ${passed} passed`)
      if (!(await isPlayable(stream))) continue
      passed++
      entries.get(group.folder)?.push({
        title: getSortKey(stream.title, found > 0, group.number),
        text: toEntry(stream, group.folder, found > 0, logos, group.number)
      })
      found++
    }
  })

  const body = [...entries.values()].flatMap(list =>
    list.sort((a, b) => a.title.localeCompare(b.title)).map(entry => entry.text)
  )
  writeFileSync(`${OUTPUT}.tmp`, ['#EXTM3U', ...body, ''].join('\n'))
  renameSync(`${OUTPUT}.tmp`, OUTPUT)

  for (const folder of FOLDERS) console.log(`${folder}: ${entries.get(folder)?.length}`)
  console.log(`Skipped outside India/English scope: ${skippedLanguage}`)
  console.log(`Tested ${tested}, added ${passed}. Wrote ${OUTPUT}`)
}

main()
