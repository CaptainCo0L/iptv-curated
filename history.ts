// Probe results kept across runs, so one bad hour doesn't decide anything. Results only feed the
// main/backup choice and the dead report: they never remove a row.
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { resolution } from './entry.ts'

export type Run = { t: string; ok: boolean; reason: string }
export type History = Record<string, Run[]>

const KEEP = 30
const MIN_TESTS = 3
const MIN_SLOTS = 2
const DEAD_TESTS = 6
const DEAD_DAYS = 7
const DAY = 24 * 60 * 60 * 1000
// a backup has to pass this much more often (as a share of its tests) to win on reliability alone
const MARGIN = 0.2
// results more than this far apart belong to different runs
const RUN_GAP = 10 * 60 * 1000
// a normal run has ~0.1% ENOTFOUND; DNS outages on this PC measured 5.8-23% (2026-11-15..17)
const OUTAGE_SHARE = 0.05

const isDns = (run: Run) => !run.ok && run.reason.includes('ENOTFOUND')

// A run in which this PC's DNS was failing says nothing about the streams: its ENOTFOUND results
// are dropped. Its other results stay, and so does ENOTFOUND from normal runs (a domain that is gone)
export function withoutDnsOutages(history: History): History {
  const all = Object.values(history).flat().sort((a, b) => a.t.localeCompare(b.t))
  const outages: [number, number][] = []
  let start = 0
  for (let i = 1; i <= all.length; i++) {
    if (i < all.length && Date.parse(all[i].t) - Date.parse(all[i - 1].t) <= RUN_GAP) continue
    const run = all.slice(start, i)
    if (run.filter(isDns).length / run.length > OUTAGE_SHARE) outages.push([Date.parse(run[0].t), Date.parse(run.at(-1)!.t)])
    start = i
  }
  const inOutage = (t: string) => outages.some(([from, to]) => Date.parse(t) >= from && Date.parse(t) <= to)

  return Object.fromEntries(
    Object.entries(history).map(([url, runs]) => [url, runs.filter(run => !(isDns(run) && inOutage(run.t)))])
  )
}

export function loadHistory(file: string): History {
  if (!existsSync(file)) return {}

  return JSON.parse(readFileSync(file, 'utf8')) as History
}

// Reads the file again just before writing, so a run that overlapped this one keeps its results
export function appendHistory(file: string, runs: [string, Run][]) {
  const history = loadHistory(file)
  for (const [url, run] of runs) history[url] = [...(history[url] ?? []), run].slice(-KEEP)
  writeFileSync(`${file}.tmp`, JSON.stringify(history))
  renameSync(`${file}.tmp`, file)
}

// The scheduled runs are 08:00, 18:00 and 01:00 local time, one in each slot
export function slot(t: string): 'morning' | 'evening' | 'night' {
  const hour = new Date(t).getHours()
  if (hour >= 6 && hour < 14) return 'morning'
  if (hour >= 14 && hour < 22) return 'evening'

  return 'night'
}

export function summarize(runs: Run[] = []) {
  return {
    tests: runs.length,
    passes: runs.filter(run => run.ok).length,
    slots: new Set(runs.map(run => slot(run.t))).size
  }
}

type Row = { url: string; title: string }

// Why `candidate` should replace `current` as the main row, or null to keep current.
// With enough history for both, a stream that worked at least 20% more often wins; closer than that,
// resolution decides, so one bad test can't swap a 1080p main for a 576p backup.
// Otherwise the build's own ranking applies: a 24/7 stream beats a "Not 24/7" one, then only a
// higher title resolution wins, and a missing resolution never beats a known one
export function beats(candidate: Row, current: Row, history: History): string | null {
  const a = summarize(history[candidate.url])
  const b = summarize(history[current.url])
  const enough = (s: typeof a) => s.tests >= MIN_TESTS && s.slots >= MIN_SLOTS
  const hasHistory = enough(a) && enough(b)
  if (hasHistory) {
    const [rateA, rateB] = [a.passes / a.tests, b.passes / b.tests]
    // the epsilon keeps 5/5 vs 4/5 (exactly 0.2) from failing on float rounding
    if (rateA - rateB >= MARGIN - 1e-9) return `${a.passes}/${a.tests} vs ${b.passes}/${b.tests}`
    if (rateB - rateA >= MARGIN - 1e-9) return null
  } else {
    const [partA, partB] = [candidate.title.includes('Not 24/7'), current.title.includes('Not 24/7')]
    if (partA !== partB) return partB ? '24/7 vs Not 24/7' : null
  }
  const [resA, resB] = [resolution(candidate.title), resolution(current.title)]
  if (resA && resB && resA > resB) return `${resA}p vs ${resB}p`

  return null
}

// Failed every test, at least 6 of them, over at least 7 days
export function isDead(runs: Run[] = []): boolean {
  if (runs.length < DEAD_TESTS || runs.some(run => run.ok)) return false
  const times = runs.map(run => new Date(run.t).getTime())

  return Math.max(...times) - Math.min(...times) >= DEAD_DAYS * DAY
}
