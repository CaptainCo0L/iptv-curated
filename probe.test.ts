import assert from 'node:assert/strict'
import { test } from 'node:test'
import { beats, isDead, withoutDnsOutages, type History } from './history.ts'
import { type FetchFn, createProber } from './probe.ts'

type Reply = { status?: number; body?: string; type?: string } | 'timeout' | 'reset'

// Scripted fetch: each URL answers with its list of replies in turn, the last one repeating
function fakeFetch(script: Record<string, Reply[]>) {
  const calls: string[] = []
  let active = 0
  let peak = 0
  const fetchFn: FetchFn = async url => {
    calls.push(url)
    active++
    peak = Math.max(peak, active)
    await new Promise(resolve => setTimeout(resolve, 5))
    active--
    const replies = script[url] ?? [{ status: 404 }]
    const reply = replies.length > 1 ? replies.shift()! : replies[0]
    if (reply === 'timeout') throw Object.assign(new Error('timed out'), { name: 'TimeoutError' })
    if (reply === 'reset') throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } })

    return new Response(reply.body ?? 'x', {
      status: reply.status ?? 200,
      headers: { 'content-type': reply.type ?? 'video/mp2t' }
    })
  }

  return { fetchFn, calls, peak: () => peak }
}

const MASTER = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nmedia.m3u8\n'
const MEDIA = '#EXTM3U\n#EXTINF:6,\nseg1.ts\n'
const stream = (url: string) => ({ url, opts: [] })

test('a working HLS stream passes through master, media and first segment', async () => {
  const { fetchFn } = fakeFetch({
    'https://a.test/master.m3u8': [{ body: MASTER }],
    'https://a.test/media.m3u8': [{ body: MEDIA }],
    'https://a.test/seg1.ts': [{ body: 'segment' }]
  })
  assert.deepEqual(await createProber({ fetchFn }).probe(stream('https://a.test/master.m3u8')), { ok: true, reason: 'ok' })
})

test('each failure reports why', async () => {
  const cases: [Record<string, Reply[]>, string][] = [
    [{ 'https://b.test/x': [{ status: 403 }] }, 'HTTP 403'],
    [{ 'https://b.test/x': [{ body: '#EXTM3U\n#EXT-X-ENDLIST\n' }] }, 'no segment'],
    [{ 'https://b.test/x': [{ body: '#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="k"\n#EXTINF:6,\ns.ts\n' }] }, 'SAMPLE-AES'],
    [{ 'https://b.test/x': [{ body: '#EXTM3U\n#EXTINF:6,\ns.ts\n' }], 'https://b.test/s.ts': [{ body: '<html>', type: 'text/html' }] }, 'html segment'],
    [{ 'https://b.test/x': [{ body: '<MPD><ContentProtection/></MPD>', type: 'application/dash+xml' }] }, 'DRM'],
    [{ 'https://b.test/x': ['timeout'] }, 'timeout'],
    [{ 'https://b.test/x': ['reset'] }, 'network ECONNRESET']
  ]
  for (const [script, reason] of cases) {
    const { fetchFn } = fakeFetch(script)
    assert.deepEqual(await createProber({ fetchFn }).probe(stream('https://b.test/x')), { ok: false, reason })
  }
})

test('a timeout is retried once, an HTTP error is not', async () => {
  const flaky = fakeFetch({ 'https://c.test/x': ['timeout', { body: 'data' }] })
  assert.equal((await createProber({ fetchFn: flaky.fetchFn }).probe(stream('https://c.test/x'))).ok, true)
  assert.equal(flaky.calls.length, 2)

  const denied = fakeFetch({ 'https://c.test/y': [{ status: 500 }] })
  await createProber({ fetchFn: denied.fetchFn }).probe(stream('https://c.test/y'))
  assert.equal(denied.calls.length, 1)
})

test('at most 4 requests at a time go to one host', async () => {
  const script: Record<string, Reply[]> = {}
  for (let i = 0; i < 20; i++) script[`https://jmp2.test/${i}`] = [{ body: 'data' }]
  const fake = fakeFetch(script)
  const prober = createProber({ fetchFn: fake.fetchFn })
  await Promise.all(Object.keys(script).map(url => prober.probe(stream(url))))
  assert.equal(fake.peak(), 4)
})

test('a URL is tested once per run', async () => {
  const fake = fakeFetch({ 'https://d.test/x': [{ body: 'data' }] })
  const prober = createProber({ fetchFn: fake.fetchFn })
  await Promise.all([prober.probe(stream('https://d.test/x')), prober.probe(stream('https://d.test/x'))])
  assert.equal(fake.calls.length, 1)
})

// local times: 08:00 morning, 18:00 evening, 01:00 night
const at = (day: number, hour: number) => new Date(2026, 10, day, hour).toISOString()
const runs = (results: boolean[]) =>
  results.map((ok, i) => ({ t: at(1 + Math.floor(i / 3), [8, 18, 1][i % 3]), ok, reason: ok ? 'ok' : 'timeout' }))

test('with enough history the more reliable stream wins, whatever its resolution', () => {
  const history: History = { main: runs([true, false, false]), backup: runs([true, true, true]) }
  const main = { url: 'main', title: 'X (1080p)' }
  const backup = { url: 'backup', title: 'X (720p)' }
  assert.equal(beats(backup, main, history), '3/3 vs 1/3')
  assert.equal(beats(main, backup, history), null)
})

test('without enough history only a higher known resolution wins', () => {
  const history: History = { main: runs([true]), backup: runs([true]) }
  assert.equal(beats({ url: 'backup', title: 'X (1080p)' }, { url: 'main', title: 'X (720p)' }, history), '1080p vs 720p')
  assert.equal(beats({ url: 'backup', title: 'X (1080p)' }, { url: 'main', title: 'X' }, history), null)
  assert.equal(beats({ url: 'backup', title: 'X' }, { url: 'main', title: 'X (720p)' }, history), null)
})

test('without enough history a 24/7 stream beats a Not 24/7 one, whatever the resolution', () => {
  const part = { url: 'backup', title: 'X (1080p) [Not 24/7]' }
  const full = { url: 'main', title: 'X (576p)' }
  assert.equal(beats(part, full, {}), null)
  assert.equal(beats(full, part, {}), '24/7 vs Not 24/7')
})

test('with enough history reliability decides, not the Not 24/7 tag', () => {
  const history: History = { main: runs([true, false, false]), backup: runs([true, true, true]) }
  assert.equal(beats({ url: 'backup', title: 'X [Not 24/7]' }, { url: 'main', title: 'X' }, history), '3/3 vs 1/3')
})

test('three results from one time of day are not enough history', () => {
  const sameHour = (ok: boolean) => [1, 2, 3].map(day => ({ t: at(day, 8), ok, reason: '' }))
  const history: History = { main: sameHour(false), backup: sameHour(true) }
  assert.equal(beats({ url: 'backup', title: 'X (720p)' }, { url: 'main', title: 'X (1080p)' }, history), null)
})

test('dead means at least 6 failed tests over at least 7 days, and no pass', () => {
  const spread = (days: number[], ok = false) => days.map(day => ({ t: at(day, 8), ok, reason: 'HTTP 404' }))
  assert.equal(isDead(spread([1, 2, 3, 4, 5, 8])), true)
  assert.equal(isDead(spread([1, 2, 3, 4, 5, 6])), false)
  assert.equal(isDead(spread([1, 2, 3, 4, 8])), false)
  assert.equal(isDead([...spread([1, 2, 3, 4, 5, 8]), ...spread([9], true)]), false)
})

test('a backup must work at least 20% more often to win on reliability', () => {
  const nine = (fails: number) => runs(Array.from({ length: 9 }, (_, i) => i >= fails))
  const history: History = { main: nine(1), backup: nine(0), weak: nine(2) }
  // 9/9 vs 8/9: too close, so resolution decides and the 1080p main stays
  assert.equal(beats({ url: 'backup', title: 'X (576p)' }, { url: 'main', title: 'X (1080p)' }, history), null)
  // too close and same resolution: the main stays
  assert.equal(beats({ url: 'backup', title: 'X (720p)' }, { url: 'main', title: 'X (720p)' }, history), null)
  // too close, so the higher resolution wins even though it failed once more
  assert.equal(beats({ url: 'main', title: 'X (1080p)' }, { url: 'backup', title: 'X (576p)' }, history), '1080p vs 576p')
  // 9/9 vs 7/9 is a big enough gap
  assert.equal(beats({ url: 'backup', title: 'X (576p)' }, { url: 'weak', title: 'X (1080p)' }, history), '9/9 vs 7/9')
})

test('ENOTFOUND results from a run where DNS was failing are dropped', () => {
  // run 1: 1 of 30 URLs got ENOTFOUND (normal), run 2: all 30 did (DNS outage)
  const history: History = {}
  for (let i = 0; i < 30; i++) {
    const first = i === 0
      ? { t: at(1, 8), ok: false, reason: 'network ENOTFOUND' }
      : { t: at(1, 8), ok: true, reason: 'ok' }
    history[`u${i}`] = [first, { t: at(1, 18), ok: false, reason: 'network ENOTFOUND' }]
  }
  history.u1.push({ t: at(1, 18), ok: false, reason: 'HTTP 404' })
  const clean = withoutDnsOutages(history)
  // the normal run's ENOTFOUND counts as a real failure
  assert.deepEqual(clean.u0, [history.u0[0]])
  // the outage's ENOTFOUND is dropped, its other failures stay
  assert.deepEqual(clean.u1, [history.u1[0], history.u1[2]])
  // the input is not changed
  assert.equal(history.u1.length, 3)
})
