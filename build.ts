// Builds my-playlist/playlist.m3u from ../streams. Run from anywhere with:
//   node "D:\Claude Apps\iptv\my-playlist\build.ts" [older-playlist.m3u ...]
//   node "D:\Claude Apps\iptv\my-playlist\build.ts" --probe-only
// Channels already in playlist.m3u are kept and never retested to decide whether they stay,
// because a stream that fails at one time of day often works at another. Only channels new to the
// playlist are tested before being added. Older playlists passed as arguments are merged in too.
// --probe-only (scheduled 3 times a day) tests every URL in the playlist and records the results
// in probe-history.json. History only picks which stream is the main row and feeds dead-report.txt.
// Backup rows live in the Backups folder; each channel keeps its main row in its own folder.
import { readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  BACKUPS,
  KERALA_VISION,
  UHD_FOLDER,
  format,
  groupKey,
  key,
  parseFile,
  resolution,
  sortKey,
  titleOf,
  type Entry
} from './entry.ts'
import { type Run, appendHistory, beats, isDead, loadHistory, withoutDnsOutages } from './history.ts'
import { createProber } from './probe.ts'

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
const HISTORY_FILE = join(import.meta.dirname, 'probe-history.json')
const DEAD_REPORT = join(import.meta.dirname, 'dead-report.txt')
const STREAMS_DIR = join(import.meta.dirname, '..', 'streams')
const PER_CHANNEL = 2 // best stream plus one backup

const FOLDERS = [
  KERALA_VISION,
  'Indian',
  'English',
  'News',
  'Sports',
  'Travel & Lifestyle',
  'Fashion',
  'Science',
  UHD_FOLDER,
  'Movies',
  'TV Series',
  'Music',
  BACKUPS
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

// Every probe result of this run, written to the history at the end
const prober = createProber()
const runs = new Map<string, Run>()
async function test(stream: { url: string; opts: string[] }): Promise<boolean> {
  const result = await prober.probe(stream)
  if (!runs.has(stream.url)) {
    runs.set(stream.url, { t: new Date().toISOString(), ...result })
    if (runs.size % 500 === 0) console.log(`tested ${runs.size}`)
  }

  return result.ok
}

function parsePlaylist(file: string): Stream[] {
  const streams: Stream[] = []
  const isIndianFile = /^in(_|\.)/.test(file)
  let entry: { id: string; title: string; opts: string[] } | null = null

  for (const raw of readFileSync(join(STREAMS_DIR, file), 'utf8').split('\n')) {
    const line = raw.trim()
    if (line.startsWith('#EXTINF')) {
      entry = { id: line.match(/tvg-id="([^"]*)"/)?.[1] ?? '', title: titleOf(line), opts: [] }
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

function rank(a: Stream, b: Stream): number {
  const score = (stream: Stream) => [
    Number(stream.title.includes('Not 24/7')),
    -resolution(stream.title),
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
  if (has('news')) return 'News'

  return country === 'IN' ? 'Indian' : 'English'
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

// The first file listing a channel wins, so the current playlist beats older ones
function loadExisting(files: string[]): Entry[] {
  const entries: Entry[] = []
  const seen = new Set<string>()
  for (const file of files) {
    let text: string
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    const fromFile = parseFile(text).filter(entry => !seen.has(key(entry)))
    for (const entry of fromFile) seen.add(key(entry))
    entries.push(...fromFile)
  }

  return entries
}

// One main row per channel in each folder; every other row of the channel goes to Backups.
// A backup that beats the main row (more reliable, or higher resolution) swaps places with it.
// Rows only move: none is added or dropped here
function placeBackups(entries: Entry[], keralaVision: Map<string, number>): string[] {
  const history = withoutDnsOutages(loadHistory(HISTORY_FILE))
  const log: string[] = []
  const groups = new Map<string, Entry[]>()
  for (const entry of entries) groups.set(key(entry), [...(groups.get(key(entry)) ?? []), entry])

  const promote = (entry: Entry) => {
    entry.isBackup = false
    entry.folder = entry.home
    if (entry.home === KERALA_VISION) entry.number = keralaVision.get(entry.id.split('@')[0]) ?? entry.number
  }
  const demote = (entry: Entry) => {
    entry.isBackup = true
    entry.folder = BACKUPS
    delete entry.number
  }

  for (const rows of groups.values()) {
    for (const row of rows) if (row.isBackup) demote(row)
    const current = rows.find(row => !row.isBackup)
    const backups = rows.filter(row => row.isBackup)
    if (!current) {
      // a channel whose only rows were backups: its best one becomes the main row
      const best = backups.reduce((a, b) => (beats(b, a, history) ? b : a))
      promote(best)
      log.push(`${best.title} [${best.home}]: only backups, one promoted`)
      continue
    }
    let best = current
    let why: string | null = null
    for (const backup of backups) {
      const reason = beats(backup, best, history)
      if (reason) [best, why] = [backup, reason]
    }
    if (best === current) continue
    promote(best)
    demote(current)
    log.push(`${best.title} [${best.home}]: backup promoted (${why})`)
  }

  return log
}

function writeDeadReport(entries: Entry[]) {
  const history = withoutDnsOutages(loadHistory(HISTORY_FILE))
  const lines = entries
    .filter(entry => isDead(history[entry.url]))
    .map(entry => {
      const results = history[entry.url]
      const title = entry.isBackup ? `${entry.title} - Backup` : entry.title
      return `${entry.folder}\t${title}\t${results.length} tests, last: ${results.at(-1)?.reason}\t${entry.url}`
    })
  const header = '# Failed every test, at least 6 tests over at least 7 days. Report only: nothing is removed.'
  writeFileSync(DEAD_REPORT, [header, ...lines, ''].join('\n'))
  console.log(`Dead report: ${lines.length} rows -> ${DEAD_REPORT}`)
}

async function probeOnly() {
  const entries = parseFile(readFileSync(OUTPUT, 'utf8'))
  const unique = [...new Map(entries.map(entry => [entry.url, entry])).values()]
  console.log(`${new Date().toISOString()} probing ${unique.length} URLs`)
  const results = await Promise.all(unique.map(test))
  appendHistory(HISTORY_FILE, [...runs])
  console.log(`${results.filter(Boolean).length} of ${unique.length} passed. History: ${HISTORY_FILE}`)
  writeDeadReport(entries)
}

async function build(olderPlaylists: string[]) {
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
  const add = (folder: string, stream: Stream, number?: number) => {
    const groupId = groupKey(folder, stream.id, stream.title)
    const group = groups.get(groupId) ?? { folder, number, streams: [] }
    if (!group.streams.some(item => item.url === stream.url)) group.streams.push(stream)
    groups.set(groupId, group)
  }

  let skippedLanguage = 0
  for (const stream of files.flatMap(parsePlaylist)) {
    const [channelId] = stream.id.split('@')
    const channel = channelsById.get(channelId)

    if (!channel) {
      // no metadata to classify by, so only the Indian files can be trusted for scope.
      // Grouped by the id the row is written with (by name when it has none), so the key read
      // back from the playlist matches and the channel is not retested on the next build
      if (!stream.isIndianFile) {
        skippedLanguage++
        continue
      }
      add('Indian', stream)
      if (UHD.test(stream.title)) add(UHD_FOLDER, stream)
      continue
    }

    if (channel.is_nsfw || channel.closed) continue
    if (channel.categories.some(name => EXCLUDED_CATEGORIES.includes(name))) continue

    // on the cable lineup, so wanted whatever the language
    const number = keralaVision.get(channelId)
    if (number) add(KERALA_VISION, stream, number)

    const feed = feedsById.get(stream.id) ?? mainFeeds.get(channelId)
    const isFashion = FASHION_CHANNELS.includes(channelId)
    if (!isFashion && channel.country !== 'IN' && !feed?.languages.includes('eng')) {
      skippedLanguage++
      continue
    }

    const folder = isFashion ? 'Fashion' : getFolder(channel.categories, stream.title, channel.country)
    add(folder, stream)
    if (UHD.test(stream.title)) add(UHD_FOLDER, stream)
  }

  const existing = loadExisting([OUTPUT, ...olderPlaylists])
  // Kept channels that only landed in Indian/English for want of a News folder move into it
  // without a retest
  let movedToNews = 0
  for (const entry of existing) {
    if (entry.home !== 'Indian' && entry.home !== 'English') continue
    const channel = channelsById.get(entry.id.split('@')[0])
    if (!channel?.categories.includes('news')) continue
    if (getFolder(channel.categories, entry.title, channel.country) !== 'News') continue
    if (entry.folder === entry.home) entry.folder = 'News'
    entry.home = 'News'
    movedToNews++
  }
  if (movedToNews) console.log(`Moved ${movedToNews} kept entries into News`)
  const known = new Set(existing.map(key))
  console.log(`Kept ${known.size} channels (${existing.length} entries) without retesting`)

  const candidates = [...groups].filter(([groupId]) => !known.has(groupId)).map(([, group]) => group)
  const total = candidates.reduce((sum, group) => sum + group.streams.length, 0)
  console.log(`${candidates.length} new channels, ${total} streams to test`)

  const added: Entry[] = []
  await Promise.all(
    candidates.map(async group => {
      let found = 0
      for (const stream of group.streams.sort(rank)) {
        if (found === PER_CHANNEL) break
        if (!(await test(stream))) continue
        added.push({
          id: stream.id,
          folder: group.folder,
          home: group.folder,
          title: stream.title,
          isBackup: found > 0,
          number: group.number,
          logo: logos.get(stream.id) ?? logos.get(stream.id.split('@')[0]),
          opts: stream.opts,
          url: stream.url
        })
        found++
      }
    })
  )

  const all = [...existing, ...added]
  const swaps = placeBackups(all, keralaVision)
  for (const line of swaps) console.log(line)

  const byFolder = new Map<string, Entry[]>(FOLDERS.map(folder => [folder, []]))
  for (const entry of all) byFolder.set(entry.folder, [...(byFolder.get(entry.folder) ?? []), entry])
  const body = [...byFolder.values()].flatMap(list =>
    list.sort((a, b) => sortKey(a).localeCompare(sortKey(b))).map(format)
  )
  writeFileSync(`${OUTPUT}.tmp`, ['#EXTM3U', ...body, ''].join('\n'))
  renameSync(`${OUTPUT}.tmp`, OUTPUT)
  appendHistory(HISTORY_FILE, [...runs])

  for (const folder of FOLDERS) console.log(`${folder}: ${byFolder.get(folder)?.length}`)
  console.log(`Skipped outside India/English scope: ${skippedLanguage}`)
  console.log(`Tested ${runs.size}, added ${added.length}, ${swaps.length} main/backup changes. Wrote ${OUTPUT}`)
  writeDeadReport(all)
}

const args = process.argv.slice(2)
if (args.includes('--probe-only')) await probeOnly()
else await build(args)
