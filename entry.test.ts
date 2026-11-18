import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { BACKUPS, type Entry, format, key, parse, parseFile, sortKey } from './entry.ts'

const base: Entry = {
  id: 'AsianetNews.in@SD',
  folder: 'News',
  home: 'News',
  title: 'Asianet News (720p)',
  isBackup: false,
  logo: 'https://example.com/logo.png',
  opts: [],
  url: 'https://example.com/live.m3u8'
}

const fixtures: Record<string, Entry> = {
  main: base,
  backup: { ...base, folder: BACKUPS, isBackup: true },
  'kerala vision main with number': { ...base, folder: 'Kerala Vision', home: 'Kerala Vision', number: 42 },
  'header options': { ...base, opts: ['http-referrer=https://a.example/', 'http-user-agent=Mozilla/5.0, like Gecko'] },
  'comma and quotes in title': { ...base, title: 'Tom, Dick & "Harry" TV (1080p)' },
  'no logo, no id': { ...base, id: '', logo: undefined }
}

for (const [name, entry] of Object.entries(fixtures)) {
  test(`round trip: ${name}`, () => {
    const expected = { ...entry }
    if (!expected.logo) delete expected.logo
    assert.deepEqual(parse(format(entry)), expected)
  })
}

test('a backup keeps its key when it moves to Backups', () => {
  const kv = { ...base, folder: 'Kerala Vision', home: 'Kerala Vision' }
  const moved = parse(format({ ...kv, folder: BACKUPS, isBackup: true }))
  assert.equal(moved.home, 'Kerala Vision')
  assert.equal(key(moved), key(kv))
  assert.equal(key(kv), 'kv:AsianetNews.in')
})

test('Backups rows carry no channel number', () => {
  const text = format({ ...base, folder: BACKUPS, home: 'Kerala Vision', isBackup: true, number: 42 })
  assert.ok(!text.includes('tvg-chno'))
  assert.ok(text.includes('x-home="Kerala Vision" group-title="Backups"'))
})

test('rows without an id are keyed by name', () => {
  assert.equal(key({ ...base, id: '', title: 'Kairali TV (576p)', home: 'Indian' }), 'untagged:kairali tv')
  assert.equal(key({ ...base, id: '', title: 'Kairali TV (576p)', home: '4K' }), '4k:untagged:kairali tv')
})

test('Backups sort by title, folders sort by number then title', () => {
  assert.equal(sortKey({ ...base, folder: BACKUPS, isBackup: true }), 'asianet news (720p)')
  assert.equal(sortKey({ ...base, folder: 'Kerala Vision', number: 7 }), '0007')
})

test('every row of the real playlist round-trips to identical text', { skip: !existsSync(join(import.meta.dirname, 'playlist.m3u')) }, () => {
  const text = readFileSync(join(import.meta.dirname, 'playlist.m3u'), 'utf8')
  const blocks = text.split(/\n(?=#EXTINF)/).slice(1).map(block => block.trimEnd())
  const entries = parseFile(text)
  assert.equal(entries.length, blocks.length)
  entries.forEach((entry, index) => assert.equal(format(entry), blocks[index]))
})
