// One playlist row (#EXTINF line, #EXTVLCOPT lines, URL): written, read back and keyed here only.
// The never-remove rule depends on key() matching what the build used when it added the row, so a
// kept channel is recognised and never retested.

export const BACKUPS = 'Backups'
export const KERALA_VISION = 'Kerala Vision'
export const UHD_FOLDER = '4K'

export type Entry = {
  id: string
  // folder the row is shown in
  folder: string
  // folder the row belongs to; differs from folder only for rows in Backups
  home: string
  // without the " - Backup" suffix
  title: string
  isBackup: boolean
  // Kerala Vision cable number. Not written on Backups rows, so two rows never share a number
  number?: number
  logo?: string
  // #EXTVLCOPT values, without the prefix
  opts: string[]
  url: string
}

const BACKUP_SUFFIX = ' - Backup'
// the title is everything after the first comma that is not inside a quoted attribute
const TITLE = /^#EXTINF:[^,"]*(?:"[^"]*"[^,"]*)*,(.*)$/

export function titleOf(extinf: string): string {
  return extinf.match(TITLE)?.[1]?.trim() ?? ''
}

// The channel name a row is grouped by when it has no tvg-id: "Asianet (720p)" -> "asianet"
export function baseName(title: string): string {
  return title.replace(/[([].*$/, '').trim().toLowerCase()
}

export function resolution(title: string): number {
  return Number(title.match(/\((\d+)[pi]\)/)?.[1] ?? 0)
}

function attr(extinf: string, name: string): string | undefined {
  return extinf.match(new RegExp(`${name}="([^"]*)"`))?.[1]
}

// block: the #EXTINF line, any #EXTVLCOPT lines, then the URL line
export function parse(block: string): Entry {
  const lines = block.split('\n').map(line => line.trimEnd())
  const extinf = lines[0]
  const fullTitle = titleOf(extinf)
  const isBackup = fullTitle.endsWith(BACKUP_SUFFIX)
  const folder = attr(extinf, 'group-title') ?? ''
  const number = Number(attr(extinf, 'tvg-chno') ?? 0)
  const entry: Entry = {
    id: attr(extinf, 'tvg-id') ?? '',
    folder,
    home: attr(extinf, 'x-home') ?? folder,
    title: isBackup ? fullTitle.slice(0, -BACKUP_SUFFIX.length) : fullTitle,
    isBackup,
    opts: lines
      .filter(line => line.startsWith('#EXTVLCOPT:'))
      .map(line => line.slice(line.lastIndexOf('#EXTVLCOPT:') + '#EXTVLCOPT:'.length)),
    url: lines[lines.length - 1]
  }
  if (number) entry.number = number
  const logo = attr(extinf, 'tvg-logo')
  if (logo) entry.logo = logo

  return entry
}

export function format(entry: Entry): string {
  const inBackups = entry.folder === BACKUPS
  const title = entry.isBackup ? `${entry.title}${BACKUP_SUFFIX}` : entry.title
  const number = entry.number && !inBackups ? ` tvg-chno="${entry.number}"` : ''
  const logo = entry.logo ? ` tvg-logo="${entry.logo}"` : ''
  const home = entry.home !== entry.folder ? ` x-home="${entry.home}"` : ''
  const extinf = `#EXTINF:-1 tvg-id="${entry.id}"${number}${logo}${home} group-title="${entry.folder}",${title}`

  return [extinf, ...entry.opts.map(opt => `#EXTVLCOPT:${opt}`), entry.url].join('\n')
}

export function parseFile(text: string): Entry[] {
  const entries: Entry[] = []
  let block: string[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd()
    if (line.startsWith('#EXTINF')) block = [line]
    else if (line.startsWith('#EXTVLCOPT:') && block.length) block.push(line)
    else if (line && !line.startsWith('#') && block.length) {
      entries.push(parse([...block, line].join('\n')))
      block = []
    }
  }

  return entries
}

// The group a row belongs to: one main row plus its backups. Same keys the build uses for its
// stream groups, and taken from home, so a row moved to Backups still counts as kept
export function groupKey(home: string, id: string, title: string): string {
  const [channelId] = id.split('@')
  const base = channelId || `untagged:${baseName(title)}`
  if (home === KERALA_VISION) return `kv:${base}`
  if (home === UHD_FOLDER) return `4k:${base}`

  return base
}

export function key(entry: Entry): string {
  return groupKey(entry.home, entry.id, entry.title)
}

export function sortKey(entry: Entry): string {
  if (entry.folder === BACKUPS) return entry.title.toLowerCase()
  const base = entry.number ? String(entry.number).padStart(4, '0') : entry.title.toLowerCase()

  return base + (entry.isBackup ? ' ~backup' : '')
}
