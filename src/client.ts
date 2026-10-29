import { ContentCache, type CacheOptions } from './cache'
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
  /** Not readonly: `forRequest` hands its clone the SAME cache instance. */
  private cache: ContentCache
  private versionTracker: VersionTracker
  /** `false` on a preview-scoped clone, so reads bypass the cache by default. */
  private readDefault: boolean
  /** Client-level default locale for reads (undefined = project default). */
  private readonly locale?: string

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

    const cacheOpt = options.cache
    const cacheOptions: CacheOptions
      = cacheOpt === false ? { enabled: false }
        : cacheOpt === true || cacheOpt === undefined ? {}
          : cacheOpt
    this.cache = new ContentCache(cacheOptions)

    const revalidate = cacheOptions.enabled === false || cacheOptions.revalidate === false
      ? 0
      : cacheOptions.revalidate ?? 60_000
    this.versionTracker = new VersionTracker(
      async () => (await this.request<{ version: string }>('GET', '/version')).version,
      revalidate,
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

    const clone = new JustmadeClient({
      apiKey: this.apiKey,
      baseUrl: this.baseUrl,
      fetch: this.fetchImpl,
      headers: this.headers,
      locale: this.locale,
      preview: true,
    })
    // Share the cache and the version tracker: the preview must refresh what the
    // public site reads, not maintain a second universe of its own.
    clone.cache = this.cache
    clone.versionTracker = this.versionTracker
    return clone
  }

  /** Whether this client bypasses the cache (i.e. came from a preview request). */
  get isPreview(): boolean {
    return !this.readDefault
  }

  // ── Introspection ─────────────────────────────────────────────────────────

  /** The full content shape this key can reach: nodes, datasets, field schemas. */
  async schema(opts?: ReadOptions): Promise<ContentSchema> {
    return this.cachedGet<ContentSchema>('schema', '/schema', opts)
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
    const res = await this.cachedGet<{ locales: ContentLocale[] }>('locales', '/locales', opts)
    return res.locales
  }

  /** Resolve the locale for a read: per-call override, else the client default. */
  private resolveLocale(opts?: ReadOptions): string | undefined {
    const l = opts && 'locale' in opts ? opts.locale : this.locale
    return l || undefined
  }

  // ── Records ───────────────────────────────────────────────────────────────

  /** List every record in a dataset (references inflated). Requires read scope. */
  async listRecords<T = Record<string, unknown>>(
    nodeSlug: string,
    datasetSlug: string,
    opts?: ReadOptions,
  ): Promise<ContentRecord<T>[]> {
    const locale = this.resolveLocale(opts)
    const res = await this.cachedGet<{ records: ContentRecord<T>[] }>(
      recordsKey(nodeSlug, datasetSlug, locale),
      datasetPath(nodeSlug, datasetSlug) + localeQuery(locale),
      opts,
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
    const locale = this.resolveLocale(opts)
    const res = await this.cachedGet<{ record: ContentRecord<T> }>(
      recordKey(nodeSlug, datasetSlug, recordUid, locale),
      `${datasetPath(nodeSlug, datasetSlug)}/${encodeURIComponent(recordUid)}${localeQuery(locale)}`,
      opts,
    )
    return res.record
  }

  /** Create a record. Requires write scope. Invalidates cached reads of the dataset. */
  async createRecord<T = Record<string, unknown>>(
    nodeSlug: string,
    datasetSlug: string,
    data: Record<string, unknown>,
  ): Promise<ContentRecord<T>> {
    const res = await this.request<{ record: ContentRecord<T> }>(
      'POST',
      datasetPath(nodeSlug, datasetSlug),
      { data },
    )
    this.invalidateDataset(nodeSlug, datasetSlug)
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
    const res = await this.request<{ record: ContentRecord<T> }>(
      'PATCH',
      `${datasetPath(nodeSlug, datasetSlug)}/${encodeURIComponent(recordUid)}`,
      { data },
    )
    this.invalidateDataset(nodeSlug, datasetSlug)
    this.cache.delete(recordKey(nodeSlug, datasetSlug, recordUid))
    return res.record
  }

  // -- Queries --

  /** Run a saved query (`queries.<slug>`) and return its result. Requires read scope. */
  async query<V = unknown>(querySlug: string, opts?: ReadOptions): Promise<QueryResult<V>> {
    return this.cachedGet<QueryResult<V>>(
      `query:${querySlug}`,
      `/queries/${encodeURIComponent(querySlug)}`,
      opts,
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
      return
    }
    if (typeof scope === 'string') {
      this.cache.deletePrefix(`records:${scope}/`)
      this.cache.deletePrefix(`record:${scope}/`)
      return
    }
    if (scope.dataset) {
      this.invalidateDataset(scope.node, scope.dataset)
    } else {
      this.cache.deletePrefix(`records:${scope.node}/`)
      this.cache.deletePrefix(`record:${scope.node}/`)
    }
  }

  /** Drop cached record reads for a dataset (every locale), plus all query
   *  results (which may aggregate it). */
  private invalidateDataset(nodeSlug: string, datasetSlug: string): void {
    // Default-locale list key + every `::<locale>` variant of it.
    this.cache.delete(recordsKey(nodeSlug, datasetSlug))
    this.cache.deletePrefix(`${recordsKey(nodeSlug, datasetSlug)}::`)
    // All single-record keys under the dataset (every uid, every locale).
    this.cache.deletePrefix(`${recordKey(nodeSlug, datasetSlug, '')}`)
    this.cache.deletePrefix('query:')
  }

  // ── Transport ───────────────────────────────────────────────────────────────

  /**
   * The read path, with conditional revalidation.
   *
   * Steady state (project stamp unchanged since we last confirmed this entry):
   * served straight from cache, zero network. After a content change the stamp
   * moves, so the entry is revalidated once with `If-None-Match` - a `304` keeps
   * the cached value, a `200` replaces it - and then it is fast again. If the
   * studio is unreachable, the last good value is served rather than failing,
   * even once its TTL has run out (unless it is a definitive 4xx like a deleted
   * record).
   */
  private async cachedGet<T>(cacheKey: string, path: string, opts?: ReadOptions): Promise<T> {
    const useCache = opts?.cache ?? this.readDefault

    // Preview / explicit bypass: always fetch fresh, but still refresh the shared
    // cache so real visitors benefit from the warm entry.
    if (!useCache) {
      const res = await this.conditionalGet(path)
      this.cache.set(cacheKey, res.value, { etag: res.etag, version: this.versionTracker.current() ?? undefined }, Date.now())
      return res.value as T
    }

    // Cheap, throttled: at most one tiny stamp request per `revalidate` window.
    await this.versionTracker.refresh(Date.now())
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
    try {
      const res = await this.conditionalGet(path, last?.etag)
      if (res.notModified && last) {
        this.cache.confirm(cacheKey, version, Date.now())
        return last.value as T
      }
      this.cache.set(cacheKey, res.value, { etag: res.etag, version }, Date.now())
      return res.value as T
    }
    catch (err) {
      // Definitive answer (deleted/forbidden): drop the entry and surface it.
      if (err instanceof JustmadeError && !isTransientStatus(err.status)) {
        this.cache.delete(cacheKey)
        throw err
      }
      // Transient (studio down, 5xx, timeout, rate limit, network): serve the
      // last good value, even an expired one. With nothing cached at all, the
      // error propagates - but leaves the cache alone, as a concurrent read may
      // have filled it since.
      if (!last) throw err
      return this.cache.backoff(cacheKey, last, Date.now()).value as T
    }
  }

  /**
   * A GET that understands conditional requests: sends `If-None-Match` when an
   * etag is supplied, and reports a `304` as `notModified` rather than a value.
   */
  private async conditionalGet(
    path: string,
    ifNoneMatch?: string,
  ): Promise<{ notModified: boolean, value?: unknown, etag?: string }> {
    const res = await this.fetchImpl(`${this.baseUrl}/api/content${path}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        ...(ifNoneMatch ? { 'If-None-Match': ifNoneMatch } : {}),
        ...this.headers,
      },
    })

    if (res.status === 304) return { notModified: true, etag: res.headers.get('etag') ?? ifNoneMatch ?? undefined }
    if (!res.ok) throw await this.toError(res)
    const etag = res.headers.get('etag') ?? undefined
    if (res.status === 204) return { notModified: false, value: undefined, etag }
    return { notModified: false, value: await res.json(), etag }
  }

  private async request<T>(method: Method, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}/api/content${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...this.headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })

    if (!res.ok) throw await this.toError(res)
    if (res.status === 204) return undefined as T
    return res.json() as Promise<T>
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

// ── Cache-key + path helpers ──────────────────────────────────────────────────

/**
 * Whether an error status says "try again later" rather than "this is the
 * answer": server errors, request timeout (408) and rate limiting (429).
 */
function isTransientStatus(status: number): boolean {
  return status >= 500 || status === 408 || status === 429
}

function datasetPath(nodeSlug: string, datasetSlug: string): string {
  return `/nodes/${encodeURIComponent(nodeSlug)}/datasets/${encodeURIComponent(datasetSlug)}/records`
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
