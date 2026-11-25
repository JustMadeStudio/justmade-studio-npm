// Studio outages against the built package: what a site gets to show when the
// studio is down, hangs, or answers with something unexpected. Runs on `dist`,
// so the published entry points are what is tested. `npm test` builds first.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, afterEach, before, beforeEach, describe, test } from 'node:test'
import { MemoryCacheStore, createClient as createRealClient } from '@justmade/client'
import { FileCacheStore } from '@justmade/client/file-store'

/**
 * A fake studio. `mode` decides how it answers:
 * up, 503, 429, refuse (socket destroyed), hang (never answers),
 * stall (headers sent, body never finishes). `listMode`, when set, overrides it
 * for everything but the stamp check, so the stamp can move while reads fail.
 *
 * Two kinds of 4xx: `gone` is the studio itself answering (its JSON error, which
 * restates the status), the `proxy*` and `gateway*` modes are what stands in
 * front of the studio answering while its container is away. `junk200` is a
 * maintenance page: a 200 with JSON, just not the studio's.
 *
 * `hold` parks an answer until `studio.release()` sends it or `studio.drop()`
 * cuts the connection instead: how a test stages a slow studio, and decides
 * how the wait ends, without betting on the clock. `always304` answers 304
 * whether or not the request was conditional. `delay` makes content answers (not the
 * stamp) take that many ms. Either way the answer is made up when the request
 * arrives, so a late one carries what the studio held at that moment.
 *
 * `writeMode`, when set, is the mode for writes (POST, PATCH) only, and
 * `localesMode` the one for `/locales`. `queryBody` is what `/queries/<slug>`
 * answers with, `locales` what `/locales` lists. A record list asked for in a
 * locale says so in its title (`one@en-US`), so a test sees what was requested.
 */
const LOCALES = [
  { code: 'nl-BE', label: 'Nederlands', isDefault: true, isFallback: false },
  { code: 'en-US', label: 'English', isDefault: false, isFallback: true },
]
const studio = {
  mode: 'up',
  listMode: undefined,
  writeMode: undefined,
  localesMode: undefined,
  version: 'v1',
  title: 'one',
  delay: 0,
  queryBody: undefined,
  locales: LOCALES,
  hits: [],
  held: [],
  /** Sends every answer parked by `hold`. */
  release() {
    for (const parked of studio.held.splice(0)) parked.send()
  },
  /** Cuts the connection of every request parked by `hold`: a network failure. */
  drop() {
    for (const parked of studio.held.splice(0)) parked.drop()
  },
}
let server
/**
 * Each test talks to its own path on the one server (`/t7/api/content/...`),
 * and the server ignores every other path. A request that a client of an
 * earlier test still sends - a background refresh, a retry - can then never be
 * counted in, or answered with the state of, the test that runs now.
 */
let prefix
let baseUrl
let testNo = 0

before(async () => {
  server = createServer((req, res) => {
    if (!req.url.startsWith(`${prefix}/`)) return req.socket.destroy()
    const url = req.url.slice(prefix.length)
    studio.hits.push(url)
    const path = url.split('?')[0]
    const isVersion = path.endsWith('/version')
    const isLocales = path.endsWith('/locales')
    const isWrite = req.method !== 'GET'
    const mode = isVersion
      ? studio.mode
      : ((isWrite ? studio.writeMode : undefined) ?? (isLocales ? studio.localesMode : undefined) ?? studio.listMode ?? studio.mode)
    switch (mode) {
      case 'hang': return
      case 'refuse': return req.socket.destroy()
      case '503': res.writeHead(503); return res.end('{}')
      case '429': res.writeHead(429); return res.end('{}')
      case 'gone':
        res.writeHead(404, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ error: true, statusCode: 404, statusMessage: 'Not Found', message: 'Record not found' }))
      // Traefik, when no router matches because the container is gone.
      case 'proxy404':
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
        return res.end('404 page not found\n')
      // A WAF or CDN error page.
      case 'proxy403':
        res.writeHead(403, { 'content-type': 'text/html' })
        return res.end('<html><body><h1>403 Forbidden</h1></body></html>')
      // An API gateway: JSON, but not the studio's.
      case 'gateway404':
        res.writeHead(404, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ message: 'no Route matched with those values' }))
      case 'junk200':
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end('{"status":"maintenance"}')
      case 'always304':
        res.writeHead(304)
        return res.end()
      case 'stall':
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.write('{"records":')
    }
    res.setHeader('content-type', 'application/json')
    if (isVersion) return res.end(JSON.stringify({ version: studio.version }))
    // Every content answer is made up now and sent by `send`, so that `hold`
    // and `delay` work the same for a record list, the locales and a query.
    let send
    if (isLocales) {
      const body = JSON.stringify({ locales: studio.locales })
      send = () => res.end(body)
    }
    else if (path.includes('/queries/')) {
      const body = JSON.stringify(studio.queryBody)
      send = () => res.end(body)
    }
    else {
      const locale = new URLSearchParams(url.split('?')[1] ?? '').get('locale')
      const title = locale ? `${studio.title}@${locale}` : studio.title
      send = () => {
        const etag = `"${title}"`
        if (req.headers['if-none-match'] === etag) {
          res.writeHead(304)
          return res.end()
        }
        res.setHeader('etag', etag)
        res.end(JSON.stringify({ records: [{ uid: 'a', data: { title } }] }))
      }
    }
    if (mode === 'hold') studio.held.push({ send, drop: () => req.socket.destroy() })
    else if (studio.delay > 0) setTimeout(send, studio.delay)
    else send()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
})

// Without an `onError` the client warns once per outage, and nearly every test
// here stages one. The test of that warning installs its own capture.
const consoleWarn = console.warn
before(() => {
  console.warn = () => {}
})

after(() => {
  console.warn = consoleWarn
  server.closeAllConnections()
  server.close()
})

beforeEach(() => {
  prefix = `/t${++testNo}`
  baseUrl = `http://127.0.0.1:${server.address().port}${prefix}`
  studio.mode = 'up'
  studio.listMode = undefined
  studio.writeMode = undefined
  studio.localesMode = undefined
  studio.version = 'v1'
  studio.title = 'one'
  studio.delay = 0
  studio.queryBody = undefined
  studio.locales = LOCALES
  studio.hits = []
  studio.held = []
})

/** Undoes `fakeClock()`, whether or not the test got to its end. */
let restoreClock
afterEach(() => {
  restoreClock?.()
  restoreClock = undefined
})

/**
 * The client under test, with one default turned round: it waits for the studio
 * (`waitForFresh: false`) unless a test says otherwise.
 *
 * With the real default a read that holds a value gives the studio one second
 * and then serves what it has. Nearly every test here expects the answer the
 * studio gave, so each of them would carry a hidden deadline: answer within a
 * second, or the test sees the cached value instead and fails. On a busy
 * machine that is a coin toss. The tests that are about not waiting set
 * `waitForFresh` themselves, the one about the default passes it as `undefined`.
 */
function createClient(options) {
  const { cache } = options
  if (cache === false) return createRealClient(options)
  const settings = cache === true || cache === undefined ? {} : cache
  return createRealClient({ ...options, cache: 'waitForFresh' in settings ? settings : { ...settings, waitForFresh: false } })
}

const read = async (client, opts) => (await client.dataset('pages', 'home').list(opts))[0].data.title
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
/** Stamp checks the fake studio has seen since the last reset of `hits`. */
const versionProbes = () => studio.hits.filter((u) => u.endsWith('/version')).length
/** Everything else the fake studio has seen: reads and writes of content. */
const contentRequests = () => studio.hits.length - versionProbes()
/** Requests for record lists only, each with the locale it asked for. */
const recordRequests = () => studio.hits.filter((u) => u.includes('/records'))
const quiet = () => {}

// ── Keeping the tests off the clock ───────────────────────────────────────────
//
// The rule in this file: never assert that something took *less* than some
// time. A busy machine only ever makes things later, so a lower bound, or
// "still waiting after x ms", cannot fail by accident - an upper bound can.
// Where the point of a test is that a read does not wait on the studio, the
// studio is made to `hold` its answer: the read can then only come back
// because the client did not wait for it.

/** How long anything here may take before the test fails instead of hanging the run. */
const GUARD_MS = 5_000

/** `promise`, or a failure naming `what` when it has not settled by the guard. */
function soon(promise, what = 'the read') {
  let timer
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} had not settled after ${GUARD_MS}ms`)), GUARD_MS)
  })
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer))
}

/** Waits until `condition()` holds, failing by the guard. */
async function until(condition, what) {
  const start = performance.now()
  while (!(await condition())) {
    if (performance.now() - start > GUARD_MS) throw new Error(`${what}: not within ${GUARD_MS}ms`)
    await wait(5)
  }
}

/** Whether `promise` is still unsettled after `ms`. */
async function pendingAfter(promise, ms) {
  const state = await Promise.race([promise.then(() => 'settled', () => 'settled'), wait(ms).then(() => 'pending')])
  return state === 'pending'
}

/** Time a promise, in ms, on a clock `fakeClock` does not touch. */
async function timed(promise) {
  const start = performance.now()
  const value = await promise
  return { value, ms: performance.now() - start }
}

/**
 * Collects promise rejections nobody handled, for as long as the returned
 * `stop` is not called. One of those ends a Node process, so a client that
 * keeps a site up must never leave one behind - also not from a hook it was
 * handed. `settle()` gives pending ones the turn they need to surface.
 *
 * `take()` hands over, and forgets, the ones the running test can have caused.
 * A rejection that names the path of another test (`/t12/`) is that test's: it
 * failed and left a read behind that ran into its timeout only now. Counting
 * it here would report one failure twice, the second time in the wrong place.
 */
function watchRejections() {
  const seen = []
  const listener = (reason) => seen.push(reason)
  process.on('unhandledRejection', listener)
  return {
    settle: () => wait(20),
    take() {
      const foreign = (reason) => {
        const named = String(reason?.message ?? reason).match(/\/t\d+(?=\/)/)
        return named !== null && named[0] !== prefix
      }
      return seen.splice(0).filter((reason) => !foreign(reason))
    },
    stop: () => process.off('unhandledRejection', listener),
  }
}

/**
 * Takes over `Date.now`, which is all the client reads the time from for its
 * intervals (stamp check, retry pause, TTL). "One interval later" is then an
 * `advance`, not a sleep, and "within the interval" is simply not advancing.
 * Timers (`timeout`, `waitForFresh`) keep running on the real clock.
 */
function fakeClock() {
  const real = Date.now
  let now = real()
  Date.now = () => now
  restoreClock = () => {
    Date.now = real
  }
  return {
    advance(ms) {
      now += ms
    },
  }
}

describe('timeout', () => {
  test('a hanging studio serves the cache within the stamp budget', async () => {
    const client = createClient({ apiKey: 'k', baseUrl, timeout: 300, cache: { revalidate: 20 } })
    assert.equal(await read(client), 'one')
    studio.mode = 'hang'
    await wait(30)
    // It comes back at all: without a timeout this read waits as long as the runtime does.
    assert.equal(await soon(read(client)), 'one')
  })

  test('a hanging refetch serves the cache, then pauses before trying again', async () => {
    const clock = fakeClock()
    const client = createClient({ apiKey: 'k', baseUrl, timeout: 200, cache: { revalidate: 60_000 } })
    assert.equal(await read(client), 'one')
    // The stamp moves, so the entry must be refetched - and that refetch hangs.
    studio.version = 'v2'
    studio.title = 'two'
    studio.listMode = 'hang'
    clock.advance(61_000)
    const first = await timed(soon(read(client)))
    assert.equal(first.value, 'one')
    assert.ok(first.ms >= 150, `took ${first.ms}ms`) // it waited out the timeout
    // Paused for one interval: the next read asks the studio nothing.
    studio.hits = []
    assert.equal(await read(client), 'one')
    assert.equal(studio.hits.length, 0)
    // After the pause it asks again, and the studio is back.
    studio.listMode = undefined
    clock.advance(61_000)
    assert.equal(await read(client), 'two')
  })

  test('a cold read against a hanging studio fails with a TimeoutError', async () => {
    const client = createClient({ apiKey: 'k', baseUrl, timeout: 200 })
    studio.mode = 'hang'
    await assert.rejects(soon(read(client)), { name: 'TimeoutError' })
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

  test('timeout Infinity means no timeout, not one millisecond', async () => {
    // A timer cannot hold Infinity: handed over as it is, it fires after 1 ms.
    const client = createClient({ apiKey: 'k', baseUrl, timeout: Infinity, cache: false })
    assert.equal(await read(client), 'one')
    studio.mode = 'hang'
    const outcome = await Promise.race([read(client).then(() => 'answered', () => 'failed'), wait(400).then(() => 'waiting')])
    assert.equal(outcome, 'waiting')
  })

  test('a write that times out is sent once, never repeated', async () => {
    // It may have reached the studio all the same: a second attempt could store it twice.
    const client = createClient({ apiKey: 'k', baseUrl, timeout: 200 })
    studio.mode = 'hang'
    await assert.rejects(client.createRecord('pages', 'home', { title: 'new' }), { name: 'TimeoutError' })
    await wait(100)
    assert.equal(contentRequests(), 1)
  })
})

describe('a read that holds a value does not wait on the studio', () => {
  /** A client with 'one' cached, facing a studio that has 'two' and holds its answer. */
  async function staleBehindSlowStudio(cache) {
    const client = createClient({ apiKey: 'k', baseUrl, cache: { revalidate: 20, ...cache } })
    assert.equal(await read(client), 'one')
    studio.version = 'v2'
    studio.title = 'two'
    studio.listMode = 'hold'
    await wait(30)
    studio.hits = []
    return client
  }

  test('a slow refresh: the cached value after waitForFresh, the fresh one once it is in', async () => {
    const client = await staleBehindSlowStudio({ waitForFresh: 100 })
    // The studio has not answered, so this can only be the client giving up waiting.
    const held = await timed(soon(read(client)))
    assert.equal(held.value, 'one')
    assert.ok(held.ms >= 80, `took ${held.ms}ms`) // but not before the budget was up
    // The refresh went on in the background, and fills the cache once it lands.
    await until(() => studio.held.length === 1, 'the refresh request')
    studio.release()
    await until(async () => (await read(client)) === 'two', 'the background refresh')
    assert.equal(contentRequests(), 1)
  })

  test('the default budget is one second', async () => {
    const client = await staleBehindSlowStudio({ waitForFresh: undefined }) // the client's own default
    const held = await timed(soon(read(client)))
    assert.equal(held.value, 'one')
    assert.ok(held.ms >= 900, `took ${held.ms}ms`)
  })

  test('waitForFresh false waits for the studio', async () => {
    const client = await staleBehindSlowStudio({ waitForFresh: false })
    const fresh = read(client)
    assert.equal(await pendingAfter(fresh, 1_300), true, 'still waiting, well past the default budget')
    studio.release()
    assert.equal(await soon(fresh), 'two')
  })

  test('waitForFresh 0 serves the cached value at once', async () => {
    const client = await staleBehindSlowStudio({ waitForFresh: 0 })
    // The first read only starts the stamp check; the one after it sees the new stamp.
    assert.equal(await soon(read(client)), 'one')
    await wait(30)
    const held = await timed(soon(read(client)))
    assert.equal(held.value, 'one')
    // The one upper bound in this file: the alternative it rules out is the
    // default budget of a full second, which leaves half a second of slack.
    assert.ok(held.ms < 500, `took ${held.ms}ms`)
    await until(() => studio.held.length === 1, 'the refresh request')
    studio.release()
    await until(async () => (await read(client)) === 'two', 'the background refresh')
  })

  test('a hanging stamp check holds a read for waitForFresh, not for the timeout of the check', async () => {
    const client = createClient({ apiKey: 'k', baseUrl, onError: quiet, cache: { revalidate: 20, waitForFresh: 100 } })
    assert.equal(await read(client), 'one')
    studio.mode = 'hang'
    await wait(30)
    const held = await timed(soon(read(client)))
    assert.equal(held.value, 'one')
    // The check itself would hold it for 3 seconds: 1.5 leaves room on both sides.
    assert.ok(held.ms >= 80 && held.ms < 1_500, `took ${held.ms}ms`)
  })

  test('with nothing cached a read waits for the studio, whatever the budget', async () => {
    const client = createClient({ apiKey: 'k', baseUrl, cache: { waitForFresh: 50 } })
    studio.listMode = 'hold'
    const cold = read(client)
    assert.equal(await pendingAfter(cold, 300), true, 'still waiting, well past the budget')
    studio.release()
    assert.equal(await soon(cold), 'one')
  })

  test('reads of one key that arrive together share one refresh', async () => {
    const client = await staleBehindSlowStudio({ waitForFresh: false })
    const reads = Array.from({ length: 20 }, () => read(client))
    // Time for every one of them to have sent its own request, had it wanted to.
    await until(() => studio.held.length >= 1, 'the refresh')
    await wait(100)
    assert.equal(contentRequests(), 1)
    studio.release()
    assert.deepEqual([...new Set(await soon(Promise.all(reads)))], ['two'])
  })

  test('reads of one key that arrive together share one first fetch', async () => {
    const client = createClient({ apiKey: 'k', baseUrl })
    studio.listMode = 'hold'
    const reads = Array.from({ length: 20 }, () => read(client))
    await until(() => studio.held.length >= 1, 'the first fetch')
    await wait(100)
    assert.equal(contentRequests(), 1)
    studio.release()
    assert.deepEqual([...new Set(await soon(Promise.all(reads)))], ['one'])
  })

  test('a failing refresh is shared too: one request, everyone gets the cached value', async () => {
    const client = createClient({ apiKey: 'k', baseUrl, timeout: 200, onError: quiet, cache: { revalidate: 20, waitForFresh: false } })
    assert.equal(await read(client), 'one')
    studio.version = 'v2'
    studio.listMode = 'hang'
    await wait(30)
    studio.hits = []
    const values = await Promise.all(Array.from({ length: 20 }, () => read(client)))
    assert.deepEqual([...new Set(values)], ['one'])
    assert.equal(contentRequests(), 1)
  })

  for (const [name, invalidate] of [
    ['clearCache()', (client) => client.clearCache()],
    ['a dataset clearCache()', (client) => client.dataset('pages', 'home').clearCache()],
  ]) {
    test(`a refresh overtaken by ${name} is not joined and does not write its older answer`, async () => {
      const client = createClient({ apiKey: 'k', baseUrl, cache: { revalidate: false } })
      studio.listMode = 'hold'
      const slow = read(client) // asked while the studio held 'one'
      await until(() => studio.held.length === 1, 'the slow request')
      studio.title = 'two'
      studio.listMode = undefined
      invalidate(client)
      // A read after the invalidation asks again instead of joining the old request...
      assert.equal(await soon(read(client)), 'two')
      // ...the read that was already waiting gets what it asked for...
      studio.release()
      assert.equal(await soon(slow), 'one')
      // ...and that older answer has not replaced the newer one.
      assert.equal(await read(client), 'two')
    })
  }
})

describe('a 200 that is not the studio answering', () => {
  test('while revalidating: the last good value is served and kept', async () => {
    const client = createClient({ apiKey: 'k', baseUrl, onError: () => {}, cache: { revalidate: 20 } })
    assert.equal(await read(client), 'one')
    studio.version = 'v2'
    studio.title = 'two'
    studio.listMode = 'junk200'
    await wait(30)
    assert.equal(await read(client), 'one')
    // Not overwritten: still there for the outage that follows.
    studio.mode = '503'
    studio.listMode = undefined
    await wait(30)
    assert.equal(await read(client), 'one')
    studio.mode = 'up'
    await wait(30)
    assert.equal(await read(client), 'two')
  })

  test('with nothing cached it is an error, not an empty result', async () => {
    const client = createClient({ apiKey: 'k', baseUrl, onError: () => {} })
    studio.mode = 'junk200'
    await assert.rejects(read(client), { name: 'UnexpectedResponseError' })
  })

  test('a cache:false read rejects and leaves the cached value alone', async () => {
    const client = createClient({ apiKey: 'k', baseUrl, onError: () => {}, cache: { revalidate: 20 } })
    assert.equal(await read(client), 'one')
    studio.listMode = 'junk200'
    await assert.rejects(client.dataset('pages', 'home').list({ cache: false }), { name: 'UnexpectedResponseError' })
    studio.listMode = undefined
    studio.mode = '503'
    await wait(30)
    assert.equal(await read(client), 'one')
  })

  test('on the stamp route it leaves the last stamp standing', async () => {
    const failures = []
    const client = createClient({ apiKey: 'k', baseUrl, onError: (f) => failures.push(f), cache: { revalidate: 20 } })
    assert.equal(await read(client), 'one')
    studio.mode = 'junk200'
    studio.listMode = 'up'
    studio.title = 'two' // not announced by a stamp, so not to be fetched
    await wait(30)
    studio.hits = []
    assert.equal(await read(client), 'one')
    assert.equal(contentRequests(), 0)
    assert.deepEqual(failures.map((f) => [f.during, f.error.name]), [['stamp-check', 'UnexpectedResponseError']])
  })
})

describe('onError', () => {
  test('reports a failed stamp check', async () => {
    const failures = []
    const client = createClient({ apiKey: 'k', baseUrl, onError: (f) => failures.push(f), cache: { revalidate: 20 } })
    assert.equal(await read(client), 'one')
    assert.deepEqual(failures, [])
    studio.mode = '503'
    await wait(30)
    assert.equal(await read(client), 'one')
    assert.deepEqual(failures.map((f) => [f.during, f.key, f.error.status]), [['stamp-check', undefined, 503]])
  })

  test('reports a read that was answered from the cache, with its key', async () => {
    const failures = []
    const client = createClient({ apiKey: 'k', baseUrl, onError: (f) => failures.push(f), cache: { revalidate: 20 } })
    assert.equal(await read(client), 'one')
    studio.version = 'v2'
    studio.listMode = '503'
    await wait(30)
    assert.equal(await read(client), 'one')
    assert.deepEqual(failures.map((f) => [f.during, f.key, f.error.status]), [['read', 'records:pages/home', 503]])
  })

  test('does not repeat an error the caller already gets', async () => {
    const failures = []
    const client = createClient({ apiKey: 'k', baseUrl, onError: (f) => failures.push(f) })
    studio.listMode = '503'
    await assert.rejects(read(client), { status: 503 })
    assert.deepEqual(failures, [])
  })

  test('a hook that throws does not fail the read', async () => {
    const client = createClient({
      apiKey: 'k',
      baseUrl,
      onError: () => {
        throw new Error('logger is down')
      },
      cache: { revalidate: 20 },
    })
    assert.equal(await read(client), 'one')
    studio.version = 'v2'
    studio.mode = '503'
    await wait(30)
    assert.equal(await read(client), 'one')
  })

  test('without a hook: one warning per outage, and one more for the next outage', async () => {
    const warn = console.warn
    const warnings = []
    console.warn = (...args) => warnings.push(args.join(' '))
    try {
      const client = createClient({ apiKey: 'k', baseUrl, cache: { revalidate: 20 } })
      assert.equal(await read(client), 'one')
      assert.equal(warnings.length, 0)

      studio.mode = '503'
      for (let i = 0; i < 3; i++) {
        await wait(30)
        assert.equal(await read(client), 'one')
      }
      assert.equal(warnings.length, 1)
      assert.match(warnings[0], /@justmade\/client.*stamp check failed/)

      studio.mode = 'up'
      await wait(30)
      assert.equal(await read(client), 'one')
      studio.mode = '503'
      await wait(30)
      assert.equal(await read(client), 'one')
      assert.equal(warnings.length, 2)
    }
    finally {
      console.warn = warn
    }
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

describe('a 4xx that is not the studio speaking', () => {
  for (const mode of ['proxy404', 'proxy403', 'gateway404']) {
    test(`${mode} while revalidating serves the last good value and keeps it`, async () => {
      const client = createClient({ apiKey: 'k', baseUrl, cache: { revalidate: 20 } })
      assert.equal(await read(client), 'one')
      studio.version = 'v2'
      studio.title = 'two'
      studio.listMode = mode
      await wait(30)
      assert.equal(await read(client), 'one')
      // Still there for the outage that follows.
      studio.mode = '503'
      studio.listMode = undefined
      await wait(30)
      assert.equal(await read(client), 'one')
      // And the edit arrives once the studio is back.
      studio.mode = 'up'
      await wait(30)
      assert.equal(await read(client), 'two')
    })
  }

  test('a proxy 404 on an expired entry serves it too', async () => {
    const client = createClient({ apiKey: 'k', baseUrl, cache: { ttl: 20, revalidate: false } })
    assert.equal(await read(client), 'one')
    studio.mode = 'proxy404'
    await wait(30)
    assert.equal(await read(client), 'one')
  })

  test('a proxy 404 leaves the entry on disk for a restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jm-proxy-'))
    const first = createClient({ apiKey: 'k', baseUrl, cache: { revalidate: 20, store: new FileCacheStore({ dir }) } })
    assert.equal(await read(first), 'one')
    studio.version = 'v2'
    studio.listMode = 'proxy404'
    await wait(30)
    assert.equal(await read(first), 'one')

    studio.mode = '503'
    studio.listMode = undefined
    const second = createClient({ apiKey: 'k', baseUrl, cache: { store: new FileCacheStore({ dir }) } })
    assert.equal(await read(second), 'one')
    rmSync(dir, { recursive: true, force: true })
  })

  test('with nothing cached, the proxy 404 is what the caller gets', async () => {
    const client = createClient({ apiKey: 'k', baseUrl })
    studio.mode = 'proxy404'
    await assert.rejects(read(client), { name: 'JustmadeError', status: 404 })
  })

  test('a 404 from the studio itself is still definitive: the entry is dropped', async () => {
    const client = createClient({ apiKey: 'k', baseUrl, cache: { revalidate: 20 } })
    assert.equal(await read(client), 'one')
    studio.version = 'v2'
    studio.listMode = 'gone'
    await wait(30)
    await assert.rejects(read(client), { name: 'JustmadeError', status: 404 })
    // Nothing left to fall back on: the outage that follows surfaces as such.
    studio.listMode = '503'
    await assert.rejects(read(client), { name: 'JustmadeError', status: 503 })
  })
})

describe('version route', () => {
  test('a studio without the stamp route pauses the check instead of ending it', async () => {
    const realNow = Date.now
    let now = realNow()
    Date.now = () => now
    try {
      studio.mode = 'gone'
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

  test('a 404 from a proxy on the stamp route is tried again at the next interval, not paused', async () => {
    // The studio container is away for a moment and the proxy answers for it.
    // Pausing on that would keep edits off the site long after it is back.
    const realNow = Date.now
    let now = realNow()
    Date.now = () => now
    try {
      const client = createClient({ apiKey: 'k', baseUrl, onError: () => {}, cache: { revalidate: 60_000 } })
      assert.equal(await read(client), 'one')
      assert.equal(versionProbes(), 1)

      studio.mode = 'proxy404'
      studio.listMode = 'up'
      now += 61_000
      assert.equal(await read(client), 'one')
      assert.equal(versionProbes(), 2)

      // One interval later the studio is back, with an edit.
      studio.mode = 'up'
      studio.listMode = undefined
      studio.version = 'v2'
      studio.title = 'two'
      now += 61_000
      assert.equal(await read(client), 'two')
      assert.equal(versionProbes(), 3)
    }
    finally {
      Date.now = realNow
    }
  })

  test('a studio without the stamp route is not reported as an outage', async () => {
    const failures = []
    const warn = console.warn
    const warnings = []
    console.warn = (...args) => warnings.push(args.join(' '))
    try {
      studio.mode = 'gone'
      studio.listMode = 'up'
      const hooked = createClient({ apiKey: 'k', baseUrl, onError: (f) => failures.push(f) })
      assert.equal(await read(hooked), 'one')
      assert.deepEqual(failures, [])
      // Nor by the default warning.
      const plain = createClient({ apiKey: 'k', baseUrl })
      assert.equal(await read(plain), 'one')
      assert.deepEqual(warnings, [])
    }
    finally {
      console.warn = warn
    }
  })

  test('a 404 from a proxy on the stamp route is reported', async () => {
    const failures = []
    studio.mode = 'proxy404'
    studio.listMode = 'up'
    const client = createClient({ apiKey: 'k', baseUrl, onError: (f) => failures.push(f) })
    assert.equal(await read(client), 'one')
    assert.deepEqual(failures.map((f) => [f.during, f.error.status]), [['stamp-check', 404]])
  })
})

describe('saved queries', () => {
  test('a query without a result, and so without a value, is a valid answer', async () => {
    const client = createClient({ apiKey: 'k', baseUrl, onError: () => {}, cache: { revalidate: 20 } })
    studio.queryBody = { query: 'featured', shape: 'single', value: { uid: 'a' } }
    assert.deepEqual((await client.query('featured')).value, { uid: 'a' })

    // The editor unfeatures it: `value: undefined` does not survive JSON.
    studio.version = 'v2'
    studio.queryBody = { query: 'featured', shape: 'single' }
    await wait(30)
    const empty = await client.query('featured')
    assert.equal(empty.shape, 'single')
    assert.equal(empty.value, undefined)

    // It replaced the cached result: that is what an outage serves from now on.
    studio.mode = '503'
    await wait(30)
    assert.equal((await client.query('featured')).value, undefined)
  })

  test('a 200 that is not a query result keeps the last good one', async () => {
    const client = createClient({ apiKey: 'k', baseUrl, onError: () => {}, cache: { revalidate: 20 } })
    studio.queryBody = { query: 'featured', shape: 'single', value: { uid: 'a' } }
    assert.deepEqual((await client.query('featured')).value, { uid: 'a' })
    studio.version = 'v2'
    studio.queryBody = { status: 'maintenance' }
    await wait(30)
    assert.deepEqual((await client.query('featured')).value, { uid: 'a' })
  })
})

describe('requested locales', () => {
  test('spellings of one language share one cache entry and one request', async () => {
    const client = createClient({ apiKey: 'k', baseUrl })
    for (const locale of ['en', 'en-GB', 'EN-us', 'en_AU', 'en-US', ' en ']) {
      assert.equal(await read(client, { locale }), 'one@en-US', `asked for "${locale}"`)
    }
    assert.deepEqual(recordRequests().map((u) => u.split('?')[1]), ['locale=en-US'])
    // The list of locales was fetched once, not per read.
    assert.equal(studio.hits.filter((u) => u.endsWith('/locales')).length, 1)
  })

  test('the exact locale wins, then the same language, then the fallback, then the default', async () => {
    studio.locales = [
      { code: 'nl-BE', label: 'Nederlands', isDefault: true, isFallback: false },
      { code: 'fr-BE', label: 'Français (BE)', isDefault: false, isFallback: false },
      { code: 'fr-FR', label: 'Français (FR)', isDefault: false, isFallback: false },
      { code: 'en-US', label: 'English', isDefault: false, isFallback: true },
    ]
    const client = createClient({ apiKey: 'k', baseUrl })
    assert.equal(await read(client, { locale: 'fr-FR' }), 'one@fr-FR') // exact
    assert.equal(await read(client, { locale: 'fr' }), 'one@fr-BE') // same language: first listed
    assert.equal(await read(client, { locale: 'nl-NL' }), 'one@nl-BE') // same language
    assert.equal(await read(client, { locale: 'de-DE' }), 'one@en-US') // not offered: fallback

    // Without a fallback locale, a language that is not offered gets the default: no locale sent.
    studio.locales = LOCALES.map((locale) => ({ ...locale, isFallback: false }))
    const plain = createClient({ apiKey: 'k', baseUrl })
    assert.equal(await read(plain, { locale: 'de-DE' }), 'one')
  })

  test('a project without locales has one entry, whatever language is asked for', async () => {
    // What the real studio answers for such a project: an empty list, and the
    // same content for every requested language as for none.
    studio.locales = []
    const client = createClient({ apiKey: 'k', baseUrl })
    for (const locale of ['nl-BE', 'nl', 'en', 'de-DE', 'x1-ZZ']) {
      assert.equal(await read(client, { locale }), 'one', `asked for "${locale}"`)
    }
    assert.deepEqual(recordRequests().map((u) => u.split('?')[1]), [undefined])
    assert.equal(studio.hits.filter((u) => u.endsWith('/locales')).length, 1)
  })

  test('hundreds of made-up locales cannot push content out of the cache', async () => {
    // What a crawler sending arbitrary Accept-Language values does to a site
    // that passes the header on. Ten entries is all this cache holds.
    const client = createClient({ apiKey: 'k', baseUrl, onError: quiet, cache: { maxEntries: 10 } })
    assert.equal(await read(client), 'one')
    assert.equal(await read(client, { locale: 'nl' }), 'one@nl-BE')
    for (let i = 0; i < 300; i++) {
      assert.equal(await read(client, { locale: `x${i}-ZZ` }), 'one@en-US')
    }
    // One request per locale the project has, not one per value asked for.
    assert.equal(recordRequests().length, 3)
    // And the first entries are still there to carry an outage.
    studio.mode = '503'
    studio.hits = []
    assert.equal(await read(client), 'one')
    assert.equal(await read(client, { locale: 'nl-NL' }), 'one@nl-BE')
    assert.equal(contentRequests(), 0)
  })

  for (const [name, localesMode] of [
    ['the studio cannot be reached for them', '503'],
    ['an older studio has no locales route', 'gone'],
  ]) {
    test(`when ${name}, the requested locale goes to the studio as it is`, async () => {
      studio.localesMode = localesMode
      const client = createClient({ apiKey: 'k', baseUrl, onError: quiet })
      assert.equal(await read(client, { locale: 'de-DE' }), 'one@de-DE')
      assert.equal(await read(client, { locale: 'de-DE' }), 'one@de-DE')
      assert.equal(await read(client, { locale: 'fr' }), 'one@fr')
      // Asked once, then left alone for a while: not one failing request per read.
      assert.equal(studio.hits.filter((u) => u.endsWith('/locales')).length, 1)
    })
  }

  test('an empty locale forces the default, over the locale of the client', async () => {
    const client = createClient({ apiKey: 'k', baseUrl, locale: 'en' })
    assert.equal(await read(client), 'one@en-US')
    assert.equal(await read(client, { locale: '' }), 'one')
  })

  test('with caching off there is nothing to protect: the locale is passed on untouched', async () => {
    const client = createClient({ apiKey: 'k', baseUrl, cache: false })
    assert.equal(await read(client, { locale: 'en' }), 'one@en')
    assert.equal(studio.hits.filter((u) => u.endsWith('/locales')).length, 0)
  })

  test('a preview read maps the locale too, from the cached list', async () => {
    const client = createClient({ apiKey: 'k', baseUrl })
    const preview = client.forRequest('?sl-preview=1')
    assert.equal(preview.isPreview, true)
    assert.equal(await read(preview, { locale: 'en-GB' }), 'one@en-US')
    assert.equal(await read(preview, { locale: 'en-AU' }), 'one@en-US')
    assert.equal(studio.hits.filter((u) => u.endsWith('/locales')).length, 1)
    // What it fetched is what a visitor asking for English is served from.
    studio.hits = []
    assert.equal(await read(client, { locale: 'en' }), 'one@en-US')
    assert.equal(recordRequests().length, 0)
  })
})

describe('a write that fails', () => {
  for (const [name, writeMode, expected] of [
    ['times out', 'hang', { name: 'TimeoutError' }],
    ['gets a 503', '503', { status: 503 }],
    ['loses its connection', 'refuse', { name: 'TypeError' }],
  ]) {
    test(`${name}: it may have been stored, so the next read asks the studio again`, async () => {
      // No stamp checks: nothing but the failed write can make the read ask.
      const client = createClient({ apiKey: 'k', baseUrl, timeout: 200, cache: { revalidate: false } })
      assert.equal(await read(client), 'one')
      studio.writeMode = writeMode
      studio.title = 'two' // the write did land
      await assert.rejects(client.dataset('pages', 'home').update('a', { title: 'two' }), expected)
      assert.equal(await read(client), 'two')
    })
  }

  test('while the studio is down: the cached value is kept to fall back on', async () => {
    const client = createClient({ apiKey: 'k', baseUrl, onError: () => {}, cache: { revalidate: false } })
    assert.equal(await read(client), 'one')
    studio.mode = '503'
    await assert.rejects(client.createRecord('pages', 'home', { title: 'new' }), { status: 503 })
    // Asked again, as it must, and answered from the cache when that fails too.
    studio.hits = []
    assert.equal(await read(client), 'one')
    assert.equal(contentRequests(), 1)
  })

  test('refused by the studio: nothing was stored, the cache stays as it is', async () => {
    const client = createClient({ apiKey: 'k', baseUrl, cache: { revalidate: false } })
    assert.equal(await read(client), 'one')
    studio.writeMode = 'gone'
    await assert.rejects(client.dataset('pages', 'home').update('a', { title: 'x' }), { status: 404 })
    studio.hits = []
    assert.equal(await read(client), 'one')
    assert.equal(contentRequests(), 0)
  })

  test('a write that succeeds still drops the cached reads', async () => {
    const client = createClient({ apiKey: 'k', baseUrl, cache: { revalidate: false } })
    assert.equal(await read(client), 'one')
    studio.title = 'two'
    await client.dataset('pages', 'home').update('a', { title: 'two' })
    assert.equal(await read(client), 'two')
  })
})

describe('a cache:false read', () => {
  test('does not stamp content from before an edit as current', async () => {
    const client = createClient({ apiKey: 'k', baseUrl, cache: { revalidate: 20, waitForFresh: false } })
    assert.equal(await read(client), 'one')

    // A preview read is under way, answered with what the studio holds now...
    studio.listMode = 'hold'
    const preview = client.dataset('pages', 'home').list({ cache: false })
    await until(() => studio.held.length === 1, 'the preview request')
    // ...then an edit lands, and a read of something else sees the new stamp.
    studio.listMode = undefined
    studio.version = 'v2'
    studio.title = 'two'
    await wait(30)
    assert.equal((await client.dataset('pages', 'other').list())[0].data.title, 'two')

    // The preview read comes back with the content from before the edit.
    studio.release()
    assert.equal((await soon(preview))[0].data.title, 'one')
    // Stored under the old stamp, so a visitor's read checks again and gets the edit.
    assert.equal(await read(client), 'two')
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

  test('a restart while the studio hangs waits on the stamp check once, not on every read', async () => {
    const first = createClient({ apiKey: 'k', baseUrl, cache: { store: new FileCacheStore({ dir }) } })
    assert.equal(await read(first), 'one')

    studio.mode = 'hang'
    studio.hits = []
    const second = createClient({ apiKey: 'k', baseUrl, timeout: 300, cache: { waitForFresh: false, store: new FileCacheStore({ dir }) } })
    // The first read waits out the one stamp check...
    const cold = await timed(soon(read(second)))
    assert.equal(cold.value, 'one')
    assert.ok(cold.ms >= 250, `took ${cold.ms}ms`)
    // ...the ones after it, within the interval, do not ask again: a read
    // that waited would have had to send a check to wait on.
    for (let i = 0; i < 3; i++) assert.equal(await soon(read(second)), 'one')
    assert.equal(versionProbes(), 1)
    rmSync(dir, { recursive: true, force: true })
  })

  test('a restart while the studio answers 503 checks the stamp once per interval', async () => {
    const first = createClient({ apiKey: 'k', baseUrl, cache: { store: new FileCacheStore({ dir }) } })
    assert.equal(await read(first), 'one')

    studio.mode = '503'
    studio.hits = []
    const second = createClient({ apiKey: 'k', baseUrl, cache: { store: new FileCacheStore({ dir }) } })
    for (let i = 0; i < 10; i++) assert.equal(await read(second), 'one')
    assert.equal(versionProbes(), 1)
    // Nothing but that one request reached the studio: the rest came from disk.
    assert.equal(studio.hits.length, 1)
    rmSync(dir, { recursive: true, force: true })
  })

  test('after a failed first stamp check, the next interval tries again and picks up edits', async () => {
    const first = createClient({ apiKey: 'k', baseUrl, cache: { store: new FileCacheStore({ dir }) } })
    assert.equal(await read(first), 'one')

    const clock = fakeClock()
    studio.mode = '503'
    const second = createClient({ apiKey: 'k', baseUrl, cache: { revalidate: 60_000, store: new FileCacheStore({ dir }) } })
    assert.equal(await read(second), 'one')
    studio.mode = 'up'
    studio.version = 'v2'
    studio.title = 'two'
    // Inside the interval: no new check yet, so still the stored value.
    assert.equal(await read(second), 'one')
    clock.advance(61_000)
    assert.equal(await read(second), 'two')
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

  test('skips and removes its own corrupt, misfiled and half-written files', () => {
    const store = new FileCacheStore({ dir })
    store.set('good', { value: 'ok', expiresAt: 0 })
    // Named like cache files (64 hex characters), so they are the store's own.
    writeFileSync(join(dir, `${'a'.repeat(64)}.json`), '{"v":1,')
    writeFileSync(join(dir, `${'b'.repeat(64)}.json`), JSON.stringify({ v: 1, key: 'x', entry: { value: 1, expiresAt: 0 } }))
    // Half-written, by a process that died minutes ago (both temp name shapes).
    for (const name of [`${'c'.repeat(64)}.json.123.tmp`, `${'d'.repeat(64)}.json.1.0123456789ab.tmp`]) {
      writeFileSync(join(dir, name), 'partial')
      const longAgo = new Date(Date.now() - 5 * 60_000)
      utimesSync(join(dir, name), longAgo, longAgo)
    }
    const reloaded = new FileCacheStore({ dir })
    assert.deepEqual([...reloaded.keys()], ['good'])
    assert.equal(readdirSync(dir).length, 1)
    rmSync(dir, { recursive: true, force: true })
  })

  test('a starting store leaves a fresh temp file alone: another process is writing it', () => {
    // The old and the new container during a redeploy share the directory.
    // Removing the other one's temp file makes its rename fail and loses the write.
    const writing = [`${'c'.repeat(64)}.json.1.0123456789ab.tmp`, `${'d'.repeat(64)}.json.4242.tmp`]
    for (const name of writing) writeFileSync(join(dir, name), 'being written')
    const errors = []
    const store = new FileCacheStore({ dir, onError: (err) => errors.push(err) })
    assert.deepEqual(readdirSync(dir).sort(), [...writing].sort())
    assert.deepEqual([...store.keys()], [])
    assert.deepEqual(errors, [])
    rmSync(dir, { recursive: true, force: true })
  })

  test('two processes with the same pid do not write one key through the same temp file', () => {
    // In a container the pid is 1 for both, so `<file>.<pid>.tmp` would be one
    // path for two writers. A directory squatting on that path stands in for
    // the other writer: a store that still used it could not write at all.
    const key = 'records:pages/home'
    const file = `${createHash('sha256').update(key).digest('hex')}.json`
    mkdirSync(join(dir, `${file}.${process.pid}.tmp`))
    const errors = []
    const store = new FileCacheStore({ dir, onError: (err) => errors.push(err) })
    store.set(key, { value: 'ok', expiresAt: 0 })
    assert.deepEqual(errors, [])
    assert.equal(existsSync(join(dir, file)), true)
    // And no temp file of its own is left behind.
    assert.deepEqual(readdirSync(dir).sort(), [file, `${file}.${process.pid}.tmp`].sort())
    assert.equal(new FileCacheStore({ dir, onError: (err) => errors.push(err) }).get(key).value, 'ok')
    assert.deepEqual(errors, [])
    rmSync(dir, { recursive: true, force: true })
  })

  test('never touches files it did not write, whatever `dir` points at', () => {
    // A mistyped `dir` can be a project root: none of this may go missing.
    const foreign = {
      'package.json': '{"name":"my-site"}',
      'tsconfig.json': '{}',
      'broken.json': '{"v":1,',
      'lookalike.json': JSON.stringify({ v: 1, key: 'x', entry: { value: 1, expiresAt: 0 } }),
      'upload.tmp': 'partial',
      'leftover.json.123.tmp': 'partial',
      'notes.txt': 'hello',
    }
    for (const [name, content] of Object.entries(foreign)) writeFileSync(join(dir, name), content)
    const names = Object.keys(foreign).sort()
    const others = () => readdirSync(dir).filter((name) => names.includes(name)).sort()

    const store = new FileCacheStore({ dir, maxEntries: 1 })
    assert.deepEqual(others(), names, 'after load')
    assert.deepEqual([...store.keys()], [], 'and none of it is taken for a cache entry')

    store.set('a', { value: 1, expiresAt: 0 })
    store.set('b', { value: 2, expiresAt: 0 }) // evicts `a`
    store.delete('b')
    assert.deepEqual(others(), names, 'after set, eviction and delete')

    store.set('c', { value: 3, expiresAt: 0 })
    store.clear()
    assert.deepEqual(readdirSync(dir).sort(), names, 'after clear: the cache files gone, the rest intact')
    for (const [name, content] of Object.entries(foreign)) {
      assert.equal(readFileSync(join(dir, name), 'utf8'), content, `${name} unchanged`)
    }
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

// ── Review round: the six defects, each with the scenario that showed it ──────

describe('error hooks cannot hurt', () => {
  test('an async onError whose own work fails leaves no unhandled rejection behind', async () => {
    const rejections = watchRejections()
    try {
      const client = createClient({
        apiKey: 'k',
        baseUrl,
        // An alert that cannot be delivered, during the very outage it reports.
        onError: async () => {
          throw new Error('alert webhook is down too')
        },
        cache: { revalidate: 20 },
      })
      assert.equal(await read(client), 'one')
      studio.version = 'v2'
      studio.mode = '503'
      await wait(30)
      assert.equal(await read(client), 'one')
      await rejections.settle()
      assert.deepEqual(rejections.take(), [])
    }
    finally {
      rejections.stop()
    }
  })

  for (const [name, onError] of [
    ['throws', () => {
      throw new Error('logger is down')
    }],
    ['is async and rejects', async () => {
      throw new Error('logger is down')
    }],
  ]) {
    test(`a FileCacheStore onError that ${name} fails neither the store nor the read`, async () => {
      const rejections = watchRejections()
      const dir = mkdtempSync(join(tmpdir(), 'jm-hook-'))
      try {
        const blocker = join(dir, 'file')
        writeFileSync(blocker, '')
        // Unusable from the start: creating it, and every write after, reports to the hook.
        const store = new FileCacheStore({ dir: join(blocker, 'sub'), onError })
        const client = createClient({ apiKey: 'k', baseUrl, cache: { store } })
        assert.equal(await read(client), 'one')
        assert.equal(store.get('records:pages/home').value.records[0].data.title, 'one')
        await rejections.settle()
        assert.deepEqual(rejections.take(), [])
      }
      finally {
        rejections.stop()
        rmSync(dir, { recursive: true, force: true })
      }
    })
  }
})

describe('requested locales, while the studio is away', () => {
  test('content stays reachable when the list of locales has been pushed out of the cache', async () => {
    const store = new MemoryCacheStore()
    const client = createClient({ apiKey: 'k', baseUrl, onError: quiet, cache: { store } })
    assert.equal(await read(client, { locale: 'en' }), 'one@en-US')
    // The list is an entry like any other, and the oldest one goes when the cache fills.
    store.delete('locales')
    studio.mode = '503'
    studio.hits = []
    // Still mapped onto the key the content is under, although the list cannot be fetched.
    assert.equal(await read(client, { locale: 'en-GB' }), 'one@en-US')
    assert.equal(await read(client, { locale: 'en' }), 'one@en-US')
    assert.equal(recordRequests().length, 0)
    // The list is refreshed on the side, so give that request time to arrive -
    // and then some, to see that the failing list is asked for once, not per read.
    const listRequests = () => studio.hits.filter((u) => u.endsWith('/locales')).length
    await until(() => listRequests() >= 1, 'the refresh of the list')
    assert.equal(await read(client, { locale: 'en' }), 'one@en-US')
    await wait(50)
    assert.equal(listRequests(), 1)
  })

  test('a read does not spend its waiting on the list of locales being refreshed', async () => {
    // A budget of a minute: a read that waited it out on the list would run
    // into the guard long before, so coming back at all means it did not wait.
    const client = createClient({ apiKey: 'k', baseUrl, onError: quiet, cache: { revalidate: 20, waitForFresh: 60_000 } })
    assert.equal(await read(client, { locale: 'en' }), 'one@en-US')
    // The stamp moves, so both the list and the content are due for a check -
    // and the studio never answers for the list.
    studio.version = 'v2'
    studio.title = 'two'
    studio.localesMode = 'hold'
    await wait(30)
    assert.equal(await soon(read(client, { locale: 'en' })), 'two@en-US')
  })

  test('with waitForFresh false a read leaves no request for the list running behind it', async () => {
    // What a host needs that freezes the process once the response is out:
    // nothing may still be under way when the read returns.
    const client = createClient({ apiKey: 'k', baseUrl, onError: quiet, cache: { revalidate: 20, waitForFresh: false } })
    assert.equal(await read(client, { locale: 'en' }), 'one@en-US')
    studio.version = 'v2'
    studio.title = 'two'
    studio.localesMode = 'hold'
    await wait(30)
    const localized = read(client, { locale: 'en' })
    await until(() => studio.held.length === 1, 'the request for the list')
    // The list is being refreshed, so the read is not back yet...
    assert.equal(await pendingAfter(localized, 300), true, 'it returned while the list was still being fetched')
    // ...and once it is back, the studio has answered everything it was asked.
    studio.release()
    assert.equal(await soon(localized), 'two@en-US')
  })

  test('a waitForFresh too large for a timer means the same as false', async () => {
    // 3e9 ms is more than a timer holds, so the read waits for the content
    // without a limit - and must then treat the list the same way.
    const client = createClient({ apiKey: 'k', baseUrl, onError: quiet, cache: { revalidate: 20, waitForFresh: 3e9 } })
    assert.equal(await read(client, { locale: 'en' }), 'one@en-US')
    studio.version = 'v2'
    studio.title = 'two'
    studio.localesMode = 'hold'
    await wait(30)
    const localized = read(client, { locale: 'en' })
    await until(() => studio.held.length === 1, 'the request for the list')
    assert.equal(await pendingAfter(localized, 300), true, 'it returned while the list was still being fetched')
    studio.release()
    assert.equal(await soon(localized), 'two@en-US')
  })
})

describe('reads that share a request', () => {
  test('a read that joins a request started with nothing cached is served the value it holds when that fails', async () => {
    const clock = fakeClock()
    const client = createClient({ apiKey: 'k', baseUrl, onError: quiet, cache: { revalidate: 60_000, waitForFresh: false } })
    studio.listMode = 'hold'
    // A preview read leaves first, then a visitor's read with nothing cached. Both wait.
    const preview = read(client, { cache: false })
    await until(() => studio.held.length === 1, 'the preview request')
    const cold = read(client)
    await until(() => studio.held.length === 2, 'the cold request')
    // The preview read comes back and fills the cache.
    studio.held.shift().send()
    assert.equal(await soon(preview), 'one')
    // A second visitor's read, due for a check because the stamp moved, joins the cold request...
    studio.version = 'v2'
    clock.advance(61_000)
    studio.hits = []
    const joined = read(client)
    await wait(50)
    assert.equal(contentRequests(), 0, 'it joined, it did not ask again')
    // ...which fails. Both reads have the content at hand by now: neither gets the error.
    studio.drop()
    assert.equal(await soon(joined), 'one')
    assert.equal(await soon(cold), 'one')
  })

  test('a read does not join a request that is older than what the cache holds', async () => {
    const clock = fakeClock()
    const client = createClient({ apiKey: 'k', baseUrl, onError: quiet, cache: { revalidate: 60_000, waitForFresh: false } })
    studio.listMode = 'hold'
    const cold = read(client) // leaves first, and waits
    await until(() => studio.held.length === 1, 'the cold request')
    // A preview read leaves later and comes back first: the cache now holds a newer answer.
    studio.listMode = undefined
    assert.equal(await read(client, { cache: false }), 'one')
    // A read that is due for a check asks for itself, rather than wait for the older answer.
    studio.version = 'v2'
    clock.advance(61_000)
    studio.listMode = 'hold'
    studio.hits = []
    const later = read(client)
    await until(() => studio.held.length === 2, 'its own request')
    assert.equal(contentRequests(), 1)
    // Both requests fail: both reads are served the value the cache holds.
    studio.drop()
    assert.equal(await soon(later), 'one')
    assert.equal(await soon(cold), 'one')
  })
})

describe('the cache never goes back in time', () => {
  for (const [name, invalidate] of [
    ['a write', (client) => client.dataset('pages', 'home').update('a', { title: 'two' })],
    ['clearCache()', (client) => client.clearCache()],
  ]) {
    test(`a cache:false read that left before ${name} does not refill the cache with the old content`, async () => {
      const client = createClient({ apiKey: 'k', baseUrl, cache: { revalidate: false } })
      assert.equal(await read(client), 'one')
      studio.listMode = 'hold'
      const preview = read(client, { cache: false }) // asked while the studio held 'one'
      await until(() => studio.held.length === 1, 'the preview request')
      studio.listMode = undefined
      studio.title = 'two'
      await invalidate(client)
      // The old answer arrives after the invalidation...
      studio.release()
      assert.equal(await soon(preview), 'one')
      // ...and is not what the next visitor gets.
      assert.equal(await read(client), 'two')
    })
  }

  test('a record the studio said is gone is not put back by an answer that left earlier', async () => {
    const client = createClient({ apiKey: 'k', baseUrl, onError: quiet, cache: { revalidate: false } })
    // A preview read leaves while the dataset still exists, and is slow to come back.
    studio.listMode = 'hold'
    const preview = read(client, { cache: false })
    await until(() => studio.held.length === 1, 'the preview request')
    // Then it is deleted, and a visitor's read gets the studio's own 404.
    studio.listMode = 'gone'
    await assert.rejects(read(client), { status: 404 })
    // The answer from before the deletion arrives...
    studio.release()
    assert.equal(await soon(preview), 'one')
    // ...and the next visitor still gets the 404, not the deleted content from the cache.
    await assert.rejects(read(client), { status: 404 })
  })

  test('nor when the deletion removed a value that was cached', async () => {
    const clock = fakeClock()
    const client = createClient({ apiKey: 'k', baseUrl, onError: quiet, cache: { revalidate: false, ttl: 600_000 } })
    assert.equal(await read(client), 'one')
    studio.listMode = 'hold'
    const preview = read(client, { cache: false })
    await until(() => studio.held.length === 1, 'the preview request')
    // The entry expires, so the next read asks - and learns the content is gone.
    clock.advance(601_000)
    studio.listMode = 'gone'
    await assert.rejects(read(client), { status: 404 })
    studio.release()
    assert.equal(await soon(preview), 'one')
    await assert.rejects(read(client), { status: 404 })
  })

  test('nor when it was a cache:false read that learnt it is gone', async () => {
    const client = createClient({ apiKey: 'k', baseUrl, onError: quiet, cache: { revalidate: false } })
    // A visitor's read leaves while the dataset still exists, and is slow to come back.
    studio.listMode = 'hold'
    const visitor = read(client)
    await until(() => studio.held.length === 1, "the visitor's request")
    // Then it is deleted, and a preview read gets the studio's own 404.
    studio.listMode = 'gone'
    await assert.rejects(read(client, { cache: false }), { status: 404 })
    // The answer from before the deletion arrives...
    studio.release()
    assert.equal(await soon(visitor), 'one')
    // ...and is not what the next visitor is served.
    await assert.rejects(read(client), { status: 404 })
  })

  test("a cache:false read that gets the studio's own 404 removes the cached value", async () => {
    const client = createClient({ apiKey: 'k', baseUrl, onError: quiet, cache: { revalidate: false } })
    assert.equal(await read(client), 'one')
    studio.listMode = 'gone'
    await assert.rejects(read(client, { cache: false }), { status: 404 })
    // Without stamp checks nothing else would ever make a visitor's read ask again.
    await assert.rejects(read(client), { status: 404 })
  })

  test('a 404 from a proxy on a cache:false read leaves the cached value alone', async () => {
    const client = createClient({ apiKey: 'k', baseUrl, onError: quiet, cache: { revalidate: false } })
    assert.equal(await read(client), 'one')
    studio.listMode = 'proxy404'
    await assert.rejects(read(client, { cache: false }), { status: 404 })
    studio.hits = []
    assert.equal(await read(client), 'one')
    assert.equal(contentRequests(), 0)
  })

  test('an older answer does not replace a newer one that came back first', async () => {
    const client = createClient({ apiKey: 'k', baseUrl, cache: { revalidate: false } })
    studio.listMode = 'hold'
    const first = read(client) // leaves first, carries 'one'
    await until(() => studio.held.length === 1, 'the first request')
    studio.listMode = undefined
    studio.title = 'two'
    assert.equal(await read(client, { cache: false }), 'two') // leaves later, comes back first
    studio.release()
    assert.equal(await soon(first), 'one')
    studio.hits = []
    assert.equal(await read(client), 'two')
    assert.equal(contentRequests(), 0, 'served from the cache, which kept the newer answer')
  })
})

describe('a 304 nobody asked for', () => {
  test('is not an answer: a cache:false read fails and the cached value stays', async () => {
    const client = createClient({ apiKey: 'k', baseUrl, onError: quiet, cache: { revalidate: 20 } })
    assert.equal(await read(client), 'one')
    studio.listMode = 'always304'
    await assert.rejects(read(client, { cache: false }), { name: 'UnexpectedResponseError' })
    studio.listMode = undefined
    studio.mode = '503'
    await wait(30)
    assert.equal(await read(client), 'one')
  })

  test('with nothing cached it fails, and stores nothing', async () => {
    const client = createClient({ apiKey: 'k', baseUrl, onError: quiet })
    studio.listMode = 'always304'
    await assert.rejects(read(client), { name: 'UnexpectedResponseError' })
    studio.listMode = undefined
    assert.equal(await read(client), 'one')
  })

  test('in answer to an etag it still means "unchanged"', async () => {
    const client = createClient({ apiKey: 'k', baseUrl, cache: { revalidate: 20 } })
    assert.equal(await read(client), 'one')
    studio.version = 'v2'
    studio.listMode = 'always304'
    await wait(30)
    assert.equal(await read(client), 'one')
  })
})

describe('a preview view', () => {
  const preview = (client) => client.forRequest('?sl-preview=1')

  test('is a view on the client, not a second client', async () => {
    const client = createClient({ apiKey: 'k', baseUrl })
    const view = preview(client)
    assert.notEqual(view, client)
    assert.equal(view.isPreview, true)
    assert.equal(client.isPreview, false)
    assert.equal(view.forRequest('?sl-preview=1'), view)
    assert.equal(client.forRequest('?page=2'), client)
    assert.equal(await read(client), 'one') // the client knows the stamp from here on
    // The view asks the studio every time, and what it gets is what visitors are served from.
    studio.title = 'two'
    studio.hits = []
    assert.equal(await read(view), 'two')
    assert.equal(await read(view), 'two')
    assert.equal(recordRequests().length, 2)
    studio.hits = []
    assert.equal(await read(client), 'two')
    assert.equal(contentRequests(), 0)
  })

  test('shares the hook, the requests under way and the invalidations of its client', async () => {
    const failures = []
    const client = createClient({ apiKey: 'k', baseUrl, onError: (f) => failures.push(f), cache: { revalidate: false } })
    const view = preview(client)
    assert.equal(await read(client), 'one')

    // An invalidation through the view bars an answer that left through the client before it.
    studio.listMode = 'hold'
    const early = read(client, { cache: false })
    await until(() => studio.held.length === 1, 'the early request')
    studio.listMode = undefined
    studio.title = 'two'
    view.clearCache()
    studio.release()
    assert.equal(await soon(early), 'one')
    assert.equal(await read(client), 'two')

    // A read through the view that does use the cache reports to the client's hook.
    studio.writeMode = '503'
    await assert.rejects(view.dataset('pages', 'home').update('a', {}), { status: 503 })
    studio.mode = '503'
    assert.equal(await read(view, { cache: true }), 'two')
    assert.deepEqual(failures.map((f) => [f.during, f.key]), [['read', 'records:pages/home']])
  })
})

// ── The rules, against every combination ──────────────────────────────────────
//
// The tests above each stage one scenario somebody thought of. The defects that
// kept turning up lived between the scenarios: a rule that held for one kind of
// read and not for another, or for one way the studio fails and not the next.
// So these two tables do not pick scenarios. They cross everything with
// everything and check the rules of the read path on each cell:
//
//  1. a failure that is not the studio's own definitive answer never costs a
//     cached value: it is served, and it is still there afterwards;
//  2. nothing but a recognised answer is ever stored;
//  3. the cache never goes back in time;
//  4. no read hangs, and nothing leaves an unhandled rejection behind;
//  5. whatever happened, the client recovers once the studio is back.

/** What each way of answering amounts to, for a read that asks the studio. */
const BEHAVIOURS = {
  'up': 'fresh', // answers, with new content
  'same': 'unchanged', // answers, with what the client already has
  'always304': 'unasked', // "not modified", whether or not that was the question
  '503': 'transient',
  '429': 'transient',
  'refuse': 'transient',
  'hang': 'transient',
  'stall': 'transient',
  'proxy404': 'transient',
  'proxy403': 'transient',
  'gateway404': 'transient',
  'junk200': 'transient',
  'gone': 'definitive', // the studio's own 404
}
/** How the cache stands for the key when the read comes in. */
const STATES = ['none', 'current', 'outdated', 'expired', 'rechecked']
/** `joined` is two reads at once; `localized` asks in a language that has to be mapped. */
const KINDS = ['cached', 'joined', 'localized', 'bypass']

describe('every cache state x every studio behaviour x every kind of read', () => {
  let rejections
  before(() => {
    rejections = watchRejections()
  })
  after(() => rejections.stop())

  for (const state of STATES) {
    for (const [behaviour, meaning] of Object.entries(BEHAVIOURS)) {
      for (const kind of KINDS) {
        // A stalled body takes the same road through the client as a hang.
        if (behaviour === 'stall' && kind !== 'cached') continue

        test(`${state} / ${behaviour} / ${kind}`, async () => {
          const clock = fakeClock()
          const failures = []
          const store = new MemoryCacheStore()
          const client = createClient({
            apiKey: 'k',
            baseUrl,
            timeout: 150,
            onError: (failure) => failures.push(failure),
            // Reads wait for the studio (the file's default): every cell then
            // sees how the request ended, however slow the machine. Serving a
            // cached value *before* it ends has tests of its own, above.
            cache: { store, revalidate: 60_000, ttl: 600_000 },
          })
          const bypass = kind === 'bypass'
          const localized = kind === 'localized'
          const opts = localized ? { locale: 'en' } : undefined
          const titled = (title) => (localized ? `${title}@en-US` : title)

          // ── The cache, brought into `state` ──
          if (state !== 'none') assert.equal(await read(client, opts), titled('one'))
          if (state === 'outdated') {
            studio.version = 'v2'
            clock.advance(61_000)
          }
          if (state === 'expired') clock.advance(601_000)
          if (state === 'rechecked') {
            // A write that may or may not have landed leaves the entry due for a check.
            studio.writeMode = '503'
            await assert.rejects(client.dataset('pages', 'home').update('a', {}), { status: 503 })
            studio.writeMode = undefined
          }
          failures.length = 0

          // ── The studio, behaving as `behaviour` for content ──
          studio.localesMode = 'up' // the list of locales stays reachable here; it goes further down
          if (behaviour === 'up') studio.title = 'two'
          else if (behaviour !== 'same') studio.listMode = behaviour
          studio.hits = []

          // ── The read ──
          const reads = kind === 'joined'
            ? [read(client, opts), read(client, opts)]
            : [read(client, bypass ? { cache: false } : opts)]
          const results = await soon(Promise.allSettled(reads), `${kind} read`)

          const held = state !== 'none'
          const asks = bypass || state !== 'current'
          // "Not modified" answers a question only when the request carried an etag.
          const outcome = meaning === 'unasked' ? (held && !bypass ? 'unchanged' : 'transient') : meaning
          const expected = !asks ? 'one'
            : outcome === 'fresh' ? 'two'
              : outcome === 'unchanged' ? 'one'
                : outcome === 'definitive' ? { status: 404 }
                  : held && !bypass ? 'one' // rule 1
                    : 'an error'

          for (const result of results) {
            if (typeof expected === 'string' && expected !== 'an error') {
              assert.equal(result.status, 'fulfilled', `expected "${expected}", got ${result.reason}`)
              assert.equal(result.value, titled(expected))
            }
            else {
              assert.equal(result.status, 'rejected', `expected ${JSON.stringify(expected)}, got "${result.value}"`)
              if (typeof expected === 'object') assert.equal(result.reason.status, expected.status)
            }
          }
          if (!asks) assert.equal(recordRequests().length, 0, 'a current entry asks the studio nothing')
          // One request for two reads at once, however the studio answered.
          if (kind === 'joined' && asks) assert.equal(recordRequests().length, 1)
          // An absorbed failure is reported; one the caller gets is not repeated.
          const absorbed = asks && !bypass && held && outcome === 'transient'
          assert.equal(failures.some((f) => f.during === 'read'), absorbed, 'reported to onError')

          // ── Rules 1 and 2: what the cache should hold now carries a whole outage ──
          // The entire studio goes away, the list of locales included, and that
          // list has been pushed out of the cache as well.
          const survivor = !asks ? 'one'
            : outcome === 'fresh' ? 'two'
              : outcome === 'unchanged' ? 'one'
                : outcome === 'definitive' ? undefined // the studio said it is gone: for any read
                  : held ? 'one' : undefined
          studio.mode = '503'
          studio.listMode = undefined
          studio.localesMode = undefined
          studio.title = 'lost'
          if (localized) store.delete('locales')
          clock.advance(61_000)
          const [during] = await soon(Promise.allSettled([read(client, opts)]), 'the read during the outage')
          if (survivor === undefined) {
            assert.equal(during.status, 'rejected', `nothing should be cached, got "${during.value}"`)
          }
          else {
            assert.equal(during.status, 'fulfilled', `"${survivor}" should have survived: ${during.reason}`)
            assert.equal(during.value, titled(survivor))
          }

          // ── Rule 5: the studio comes back with an edit, and so does the client ──
          studio.mode = 'up'
          studio.version = 'v9'
          studio.title = 'three'
          await until(async () => {
            clock.advance(61_000) // past the stamp interval and any retry pause, each time
            return (await read(client, opts).catch(() => undefined)) === titled('three')
          }, 'recovery')

          // ── Rule 4 ──
          await rejections.settle()
          assert.deepEqual(rejections.take(), [])
        })
      }
    }
  }
})

describe('every pair of things that can overlap', () => {
  // A request is under way (A), something else happens (B), and then A ends -
  // with its answer, or with a failure. Throughout, the studio held 'one' when
  // A asked and holds 'two' by the time B happens.
  const FIRST = {
    'a cached read with nothing cached': { prior: false, opts: undefined },
    'a cached read that is due for a check': { prior: true, opts: undefined },
    'a cache:false read': { prior: false, opts: { cache: false } },
  }
  const THEN = {
    'a cache:false read comes back with newer content': (client) => read(client, { cache: false }),
    'a write succeeds': (client) => client.dataset('pages', 'home').update('a', {}),
    'clearCache()': (client) => client.clearCache(),
    'a write fails, and may have landed': async (client) => {
      studio.writeMode = '503'
      await assert.rejects(client.dataset('pages', 'home').update('a', {}), { status: 503 })
      studio.writeMode = undefined
    },
    'nothing': () => {},
  }
  const ENDS = ['its answer arrives', 'it fails']

  let rejections
  before(() => {
    rejections = watchRejections()
  })
  after(() => rejections.stop())

  for (const [first, { prior, opts }] of Object.entries(FIRST)) {
    for (const [then, happen] of Object.entries(THEN)) {
      for (const end of ENDS) {
        test(`${first}; then ${then}; then ${end}`, async () => {
          const clock = fakeClock()
          const client = createClient({ apiKey: 'k', baseUrl, onError: quiet, cache: { revalidate: 60_000, waitForFresh: false } })
          const bypass = opts?.cache === false
          const newer = then.startsWith('a cache:false read')
          const idle = then === 'nothing'

          // The client knows the stamp, as any client that has served a page does.
          // Without it an answer is stored unstamped and checked again on the
          // next read, which would hide an older answer that got stored.
          await client.dataset('pages', 'other').list()

          // A leaves, and the studio takes its time over the answer.
          if (prior) {
            studio.title = 'zero'
            assert.equal(await read(client), 'zero')
            studio.version = 'v2'
            clock.advance(61_000)
          }
          studio.title = 'one'
          studio.listMode = 'hold'
          const a = read(client, opts)
          await until(() => studio.held.length === 1, 'request A')

          // B happens while A waits.
          studio.listMode = undefined
          studio.title = 'two'
          await happen(client)

          // A ends.
          if (end === 'it fails') studio.drop()
          else studio.release()
          const [result] = await soon(Promise.allSettled([a]), 'read A')

          if (end === 'its answer arrives') {
            // A read gets the answer it asked for, whatever happened meanwhile.
            assert.equal(result.value, 'one', String(result.reason))
          }
          else if (bypass) {
            assert.equal(result.status, 'rejected', 'a cache:false read never falls back')
          }
          else {
            // Rule 1: served a value if there is one - the newest the cache holds,
            // else the one this read came in with.
            const fallback = newer ? 'two' : prior ? 'zero' : undefined
            if (fallback) assert.equal(result.value, fallback, String(result.reason))
            else assert.equal(result.status, 'rejected', `nothing to serve, got "${result.value}"`)
          }

          // Rule 3: the next read, within the same stamp interval, never gets
          // content older than what B established. Only when nothing happened
          // in between is A's own outcome what the cache holds.
          const next = !idle ? 'two'
            : end === 'its answer arrives' ? 'one'
              : prior && !bypass ? 'zero' // the old value, held through the retry pause
                : 'two' // nothing cached: asked for afresh
          assert.equal(await soon(read(client)), next)

          await rejections.settle()
          assert.deepEqual(rejections.take(), [])
        })
      }
    }
  }
})
