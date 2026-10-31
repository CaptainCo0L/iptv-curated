// Builds my-playlist/playlist.m3u from ../streams. Run from anywhere with:
//   node "D:\Claude Apps\iptv\my-playlist\build.ts"
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

const API = 'https://iptv-org.github.io/api'
const OUTPUT = join(import.meta.dirname, 'playlist.m3u')
const STREAMS_DIR = join(import.meta.dirname, '..', 'streams')
const TIMEOUT = 20000
const CONCURRENCY = 75
const PER_CHANNEL = 2 // best stream plus one backup

const FOLDERS = [
  'Indian',
  'English',
  'Sports',
  'Travel & Fashion',
  'Science',
  '4K',
  'Movies',
  'TV Series',
  'Music'
]
const EXCLUDED_CATEGORIES = ['religious', 'shop', 'xxx']
const FASHION = /\b(fashion|ftv)\b/i
const SCIENCE =
  /\b(discovery|nat ?geo|national geographic|animal planet|bbc earth|history|smithsonian|love nature)\b/i
const UHD = /\b(4k|uhd|2160p)\b/i

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

// Follows master playlist -> media playlist -> first segment, so a stale manifest fails
async function isPlayable(stream: Stream): Promise<boolean> {
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
  if (has('travel', 'outdoor') || FASHION.test(title)) return 'Travel & Fashion'
  if (has('science', 'documentary', 'education') || SCIENCE.test(title)) return 'Science'
  if (has('movies', 'classic')) return 'Movies'
  if (has('series')) return 'TV Series'
  if (has('music')) return 'Music'

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

function toEntry(stream: Stream, folder: string, isBackup: boolean): string {
  const title = isBackup ? `${stream.title} - Backup` : stream.title
  const extinf = `#EXTINF:-1 tvg-id="${stream.id}" group-title="${folder}",${title}`
  const opts = stream.opts.map(opt => `#EXTVLCOPT:${opt}`)

  return [extinf, ...opts, stream.url].join('\n')
}

async function main() {
  const [channels, feeds] = await Promise.all([
    fetchJson<Channel[]>('channels'),
    fetchJson<Feed[]>('feeds')
  ])
  const channelsById = new Map(channels.map(channel => [channel.id, channel]))
  const feedsById = new Map(feeds.map(feed => [`${feed.channel}@${feed.id}`, feed]))
  const mainFeeds = new Map(feeds.filter(feed => feed.is_main).map(feed => [feed.channel, feed]))

  const files = readdirSync(STREAMS_DIR).filter(file => file.endsWith('.m3u'))
  const groups = new Map<string, { folder: string; streams: Stream[] }>()
  const add = (key: string, folder: string, stream: Stream) => {
    const group = groups.get(key) ?? { folder, streams: [] }
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

    const feed = feedsById.get(stream.id) ?? mainFeeds.get(channelId)
    if (channel.country !== 'IN' && !feed?.languages.includes('eng')) {
      skippedLanguage++
      continue
    }

    add(channelId, getFolder(channel.categories, stream.title, channel.country), stream)
    if (UHD.test(stream.title)) add(`4k:${channelId}`, '4K', stream)
  }

  const candidates = [...groups.values()]
  const total = candidates.reduce((sum, group) => sum + group.streams.length, 0)
  console.log(`${candidates.length} channels, ${total} streams to test`)

  const entries = new Map<string, { title: string; text: string }[]>()
  for (const folder of FOLDERS) entries.set(folder, [])

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
        title: stream.title.toLowerCase() + (found ? ' ~backup' : ''),
        text: toEntry(stream, group.folder, found > 0)
      })
      found++
    }
  })

  const body = FOLDERS.flatMap(folder =>
    (entries.get(folder) ?? [])
      .sort((a, b) => a.title.localeCompare(b.title))
      .map(entry => entry.text)
  )
  writeFileSync(`${OUTPUT}.tmp`, ['#EXTM3U', ...body, ''].join('\n'))
  renameSync(`${OUTPUT}.tmp`, OUTPUT)

  for (const folder of FOLDERS) console.log(`${folder}: ${entries.get(folder)?.length}`)
  console.log(`Skipped outside India/English scope: ${skippedLanguage}`)
  console.log(`Tested ${tested}, kept ${passed}. Wrote ${OUTPUT}`)
}

main()
