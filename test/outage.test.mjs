// Studio outages against the built package: what a site gets to show when the
// studio is down, hangs, or answers with something unexpected. Runs on `dist`,
// so the published entry points are what is tested. `npm test` builds first.
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, beforeEach, describe, test } from 'node:test'
import { createClient } from '@justmade/client'
import { FileCacheStore } from '@justmade/client/file-store'

/**
 * A fake studio. `mode` decides how it answers:
 * up, 503, 429, refuse (socket destroyed), hang (never answers),
 * stall (headers sent, body never finishes). `listMode`, when set, overrides it
 * for everything but the stamp check, so the stamp can move while reads fail.
 */
const studio = { mode: 'up', listMode: undefined, version: 'v1', title: 'one', hits: [] }
let server
let baseUrl

before(async () => {
  server = createServer((req, res) => {
    studio.hits.push(req.url)
    const isVersion = req.url.endsWith('/version')
    const mode = isVersion ? studio.mode : (studio.listMode ?? studio.mode)
    switch (mode) {
      case 'hang': return
      case 'refuse': return req.socket.destroy()
      case '503': res.writeHead(503); return res.end('{}')
      case '429': res.writeHead(429); return res.end('{}')
      case '404': res.writeHead(404); return res.end('{}')
      case 'stall':
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.write('{"records":')
    }
    res.setHeader('content-type', 'application/json')
    if (isVersion) return res.end(JSON.stringify({ version: studio.version }))
    const etag = `"${studio.title}"`
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304)
      return res.end()
    }
    res.setHeader('etag', etag)
    res.end(JSON.stringify({ records: [{ uid: 'a', data: { title: studio.title } }] }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${server.address().port}`
})

after(() => {
  server.closeAllConnections()
  server.close()
})

beforeEach(() => {
  studio.mode = 'up'
  studio.listMode = undefined
  studio.version = 'v1'
  studio.title = 'one'
  studio.hits = []
})

const read = async (client) => (await client.dataset('pages', 'home').list())[0].data.title
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Time a promise, in ms. */
async function timed(promise) {
  const start = Date.now()
  const value = await promise
  return { value, ms: Date.now() - start }
}

describe('timeout', () => {
  test('a hanging studio serves the cache within the stamp budget', async () => {
    const client = createClient({ apiKey: 'k', baseUrl, timeout: 300, cache: { revalidate: 20 } })
    assert.equal(await read(client), 'one')
    studio.mode = 'hang'
    await wait(30)
    const { value, ms } = await timed(read(client))
    assert.equal(value, 'one')
    assert.ok(ms < 1000, `took ${ms}ms`)
  })

  test('a hanging refetch serves the cache, then pauses before trying again', async () => {
    // The pause after a failure is one `revalidate` interval: long enough here
    // that the second read lands well inside it.
    const client = createClient({ apiKey: 'k', baseUrl, timeout: 200, cache: { revalidate: 1_000 } })
    assert.equal(await read(client), 'one')
    // The stamp moves, so the entry must be refetched - and that refetch hangs.
    studio.version = 'v2'
    studio.title = 'two'
    studio.listMode = 'hang'
    await wait(1_050)
    const first = await timed(read(client))
    assert.equal(first.value, 'one')
    assert.ok(first.ms >= 150 && first.ms < 1000, `took ${first.ms}ms`)
    // Paused: the next read does not wait on the studio again.
    const second = await timed(read(client))
    assert.equal(second.value, 'one')
    assert.ok(second.ms < 100, `took ${second.ms}ms`)
  })

  test('a cold read against a hanging studio fails with a TimeoutError', async () => {
    const client = createClient({ apiKey: 'k', baseUrl, timeout: 200 })
    studio.mode = 'hang'
    const start = Date.now()
    await assert.rejects(read(client), { name: 'TimeoutError' })
    assert.ok(Date.now() - start < 1000)
  })

  test('a body that stalls after the headers times out too', async () => {
    const client = createClient({ apiKey: 'k', baseUrl, timeout: 200, cache: false })
    studio.mode = 'stall'
    await assert.rejects(read(client), { name: 'TimeoutError' })
  })

  test('a custom fetch that ignores the signal still times out', async () => {
    const deaf = (url, init) => fetch(url, { ...init, signal: undefined })
    const client = createClient({ apiKey: 'k', baseUrl, timeout: 200, cache: false, fetch: deaf })
    studio.mode = 'hang'
    await assert.rejects(read(client), { name: 'TimeoutError' })
  })

  test('timeout 0 switches it off', async () => {
    const client = createClient({ apiKey: 'k', baseUrl, timeout: 0, cache: false })
    studio.mode = 'hang'
    const outcome = await Promise.race([read(client).then(() => 'answered', () => 'failed'), wait(400).then(() => 'waiting')])
    assert.equal(outcome, 'waiting')
  })
})

describe('transient errors keep the cache', () => {
  for (const mode of ['503', '429', 'refuse']) {
    test(`${mode} while revalidating serves the last good value, also on the next read`, async () => {
      const client = createClient({ apiKey: 'k', baseUrl, cache: { revalidate: 20 } })
      assert.equal(await read(client), 'one')
      studio.version = 'v2'
      studio.title = 'two'
      studio.listMode = mode
      await wait(30)
      assert.equal(await read(client), 'one')
      assert.equal(await read(client), 'one')
    })
  }
})

describe('version route', () => {
  test('a 404 on /version pauses the check instead of ending it', async () => {
    const realNow = Date.now
    let now = realNow()
    Date.now = () => now
    try {
      studio.mode = '404'
      const client = createClient({ apiKey: 'k', baseUrl, cache: { revalidate: 60_000 } })
      studio.listMode = 'up'
      assert.equal(await read(client), 'one')
      const probes = () => studio.hits.filter((u) => u.endsWith('/version')).length
      assert.equal(probes(), 1)

      // Within the pause: no new probe, even well past the revalidate interval.
      now += 5 * 60_000
      await read(client)
      assert.equal(probes(), 1)

      // After it: the route is back, and so is freshness.
      studio.mode = 'up'
      studio.version = 'v2'
      studio.title = 'two'
      now += 11 * 60_000
      assert.equal(await read(client), 'two')
      assert.equal(probes(), 2)
    }
    finally {
      Date.now = realNow
    }
  })
})

describe('FileCacheStore', () => {
  let dir
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'jm-file-store-'))
  })

  test('a restarted process serves from disk while the studio is down', async () => {
    const first = createClient({ apiKey: 'k', baseUrl, cache: { store: new FileCacheStore({ dir }) } })
    assert.equal(await read(first), 'one')

    // "Restart": a new client and store on the same directory, studio gone.
    for (const mode of ['503', 'refuse']) {
      studio.mode = mode
      const second = createClient({ apiKey: 'k', baseUrl, cache: { store: new FileCacheStore({ dir }) } })
      assert.equal(await read(second), 'one')
    }
    rmSync(dir, { recursive: true, force: true })
  })

  test('a restarted process still picks up edits once the studio is back', async () => {
    const first = createClient({ apiKey: 'k', baseUrl, cache: { store: new FileCacheStore({ dir }) } })
    assert.equal(await read(first), 'one')
    studio.version = 'v2'
    studio.title = 'two'
    const second = createClient({ apiKey: 'k', baseUrl, cache: { store: new FileCacheStore({ dir }) } })
    assert.equal(await read(second), 'two')
    rmSync(dir, { recursive: true, force: true })
  })

  test('evicts the oldest entries from memory and disk', () => {
    const store = new FileCacheStore({ dir, maxEntries: 2 })
    for (const key of ['a', 'b', 'c']) store.set(key, { value: key, expiresAt: 0 })
    assert.deepEqual([...store.keys()], ['b', 'c'])
    assert.equal(readdirSync(dir).length, 2)
    assert.deepEqual([...new FileCacheStore({ dir }).keys()].sort(), ['b', 'c'])
    rmSync(dir, { recursive: true, force: true })
  })

  test('delete and clear remove the files', () => {
    const store = new FileCacheStore({ dir })
    store.set('a', { value: 1, expiresAt: 0 })
    store.set('b', { value: 2, expiresAt: 0 })
    store.delete('a')
    assert.equal(readdirSync(dir).length, 1)
    store.clear()
    assert.equal(readdirSync(dir).length, 0)
    assert.equal(new FileCacheStore({ dir }).get('b'), undefined)
    rmSync(dir, { recursive: true, force: true })
  })

  test('skips and removes corrupt, foreign and half-written files', () => {
    const store = new FileCacheStore({ dir })
    store.set('good', { value: 'ok', expiresAt: 0 })
    writeFileSync(join(dir, 'broken.json'), '{"v":1,')
    writeFileSync(join(dir, 'foreign.json'), JSON.stringify({ v: 1, key: 'x', entry: { value: 1, expiresAt: 0 } }))
    writeFileSync(join(dir, 'leftover.json.123.tmp'), 'partial')
    const reloaded = new FileCacheStore({ dir })
    assert.deepEqual([...reloaded.keys()], ['good'])
    assert.equal(readdirSync(dir).length, 1)
    rmSync(dir, { recursive: true, force: true })
  })

  test('an unwritable directory degrades to memory with one warning', () => {
    const errors = []
    const blocker = join(dir, 'file')
    writeFileSync(blocker, '')
    const store = new FileCacheStore({ dir: join(blocker, 'sub'), onError: (err) => errors.push(err) })
    store.set('a', { value: 1, expiresAt: 0 })
    assert.equal(store.get('a').value, 1)
    assert.ok(errors.length > 0)
    rmSync(dir, { recursive: true, force: true })
  })
})
