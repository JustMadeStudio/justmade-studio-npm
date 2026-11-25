import { ContentCache, type CacheEntry, type CacheOptions } from './cache'
import { JustmadeError } from './errors'
import type { ContentLocale, ContentRecord, ContentSchema, QueryResult, SchemaNode } from './types'
import { VersionTracker } from './version'

/**
 * Query parameter Justmade Studio appends when it loads your site in a
 * surface preview. Its presence means "an editor is looking at this right now",
 * which is exactly when caching must get out of the way - see `forRequest`.
 */
export const PREVIEW_PARAM = 'sl-preview'

/** Hosted Justmade Studio platform. Used when no `baseUrl` is provided. */
export const DEFAULT_BASE_URL = 'https://studio.justmade.be'

/** Default request timeout in ms (`timeout` option). */
const DEFAULT_TIMEOUT = 10_000
/** Ceiling for the stamp check, which every concurrent read waits on. */
const VERSION_TIMEOUT = 3_000
/** Default for `cache.waitForFresh`, in ms. */
const DEFAULT_WAIT_FOR_FRESH = 1_000
/** The longest delay a timer holds; beyond it `setTimeout` fires after 1 ms. */
const MAX_TIMER = 2_147_483_647
/** How many keys `storedBy` remembers before it starts over. */
const STORED_LIMIT = 5_000
/** How long a failed read of the project's locales is not repeated. */
const LOCALES_RETRY_MS = 60_000

/** A studio failure the client absorbed, handed to `onError`. */
export interface StudioFailure {
  /**
   * What failed: the periodic `stamp-check`, or the `read` that refreshes one
   * cache entry (its cached value was served instead).
   */
  during: 'stamp-check' | 'read'
  /** Cache key of the entry that could not be refreshed. Only for `read`. */
  key?: string
  /** What went wrong: a `JustmadeError`, a `TimeoutError`, a network error. */
  error: unknown
}

export interface JustmadeClientOptions {
  /**
   * Project API key, `slk_...`. Mint one in the project's settings under
   * "API keys". Its reach is the union of its per-node read/write scopes.
   */
  apiKey: string
  /**
   * Base URL of your Justmade Studio server, without a trailing `/api/content`
   * (that path is appended automatically). Defaults to the hosted platform at
   * `https://studio.justmade.be`; override it for a self-hosted instance.
   */
  baseUrl?: string
  /**
   * Default locale for reads, e.g. `nl` or `fr-BE`. When set, records are
   * returned in that language, with untranslated fields falling back to the
   * project default. Override per call with `opts.locale`. Omit for the default
   * locale. Discover available locales with `client.locales()`.
   */
  locale?: string
  /** Read caching. Pass `false` to disable, or an options object to tune it. */
  cache?: boolean | CacheOptions
  /** Custom `fetch` implementation. Defaults to the global `fetch`. */
  fetch?: typeof fetch
  /**
   * Give up on a request after this many ms, body included. Default `10000`.
   * `0` disables it, as does `Infinity`.
   *
   * Without one, a studio that accepts the connection but never answers holds
   * every read until the runtime gives up (minutes, in Node). A timed-out read
   * counts as transient, like a `5xx`: the last good value is served. The
   * once-a-minute stamp check uses at most 3 seconds of it, as every read in
   * that moment waits on the check.
   *
   * It covers writes too. A write that times out may still have reached the
   * studio, so do not blindly send it again: you could store it twice.
   */
  timeout?: number
  /**
   * Called for every studio failure the client absorbs: a failed stamp check,
   * or a read answered from the cache because its refresh failed. These never
   * reach your code as an error, so this is the only place to notice that the
   * site is running on cached content. Errors that are thrown to the caller
   * (a read with nothing cached, a write) are not repeated here.
   *
   * At most one call per stamp check and one per cache entry per retry pause,
   * so it is safe to log or alert from. Without it the client logs one
   * `console.warn` per outage.
   */
  onError?: (failure: StudioFailure) => void
  /** Extra headers merged into every request. */
  headers?: Record<string, string>
  /**
   * Force preview behaviour: every read bypasses the cache and refreshes it.
   * Usually you do not set this by hand - use `client.forRequest(req)`, which
   * turns it on only for requests that carry the studio's preview marker.
   */
  preview?: boolean
}

/** Per-call read options. */
export interface ReadOptions {
  /** Set `false` to bypass the cache for this call and always hit the network. */
  cache?: boolean
  /**
   * Locale for this read, overriding the client-level `locale`. Pass an empty
   * string to force the project default even when a client locale is set.
   * Untranslated fields fall back to the default locale.
   */
  locale?: string
}

type Method = 'GET' | 'POST' | 'PATCH'

/**
 * Typed client for the Justmade Studio content API: read and write a project's node
 * datasets from any website or app. Reads are cached (see the `cache` option);
 * writes invalidate the affected cache entries automatically.
 *
 * ```ts
 * const studio = new JustmadeClient({ apiKey: 'slk_...', baseUrl: 'https://studio.example.com' })
 * const posts = await studio.dataset<Post>('blog', 'posts').list()
 * ```
 */
export class JustmadeClient {
  private readonly apiKey: string
  private readonly baseUrl: string
  private readonly fetchImpl: typeof fetch
  private readonly headers: Record<string, string>
  private readonly cache: ContentCache
  private readonly versionTracker: VersionTracker
  /**
   * `false` on a preview view (see `forRequest`), so reads bypass the cache by
   * default. The one field such a view has of its own; all the rest is shared.
   */
  private readDefault: boolean
  /** Client-level default locale for reads (undefined = project default). */
  private readonly locale?: string
  /** Request timeout in ms, `0` for none. */
  private readonly timeout: number
  /** `cache.waitForFresh` in ms, `Infinity` to wait for the studio. */
  private readonly waitForFresh: number
  /**
   * The refresh under way per cache key, so concurrent reads of one key share
   * one request, with the ticket it left on (see `state.ticket`).
   */
  private readonly inflight = new Map<string, { job: Promise<unknown>, ticket: number }>()
  /**
   * Per cache key, the ticket of the request whose answer the cache holds.
   * Emptied on every invalidation, capped by `STORED_LIMIT`. See `storable`.
   */
  private readonly storedBy = new Map<string, number>()
  private readonly onError?: (failure: StudioFailure) => void
  /**
   * Everything that changes while the client runs and is not a collection of
   * its own. One object, so that a preview view - which shares this client's
   * fields through its prototype - changes the same values and never a copy.
   */
  private readonly state = {
    /**
     * Numbers the requests in the order they leave. Answers come back in any
     * order, and the cache must never go back in time: a request takes a
     * ticket when it leaves, and `storable` compares it on the way back.
     */
    ticket: 0,
    /** The last ticket handed out when the cache was last invalidated. */
    invalidatedAt: 0,
    /** Set by an absorbed failure, cleared by the next answer: one warning per outage. */
    unreachable: false,
    /**
     * The project's locales as last read. Kept here and not only in the cache,
     * where the entry can be evicted: without the list a requested locale
     * cannot be mapped onto the key its content is cached under, and that
     * content would be out of reach for as long as the studio is away.
     */
    locales: undefined as ContentLocale[] | undefined,
    /** Epoch ms before which the locales are not asked for again, after that failed. */
    localesRetryAt: 0,
  }

  constructor(options: JustmadeClientOptions) {
    if (!options.apiKey) throw new Error('JustmadeClient: `apiKey` is required')

    this.apiKey = options.apiKey
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
    const resolvedFetch = options.fetch ?? globalThis.fetch
    if (!resolvedFetch) {
      throw new Error('JustmadeClient: no `fetch` available; pass one via options.fetch (Node < 18)')
    }
    this.fetchImpl = resolvedFetch.bind(globalThis)
    this.headers = options.headers ?? {}
    this.locale = options.locale || undefined
    this.readDefault = options.preview !== true
    this.timeout = normalizeTimeout(options.timeout)
    this.onError = options.onError

    const cacheOpt = options.cache
    const cacheOptions: CacheOptions
      = cacheOpt === false ? { enabled: false }
        : cacheOpt === true || cacheOpt === undefined ? {}
          : cacheOpt
    this.cache = new ContentCache(cacheOptions)
    this.waitForFresh = normalizeWait(cacheOptions.waitForFresh)

    const revalidate = cacheOptions.enabled === false || cacheOptions.revalidate === false
      ? 0
      : cacheOptions.revalidate ?? 60_000
    // The stamp check is tiny, and every read arriving while it runs waits on it,
    // so it gets a tighter budget than a full read.
    const probeTimeout = this.timeout === 0 ? VERSION_TIMEOUT : Math.min(this.timeout, VERSION_TIMEOUT)
    this.versionTracker = new VersionTracker(
      async () => {
        try {
          const res = await this.request<{ version?: unknown }>('GET', '/version', undefined, probeTimeout)
          // Anything but a stamp (a maintenance page answering 200) is no
          // answer: the last known stamp stands.
          if (typeof res?.version !== 'string') throw unexpectedBody(`${this.baseUrl}/api/content/version`)
          this.state.unreachable = false
          return res.version
        }
        catch (err) {
          // A studio without the route is up and answering: nothing to report.
          if (isMissingRoute(err)) this.state.unreachable = false
          else this.report({ during: 'stamp-check', error: err })
          throw err
        }
      },
      revalidate,
      isMissingRoute,
    )
  }

  // ── Preview scoping ─────────────────────────────────────────────────────────

  /**
   * A per-request view of this client that skips the cache when the request
   * comes from a Justmade Studio surface preview, and behaves exactly like this
   * client otherwise. Reads still refresh the shared cache, so an editor
   * refreshing the preview also warms what real visitors get.
   *
   * Accepts whatever your framework hands you: a `Request`, a URL string or
   * `URL`, `URLSearchParams`, or a plain searchParams object.
   *
   * ```ts
   * // Next.js app router
   * export default async function Page({ searchParams }) {
   *   const posts = await studio.forRequest(await searchParams).dataset('blog', 'posts').list()
   * }
   * ```
   *
   * Note this only bypasses the SDK's own cache. If the page itself sits behind
   * a CDN or framework data cache, that layer needs the same treatment (e.g.
   * `cache: 'no-store'` when the preview marker is present) or the editor keeps
   * seeing a stale page no matter what this client returns.
   */
  forRequest(input: PreviewInput): JustmadeClient {
    if (!this.readDefault) return this // already a preview client
    if (!isPreviewRequest(input)) return this

    // A view on this client, not a second one: it inherits every field through
    // its prototype - the cache, the stamp, the requests under way, the options -
    // and differs in the one it sets here. The preview must refresh what the
    // public site reads, not keep a second universe of its own; and built this
    // way there is no list of fields to hand over that a new one could be
    // missing from.
    const view = Object.create(this) as JustmadeClient
    view.readDefault = false
    return view
  }

  /** Whether this client bypasses the cache (i.e. came from a preview request). */
  get isPreview(): boolean {
    return !this.readDefault
  }

  // ── Introspection ─────────────────────────────────────────────────────────

  /** The full content shape this key can reach: nodes, datasets, field schemas. */
  async schema(opts?: ReadOptions): Promise<ContentSchema> {
    return this.cachedGet<ContentSchema>('schema', '/schema', opts, has('nodes', Array.isArray))
  }

  /** Shorthand for `schema()` then `.nodes`. */
  async nodes(opts?: ReadOptions): Promise<SchemaNode[]> {
    return (await this.schema(opts)).nodes
  }

  /**
   * The locales this project's content can be requested in (default first). Use
   * a locale `code` as the client `locale` option or a per-call `opts.locale`.
   */
  async locales(opts?: ReadOptions): Promise<ContentLocale[]> {
    const res = await this.cachedGet<{ locales: ContentLocale[] }>('locales', '/locales', opts, has('locales', Array.isArray))
    return res.locales
  }

  /** Resolve the locale for a read: per-call override, else the client default. */
  private resolveLocale(opts?: ReadOptions): string | undefined {
    const l = opts && 'locale' in opts ? opts.locale : this.locale
    return l || undefined
  }

  /**
   * The locale a read is requested and cached under: the requested one mapped
   * onto a locale the project is configured with (see `matchLocale`).
   *
   * Sites pass on whatever language the visitor's browser asks for, and the
   * studio answers all of `nl`, `nl-NL` and `nl-BE` with the same content. Keyed
   * by the raw value, each spelling would be its own cache entry and its own
   * request - and a stream of made-up ones would push every real entry out of
   * the cache, the last good values for an outage among them. Mapped first,
   * the cache holds one entry per configured locale, whatever is asked for.
   *
   * Without the list of locales (caching off, an older studio without the
   * route, studio unreachable and never read) the requested value goes to the
   * studio as it is, and the studio resolves it.
   */
  private async readLocale(opts?: ReadOptions): Promise<string | undefined> {
    const requested = this.resolveLocale(opts)?.trim() || undefined
    if (requested === undefined || !this.cache.enabled) return requested

    const configured = await this.configuredLocales()
    return configured ? matchLocale(requested, configured) : requested
  }

  /**
   * The project's locales, or `undefined` when they have never been read and
   * cannot be now. An empty list is an answer like any other: the project has
   * no locales, the studio serves the same content whatever language is asked
   * for, and `matchLocale` then maps every request onto the default.
   *
   * Once the list is known this does not wait for anything: the read maps from
   * the list as it stands, and the list is brought up to date on the side. A
   * read therefore spends its `waitForFresh` on its content alone, and keeps
   * finding that content under the same key while the studio is away. Only
   * the very first localized read waits here, as it has nothing to map from.
   *
   * The exception is `waitForFresh: false`. That setting promises that a read
   * waits for the studio and leaves nothing running when it returns - what a
   * host needs that freezes the process once the response is out. So there
   * the list is brought up to date first, like the content after it.
   */
  private async configuredLocales(): Promise<ContentLocale[] | undefined> {
    const state = this.state
    if (Date.now() >= state.localesRetryAt) {
      // Always through the cache, also on a preview view: this runs on every
      // localized read, and a new locale shows up when the stamp moves.
      const lookup = this.locales({ cache: true }).then(
        (locales) => {
          state.locales = locales
        },
        () => {
          // Leave the list as it is, and the studio alone for a while.
          state.localesRetryAt = Date.now() + LOCALES_RETRY_MS
        },
      )
      if (state.locales === undefined || this.waitForFresh === Infinity) await lookup
    }
    return state.locales
  }

  // ── Records ───────────────────────────────────────────────────────────────

  /** List every record in a dataset (references inflated). Requires read scope. */
  async listRecords<T = Record<string, unknown>>(
    nodeSlug: string,
    datasetSlug: string,
    opts?: ReadOptions,
  ): Promise<ContentRecord<T>[]> {
    const locale = await this.readLocale(opts)
    const res = await this.cachedGet<{ records: ContentRecord<T>[] }>(
      recordsKey(nodeSlug, datasetSlug, locale),
      datasetPath(nodeSlug, datasetSlug) + localeQuery(locale),
      opts,
      has('records', Array.isArray),
    )
    return res.records
  }

  /** Read one record by uid. Requires read scope. Throws 404 if it does not exist. */
  async getRecord<T = Record<string, unknown>>(
    nodeSlug: string,
    datasetSlug: string,
    recordUid: string,
    opts?: ReadOptions,
  ): Promise<ContentRecord<T>> {
    const locale = await this.readLocale(opts)
    const res = await this.cachedGet<{ record: ContentRecord<T> }>(
      recordKey(nodeSlug, datasetSlug, recordUid, locale),
      `${datasetPath(nodeSlug, datasetSlug)}/${encodeURIComponent(recordUid)}${localeQuery(locale)}`,
      opts,
      has('record', isObject),
    )
    return res.record
  }

  /** Create a record. Requires write scope. Invalidates cached reads of the dataset. */
  async createRecord<T = Record<string, unknown>>(
    nodeSlug: string,
    datasetSlug: string,
    data: Record<string, unknown>,
  ): Promise<ContentRecord<T>> {
    const res = await this.write<{ record: ContentRecord<T> }>(
      'POST',
      datasetPath(nodeSlug, datasetSlug),
      { data },
      nodeSlug,
      datasetSlug,
    )
    return res.record
  }

  /**
   * Partially update a record. The patch is merged onto the stored data (omitted
   * top-level fields are preserved). Requires write scope. Invalidates cached
   * reads of the dataset and of this record.
   */
  async updateRecord<T = Record<string, unknown>>(
    nodeSlug: string,
    datasetSlug: string,
    recordUid: string,
    data: Record<string, unknown>,
  ): Promise<ContentRecord<T>> {
    const res = await this.write<{ record: ContentRecord<T> }>(
      'PATCH',
      `${datasetPath(nodeSlug, datasetSlug)}/${encodeURIComponent(recordUid)}`,
      { data },
      nodeSlug,
      datasetSlug,
    )
    return res.record
  }

  /**
   * Sends a write and settles the cached reads of its dataset with the outcome.
   *
   * Stored: they are dropped. Refused (an answered 4xx): they are still right
   * and stay. Anything else - a timeout, a dropped connection, a 5xx - leaves
   * open whether the studio carried the write out, so they are marked for a
   * recheck: the next read asks the studio again, and keeps the cached value to
   * fall back on if the studio is in fact down.
   */
  private async write<T>(method: Method, path: string, body: unknown, nodeSlug: string, datasetSlug: string): Promise<T> {
    let res: T
    try {
      res = await this.request<T>(method, path, body)
    }
    catch (err) {
      if (writeMayHaveLanded(err)) this.invalidateDataset(nodeSlug, datasetSlug, 'recheck')
      throw err
    }
    this.invalidateDataset(nodeSlug, datasetSlug)
    return res
  }

  // -- Queries --

  /** Run a saved query (`queries.<slug>`) and return its result. Requires read scope. */
  async query<V = unknown>(querySlug: string, opts?: ReadOptions): Promise<QueryResult<V>> {
    return this.cachedGet<QueryResult<V>>(
      `query:${querySlug}`,
      `/queries/${encodeURIComponent(querySlug)}`,
      opts,
      // Recognised by `shape`, never by `value`: that may be anything, and a
      // query without a result can come back with no `value` at all.
      has('shape', (shape) => typeof shape === 'string'),
    )
  }

  // ── Fluent dataset handle ───────────────────────────────────────────────────

  /**
   * A fluent, type-parameterised handle to one dataset:
   * `client.dataset<Post>('blog', 'posts').list()`.
   */
  dataset<T = Record<string, unknown>>(nodeSlug: string, datasetSlug: string): DatasetHandle<T> {
    return new DatasetHandle<T>(this, nodeSlug, datasetSlug)
  }

  // ── Cache control ───────────────────────────────────────────────────────────

  /**
   * Clear cached reads. With no argument, clears everything. Pass a scope to
   * clear just part of it: a node slug, or `{ node, dataset }` for one dataset.
   */
  clearCache(scope?: string | { node: string, dataset?: string }): void {
    if (scope === undefined) {
      this.cache.clear()
      this.invalidated()
      return
    }
    if (typeof scope === 'string') {
      this.dropPrefix(`records:${scope}/`)
      this.dropPrefix(`record:${scope}/`)
      return
    }
    if (scope.dataset) {
      this.invalidateDataset(scope.node, scope.dataset)
    } else {
      this.dropPrefix(`records:${scope.node}/`)
      this.dropPrefix(`record:${scope.node}/`)
    }
  }

  /**
   * Invalidate cached record reads for a dataset (every locale), plus all query
   * results (which may aggregate it). `drop` removes them; `recheck` keeps each
   * value as a fallback but makes the next read ask the studio again.
   */
  private invalidateDataset(nodeSlug: string, datasetSlug: string, how: 'drop' | 'recheck' = 'drop'): void {
    const one = how === 'drop' ? (key: string) => this.drop(key) : (key: string) => this.recheck(key)
    const all = how === 'drop' ? (prefix: string) => this.dropPrefix(prefix) : (prefix: string) => this.recheckPrefix(prefix)
    // Default-locale list key + every `::<locale>` variant of it.
    one(recordsKey(nodeSlug, datasetSlug))
    all(`${recordsKey(nodeSlug, datasetSlug)}::`)
    // All single-record keys under the dataset (every uid, every locale).
    all(`${recordKey(nodeSlug, datasetSlug, '')}`)
    all('query:')
  }

  /** Drop one key from the cache. */
  private drop(key: string): void {
    this.cache.delete(key)
    this.invalidated()
  }

  /** `drop` for every key that starts with `prefix`. */
  private dropPrefix(prefix: string): void {
    this.cache.deletePrefix(prefix)
    this.invalidated()
  }

  /** Like `drop`, but the value stays as a fallback (see `ContentCache.expire`). */
  private recheck(key: string): void {
    this.cache.expire(key)
    this.invalidated()
  }

  /** `recheck` for every key that starts with `prefix`. */
  private recheckPrefix(prefix: string): void {
    this.cache.expirePrefix(prefix)
    this.invalidated()
  }

  /**
   * Called by everything that invalidates cached reads. Every request that is
   * under way at this moment left before it, so its answer may show the
   * content as it was: none of them may store what they come back with
   * (`storable`), and no later read may join one of them (hence the cleared
   * `inflight`). They still answer the reads that were already waiting on them.
   *
   * Deliberately not narrowed to the keys that were invalidated. The price is
   * that an unrelated answer now and then is served without being stored, and
   * asked for once more; what it buys is one rule without exceptions.
   */
  private invalidated(): void {
    this.state.invalidatedAt = this.state.ticket
    this.storedBy.clear()
    this.inflight.clear()
  }

  /**
   * Whether the answer to the request that left on `ticket` may change what
   * the cache holds for `key`. The single gate in front of every cache write
   * that follows a request - cached read or bypass, a new value, a `304`, a
   * deletion or a retry pause alike. It keeps the cache from going back in time:
   *
   * - not when the cache was invalidated after the request left: the answer
   *   may show the content from before (a write, `clearCache`);
   * - not when the cache already holds the answer to a request that left
   *   later: that one is newer, whichever of the two came back first.
   */
  private storable(key: string, ticket: number): boolean {
    return ticket > this.state.invalidatedAt && ticket >= (this.storedBy.get(key) ?? 0)
  }

  /**
   * Settles the cache with the studio's own definitive "no" for `key` (deleted,
   * forbidden), in answer to the request that left on `ticket`: the entry goes.
   * The one place this happens, for a cached read and a bypass alike.
   *
   * The deletion is noted like any other answer. Without that, a request that
   * left earlier and comes back later would pass the gate and put the deleted
   * content straight back.
   */
  private gone(key: string, ticket: number): void {
    if (!this.storable(key, ticket)) return
    this.cache.delete(key)
    this.stored(key, ticket)
  }

  /**
   * Notes that the cache now reflects, for `key`, the answer to the request
   * that left on `ticket` - a value, a `304`, or the studio's own "this does
   * not exist", after which the cache holds nothing for it. A refresh of that
   * key that left earlier and is still under way is retired: a read arriving
   * now must not join it for an older answer than the cache already reflects.
   */
  private stored(key: string, ticket: number): void {
    // Unbounded growth is cut off the blunt, safe way: forget everything and
    // bar every request under way from storing, as an invalidation does.
    if (this.storedBy.size >= STORED_LIMIT) this.invalidated()
    this.storedBy.set(key, ticket)
    const running = this.inflight.get(key)
    if (running && running.ticket < ticket) this.inflight.delete(key)
  }

  // ── Transport ───────────────────────────────────────────────────────────────

  /**
   * The read path, with conditional revalidation.
   *
   * Steady state (project stamp unchanged since we last confirmed this entry):
   * served straight from cache, zero network. After a content change the stamp
   * moves, so the entry is revalidated once with `If-None-Match` - a `304` keeps
   * the cached value, a `200` replaces it - and then it is fast again.
   *
   * Five rules hold for every read, whatever the studio does. Each is enforced
   * in exactly one place, named here, so that it cannot hold for one kind of
   * read and not for another:
   *
   * 1. A failure that is not the studio's own definitive answer never costs a
   *    cached value: it is served instead, and stays cached (`refresh`).
   * 2. Only what is recognisably this endpoint's answer is ever stored
   *    (`conditionalGet`).
   * 3. The cache never goes back in time: an answer is not stored when the
   *    cache was invalidated, or filled with a newer answer, after its request
   *    left (`storable`, in front of every write to the cache).
   * 4. A read that already holds a value waits on the studio for `waitForFresh`
   *    at most, stamp check and refresh together (here); the refresh then
   *    finishes on the side.
   * 5. One request per key at a time (`refresh`).
   */
  private async cachedGet<T>(cacheKey: string, path: string, opts: ReadOptions | undefined, isExpected: BodyCheck): Promise<T> {
    const useCache = opts?.cache ?? this.readDefault

    // Preview / explicit bypass: always fetch fresh and never fall back, but
    // still refresh the shared cache so real visitors benefit from the warm entry.
    if (!useCache) {
      // The stamp as it stands before asking, like the cached path below. Read
      // after the answer it can be newer than the content that came back (an
      // edit landed in between, and another read's stamp check saw it), and
      // that older content would then count as current until the next edit.
      const version = this.versionTracker.current() ?? undefined
      const ticket = ++this.state.ticket
      let res: Awaited<ReturnType<JustmadeClient['conditionalGet']>>
      try {
        res = await this.conditionalGet(path, undefined, isExpected)
      }
      catch (err) {
        // Never falls back - but the studio's own "this does not exist" is an
        // answer for the cache as well, here as on the cached path.
        if (isDefinitive(err)) this.gone(cacheKey, ticket)
        throw err
      }
      if (this.storable(cacheKey, ticket)) {
        this.cache.set(cacheKey, res.value, { etag: res.etag, version }, Date.now())
        this.stored(cacheKey, ticket)
      }
      return res.value as T
    }

    // With something to serve, expired or not, the studio gets a budget.
    const started = Date.now()
    const budget = this.cache.stale(cacheKey) ? this.waitForFresh : Infinity

    // Cheap, throttled: at most one tiny stamp request per `revalidate` window.
    // A check that outlasts the budget carries on; this read uses the stamp we had.
    await within(this.versionTracker.refresh(started), budget)
    const version = this.versionTracker.current() ?? undefined
    const entry = this.cache.peek(cacheKey, Date.now())

    if (entry) {
      // Serve from cache when we cannot see a newer stamp (tracking off, first
      // probe not in yet, or studio unreachable) or the stamp is unchanged since
      // this entry was last confirmed.
      if (version === undefined || entry.validatedVersion === version) {
        return entry.value as T
      }
    }

    // Revalidate (the stamp moved) or refetch (miss / TTL expired). An expired
    // entry still has its etag, so an unchanged value comes back as a `304`.
    const last = entry ?? this.cache.stale(cacheKey)
    // A refetch failed moments ago: serve the last good value until the pause
    // is over, rather than making every read wait on an unreachable studio.
    if (last?.retryAt !== undefined && Date.now() < last.retryAt) {
      return last.value as T
    }

    const refresh = this.refresh<T>(cacheKey, path, last, version, isExpected)
    if (!last) return refresh
    const outcome = await within(refresh, budget - (Date.now() - started))
    return outcome.settled ? outcome.value : last.value as T
  }

  /**
   * Fetches `cacheKey` from the studio and settles the cache with the answer.
   * One per key at a time: reads that arrive while it runs get the same promise,
   * so a slow studio sees one request for a key and not one per visitor.
   *
   * Resolves with the value to serve: the fresh one, or a cached one when the
   * studio failed transiently. Rejects on a definitive answer, or when there is
   * nothing cached to serve in its place.
   */
  private refresh<T>(
    cacheKey: string,
    path: string,
    last: CacheEntry | undefined,
    version: string | undefined,
    isExpected: BodyCheck,
  ): Promise<T> {
    const running = this.inflight.get(cacheKey)
    if (running) return running.job as Promise<T>

    const ticket = ++this.state.ticket
    // Whether the slot for this key is still this refresh's own: once retired
    // it is empty, or belongs to the refresh that came after.
    const registered = (): boolean => this.inflight.get(cacheKey)?.job === job
    const job: Promise<T> = (async () => {
      try {
        const res = await this.conditionalGet(path, last?.etag, isExpected)
        // A `304` is only ever accepted in answer to an etag, so `last` is there.
        if (res.notModified && last) {
          if (this.storable(cacheKey, ticket)) {
            this.cache.confirm(cacheKey, version, Date.now())
            this.stored(cacheKey, ticket)
          }
          return last.value as T
        }
        if (this.storable(cacheKey, ticket)) {
          this.cache.set(cacheKey, res.value, { etag: res.etag, version }, Date.now())
          this.stored(cacheKey, ticket)
        }
        return res.value as T
      }
      catch (err) {
        // Definitive answer from the studio itself (deleted/forbidden): drop the
        // entry and surface it.
        if (isDefinitive(err)) {
          this.gone(cacheKey, ticket)
          throw err
        }
        // Anything else is transient: studio down, 5xx, timeout, rate limit,
        // network, a body that is not what this endpoint returns, or a 4xx from
        // whatever stands in front of the studio while it is gone. Serve a
        // cached value, even an expired one, and keep it.
        //
        // What the cache holds *now*, not only what it held when this request
        // left: every read that joined gets this same outcome, and one of them
        // may hold a value that was stored in the meantime (by a preview read,
        // say) while the read that started the request had none. Failing that
        // one with an error it had the content for is exactly what rule 1 forbids.
        const held = this.cache.stale(cacheKey) ?? last
        if (!held) throw err
        this.report({ during: 'read', key: cacheKey, error: err })
        return (this.storable(cacheKey, ticket) ? this.cache.backoff(cacheKey, held, Date.now()) : held).value as T
      }
      finally {
        if (registered()) this.inflight.delete(cacheKey)
      }
    })()
    this.inflight.set(cacheKey, { job, ticket })
    return job
  }

  /**
   * Hands an absorbed failure to `onError`, or without one warns once per
   * outage. Never throws and never leaves a rejection behind: a broken hook
   * must not turn a served read into an error, and an `async` hook whose own
   * work fails (an alert that cannot be delivered, during the very outage it
   * reports) must not become the unhandled rejection that stops the process.
   */
  private report(failure: StudioFailure): void {
    const first = !this.state.unreachable
    this.state.unreachable = true
    try {
      if (this.onError) {
        const outcome: unknown = this.onError(failure)
        if (isThenable(outcome)) outcome.then(undefined, () => {})
      }
      else if (first) {
        const reason = failure.error instanceof Error ? failure.error.message : String(failure.error)
        const what = failure.during === 'read' ? `could not refresh "${failure.key}"` : 'stamp check failed'
        console.warn(`[@justmade/client] ${what} (${reason}); cached content keeps being served.`)
      }
    }
    catch {
      /* the hook's own problem */
    }
  }

  /**
   * A GET that understands conditional requests: sends `If-None-Match` when an
   * etag is supplied, and reports a `304` as `notModified` rather than a value.
   *
   * The one place that decides what counts as an answer, for every read:
   *
   * - A `2xx` whose body fails `isExpected` is rejected, not returned. A
   *   maintenance page or a captive portal can answer `200` with JSON of its
   *   own; storing that would replace the last good value with nothing, at the
   *   very moment the studio is away.
   * - A `304` is only an answer to a request that sent an etag. Unasked for,
   *   it says "keep what you have" to a caller that has nothing, and there is
   *   no value to return or store.
   */
  private async conditionalGet(
    path: string,
    ifNoneMatch: string | undefined,
    isExpected: BodyCheck,
  ): Promise<{ notModified: boolean, value?: unknown, etag?: string }> {
    const url = `${this.baseUrl}/api/content${path}`
    return withTimeout(url, this.timeout, async (signal) => {
      const res = await this.fetchImpl(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          ...(ifNoneMatch ? { 'If-None-Match': ifNoneMatch } : {}),
          ...this.headers,
        },
        signal,
      })

      if (res.status === 304) {
        if (!ifNoneMatch) throw unexpectedBody(url)
        this.state.unreachable = false
        return { notModified: true, etag: res.headers.get('etag') ?? ifNoneMatch }
      }
      if (!res.ok) throw await this.toError(res)
      const etag = res.headers.get('etag') ?? undefined
      const value: unknown = res.status === 204 ? undefined : await res.json()
      if (!isExpected(value)) throw unexpectedBody(url)
      this.state.unreachable = false
      return { notModified: false, value, etag }
    })
  }

  private async request<T>(method: Method, path: string, body?: unknown, timeout = this.timeout): Promise<T> {
    const url = `${this.baseUrl}/api/content${path}`
    return withTimeout(url, timeout, async (signal) => {
      const res = await this.fetchImpl(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...this.headers,
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal,
      })

      if (!res.ok) throw await this.toError(res)
      if (res.status === 204) return undefined as T
      return (await res.json()) as T
    })
  }

  /** Parse a non-2xx response into a `JustmadeError`, preferring its message. */
  private async toError(res: Response): Promise<JustmadeError> {
    let message = res.statusText || `Request failed with status ${res.status}`
    let parsed: unknown
    try {
      parsed = await res.json()
      const m = parsed as { message?: unknown, statusMessage?: unknown }
      if (typeof m?.message === 'string') message = m.message
      else if (typeof m?.statusMessage === 'string') message = m.statusMessage
    } catch {
      /* non-JSON error body; keep the status text */
    }
    return new JustmadeError(message, res.status, parsed)
  }
}

/** Fluent, dataset-scoped view returned by `client.dataset()`. */
export class DatasetHandle<T = Record<string, unknown>> {
  constructor(
    private readonly client: JustmadeClient,
    private readonly nodeSlug: string,
    private readonly datasetSlug: string,
  ) {}

  list(opts?: ReadOptions): Promise<ContentRecord<T>[]> {
    return this.client.listRecords<T>(this.nodeSlug, this.datasetSlug, opts)
  }

  get(recordUid: string, opts?: ReadOptions): Promise<ContentRecord<T>> {
    return this.client.getRecord<T>(this.nodeSlug, this.datasetSlug, recordUid, opts)
  }

  create(data: Record<string, unknown>): Promise<ContentRecord<T>> {
    return this.client.createRecord<T>(this.nodeSlug, this.datasetSlug, data)
  }

  update(recordUid: string, data: Record<string, unknown>): Promise<ContentRecord<T>> {
    return this.client.updateRecord<T>(this.nodeSlug, this.datasetSlug, recordUid, data)
  }

  /** Clear cached reads for this dataset. */
  clearCache(): void {
    this.client.clearCache({ node: this.nodeSlug, dataset: this.datasetSlug })
  }
}

// ── Preview detection ─────────────────────────────────────────────────────────

/** Anything a framework might hand you that could carry the preview marker. */
export type PreviewInput
  = | string
    | URL
    | URLSearchParams
    | { url: string }
    | Record<string, string | string[] | undefined>
    | null
    | undefined

/**
 * True when the request was opened from a Justmade Studio surface preview, i.e. it
 * carries the `sl-preview` query parameter the studio appends to the iframe URL.
 */
export function isPreviewRequest(input: PreviewInput): boolean {
  if (!input) return false

  if (typeof input === 'string') {
    // Either a full URL or a bare query string ("?a=1" / "a=1").
    const query = input.includes('?') ? input.slice(input.indexOf('?') + 1) : input
    return new URLSearchParams(query).has(PREVIEW_PARAM)
  }
  if (input instanceof URLSearchParams) return input.has(PREVIEW_PARAM)
  if (input instanceof URL) return input.searchParams.has(PREVIEW_PARAM)
  if (typeof (input as { url?: unknown }).url === 'string') {
    return isPreviewRequest((input as { url: string }).url)
  }
  return Object.prototype.hasOwnProperty.call(input, PREVIEW_PARAM)
}

// ── Timeout ───────────────────────────────────────────────────────────────────

/**
 * Runs `run` with an abort signal that fires after `ms`, and rejects with a
 * `TimeoutError` at that moment whether or not `run` listens to the signal: a
 * custom `fetch` may ignore it. The timer spans the whole of `run`, so a studio
 * that sends headers and then stalls the body is caught too.
 *
 * The error is a plain `Error`, not a `JustmadeError`: the read path treats
 * anything without an HTTP status as transient and serves the cache.
 */
async function withTimeout<T>(url: string, ms: number, run: (signal?: AbortSignal) => Promise<T>): Promise<T> {
  if (ms <= 0) return run(undefined)

  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`Justmade Studio did not answer within ${ms}ms: ${url}`)
      err.name = 'TimeoutError'
      controller.abort(err)
      reject(err)
    }, ms)
  })

  try {
    return await Promise.race([run(controller.signal), expired])
  }
  finally {
    clearTimeout(timer)
  }
}

/**
 * The `timeout` option as a usable number of ms, `0` for none. `Infinity`, or
 * more than a timer can hold, means "no timeout" - handed to `setTimeout` as
 * it is, it would fire after 1 ms and fail every request.
 */
function normalizeTimeout(value: number | undefined): number {
  if (typeof value !== 'number' || Number.isNaN(value) || value < 0) return DEFAULT_TIMEOUT
  return value > MAX_TIMER ? 0 : value
}

/** `cache.waitForFresh` in ms, `Infinity` when a read should wait for the studio. */
function normalizeWait(value: number | false | undefined): number {
  if (value === false) return Infinity
  if (typeof value !== 'number' || Number.isNaN(value) || value < 0) return DEFAULT_WAIT_FOR_FRESH
  // More than a timer can hold is no budget at all: `within` already waits
  // such a value out, so it is made to mean `false` everywhere, in one place.
  return value > MAX_TIMER ? Infinity : value
}

type Settled<T> = { settled: true, value: T } | { settled: false }

/**
 * Waits on `promise` for at most `ms`. Past that it reports "not settled" and
 * lets the promise run on; a later rejection is swallowed here, as whoever
 * started the work deals with its outcome. A rejection within `ms` is thrown.
 */
async function within<T>(promise: Promise<T>, ms: number): Promise<Settled<T>> {
  if (ms > MAX_TIMER) return { settled: true, value: await promise }
  if (ms <= 0) {
    promise.catch(() => {})
    return { settled: false }
  }

  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<Settled<T>>((resolve) => {
    timer = setTimeout(() => resolve({ settled: false }), ms)
  })
  try {
    return await Promise.race([promise.then((value): Settled<T> => ({ settled: true, value })), late])
  }
  finally {
    clearTimeout(timer)
  }
}

// ── Response shape ────────────────────────────────────────────────────────────

/** Whether a value is a promise, or anything else that settles later. */
function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof (value as { then?: unknown } | null | undefined)?.then === 'function'
}

/** Whether a response body is what its endpoint returns. */
type BodyCheck = (body: unknown) => boolean

function isObject(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A body that is an object carrying `field`, with a value that passes `check`. */
function has(field: string, check: (value: unknown) => boolean): BodyCheck {
  return (body) => isObject(body) && field in (body as object) && check((body as Record<string, unknown>)[field])
}

/**
 * The error for a response its endpoint never gives: a `2xx` with a body of
 * another shape, or a `304` nobody asked for. A plain `Error` without a status,
 * so the read path treats it as transient and serves the cache.
 */
function unexpectedBody(url: string): Error {
  const err = new Error(`Justmade Studio answered with an unexpected response: ${url}`)
  err.name = 'UnexpectedResponseError'
  return err
}

// ── Cache-key + path helpers ──────────────────────────────────────────────────

/**
 * Whether an error status says "try again later" rather than "this is the
 * answer": server errors, request timeout (408) and rate limiting (429).
 */
function isTransientStatus(status: number): boolean {
  return status >= 500 || status === 408 || status === 429
}

/**
 * Whether a failed read is the studio's own definitive answer - this does not
 * exist, this key may not see it - rather than a sign that the studio could
 * not be reached. The only kind of failure that may cost a cached value.
 */
function isDefinitive(err: unknown): err is JustmadeError {
  return err instanceof JustmadeError && !isTransientStatus(err.status) && isStudioAnswer(err)
}

/**
 * Whether an error response was written by the studio, and not by something
 * answering in its place. While the studio container is gone (a redeploy, a
 * crash) the proxy in front of it answers for it, and often with a `404`:
 * Traefik's `404 page not found`, an HTML error page, a gateway's own JSON.
 * Taking that for "this record was deleted" would drop the very entry that
 * should carry the site through the outage.
 *
 * The studio's errors are JSON objects that restate their status
 * (`{ "statusCode": 404, "message": "..." }`); nothing else is trusted to be
 * the studio speaking. `status` is accepted next to `statusCode`, the name
 * newer server frameworks give the same field.
 */
function isStudioAnswer(err: JustmadeError): boolean {
  const body = err.body as { statusCode?: unknown, status?: unknown } | null | undefined
  if (typeof body !== 'object' || body === null) return false
  return body.statusCode === err.status || body.status === err.status
}

/**
 * Whether a failed stamp check says "this studio has no stamp route": its own
 * `404`, as an older server answers. Not the `404` of a proxy standing in for a
 * studio that is away - that one is an outage like any other.
 */
function isMissingRoute(err: unknown): boolean {
  return err instanceof JustmadeError && err.status === 404 && isStudioAnswer(err)
}

/**
 * Whether a failed write may have been stored all the same. Only an answered
 * 4xx rules it out: the request was refused. A timeout, a dropped connection or
 * a 5xx can each follow a write the studio did carry out.
 */
function writeMayHaveLanded(err: unknown): boolean {
  return !(err instanceof JustmadeError && err.status >= 400 && err.status < 500)
}

function datasetPath(nodeSlug: string, datasetSlug: string): string {
  return `/nodes/${encodeURIComponent(nodeSlug)}/datasets/${encodeURIComponent(datasetSlug)}/records`
}

/**
 * Maps a requested locale onto one the project is configured with, by the rule
 * the studio applies itself: the exact locale, else one in the same language
 * (`nl` or `nl-NL` for a configured `nl-BE`), else the project's fallback
 * locale. `undefined` means the project default, which is requested by sending
 * no locale at all.
 *
 * With several locales in one language and no exact match, the default locale
 * wins if it is among them, otherwise the first one listed.
 */
function matchLocale(requested: string, locales: ContentLocale[]): string | undefined {
  const canonical = (code: string): string => code.trim().toLowerCase().replace(/_/g, '-')
  const known = locales.filter((locale) => typeof locale?.code === 'string' && locale.code !== '')
  const wanted = canonical(requested)

  const exact = known.find((locale) => canonical(locale.code) === wanted)
  if (exact) return exact.code

  const language = wanted.split('-')[0]
  const related = known.filter((locale) => canonical(locale.code).split('-')[0] === language)
  const close = related.find((locale) => locale.isDefault) ?? related[0]
  if (close) return close.code

  return known.find((locale) => locale.isFallback)?.code
}

/** `?locale=xx` query suffix, or empty for the default locale. */
function localeQuery(locale?: string): string {
  return locale ? `?locale=${encodeURIComponent(locale)}` : ''
}

/** Locale cache-key suffix. `::<locale>` keeps each locale a distinct entry;
 *  the default locale has no suffix. `::` never collides with a slug. */
function localeKeySuffix(locale?: string): string {
  return locale ? `::${locale}` : ''
}

function recordsKey(nodeSlug: string, datasetSlug: string, locale?: string): string {
  return `records:${nodeSlug}/${datasetSlug}${localeKeySuffix(locale)}`
}

function recordKey(nodeSlug: string, datasetSlug: string, recordUid: string, locale?: string): string {
  return `record:${nodeSlug}/${datasetSlug}/${recordUid}${localeKeySuffix(locale)}`
}
