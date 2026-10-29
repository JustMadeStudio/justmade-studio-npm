# @justmade/client

Typed client for the Justmade Studio **content API**. Read and write a project's
node datasets from any website or app: headless-CMS style, and beyond.

Your site talks to project **nodes** over a small, key-authenticated REST
surface (`/api/content/*`). A **project API key** (`slk_...`) grants read and/or
write access to specific nodes and datasets. This package wraps that surface in
a fully typed client with built-in read caching.

- Zero dependencies, works in Node 18+ and the browser (the API sends permissive CORS).
- Dual ESM / CommonJS build, full TypeScript types.
- Read caching with TTL, automatic invalidation on writes, and a `clearCache()` method.

## Install

```bash
npm install @justmade/client
```

## Quick start

```ts
import { createClient } from '@justmade/client'

const studio = createClient({
  apiKey: process.env.JUSTMADE_STUDIO_API_KEY!, // slk_...
  // baseUrl defaults to https://studio.justmade.be;
  // set it only for a self-hosted server:
  // baseUrl: 'https://studio.example.com',
})

// Discover what this key can reach.
const { nodes } = await studio.schema()

// List records from a dataset.
const posts = await studio.listRecords('blog', 'posts')

// Or use the fluent, typed handle.
interface Post { title: string, slug: string, body: string, published: boolean }
const blog = studio.dataset<Post>('blog', 'posts')

const all = await blog.list()
const one = await blog.get('rec_abc123')
const created = await blog.create({ title: 'Hello', slug: 'hello', body: '...', published: true })
const updated = await blog.update('rec_abc123', { published: false })
```

Each record is `{ uid, data, createdAt, updatedAt }`, where `data` is keyed by
field slug with references (files, referenced records) already inflated.

## Authentication & scopes

Pass the project API key as `apiKey`. A key's reach is the union of its per-node
scopes (read and/or write, optionally narrowed to specific datasets). Calls
outside the key's scope throw a `JustmadeError` with `status` 403; an
unknown node/dataset/record throws 404.

```ts
import { JustmadeError } from '@justmade/client'

try {
  await studio.getRecord('blog', 'posts', 'nope')
} catch (err) {
  if (err instanceof JustmadeError && err.isNotFound) {
    // handle missing record
  }
}
```

## Introspection

`schema()` returns every node the key can reach, the datasets within, each
dataset's field schema, and `canRead` / `canWrite` flags so a site can adapt to
its access without hardcoding slugs.

```ts
for (const node of await studio.nodes()) {
  for (const ds of node.datasets) {
    console.log(node.slug, ds.slug, ds.canWrite ? '(writable)' : '(read-only)')
  }
}
```

## Localisation

If the project has multiple languages, request one on reads. Untranslated fields
fall back to the project's default (source) language automatically, so a
partly-translated site never shows blanks.

```ts
// List the languages the project offers (default first).
const locales = await studio.locales()
// [{ code: 'nl-BE', label: 'Dutch (Belgium)', isDefault: true, isFallback: false },
//  { code: 'en-US', label: 'English (US)', isDefault: false, isFallback: true }]

// A client-wide default locale for every read:
const en = createClient({ apiKey: 'slk_...', locale: 'en-US' })
const posts = await en.dataset('blog', 'posts').list()

// ...or per call, overriding the client locale:
const fr = await studio.listRecords('blog', 'posts', { locale: 'fr-BE' })
const one = await studio.getRecord('blog', 'posts', 'R12AB34C', { locale: 'nl-BE' })
```

Each locale is cached separately, so switching languages never serves the wrong
one. Pass `locale: ''` on a call to force the project default even when a
client-level `locale` is set.

### How a requested locale resolves

You can pass the visitor's **detected** locale verbatim (e.g. from
`Accept-Language`); the studio resolves it server-side, so you never have to map
it to a configured code yourself:

1. **Exact match** first (`nl-BE` -> `nl-BE`).
2. **Base-language match**: `nl` and `nl-NL` resolve to a configured `nl-BE`;
   `en`, `en-GB`, `en-AU` resolve to `en-US`. So the project only needs one
   regional variant per language.
3. **No match** (a language the project doesn't offer, e.g. a German visitor):
   the project's **fallback** locale is served if one is set (the entry with
   `isFallback: true`), otherwise the default. This lets a Dutch-authored site
   (default `nl-BE`) show English to unknown languages while Dutch visitors still
   get the source.
4. **No locale sent** (you omit it): the default/source language.

Within the chosen language, any field that isn't translated yet falls back to
the default language for that field, never a blank.

```ts
// Framework example: forward whatever the visitor asked for.
const accept = request.headers.get('accept-language')?.split(',')[0] // e.g. 'de-DE'
const posts = await studio.listRecords('blog', 'posts', { locale: accept })
// German isn't offered -> the project's fallback (say en-US) comes back.
```

## Saved queries

Run a server-defined query (`queries.<slug>`) and get its result. The `shape`
tells you whether `value` is a `collection`, a `single` record, or a scalar
`value`.

```ts
const result = await studio.query('featured-posts')
if (result.shape === 'collection') {
  // result.value is an array of records
}
```

## Caching

Reads (`schema`, `listRecords`, `getRecord`, `query`) are cached in memory and
kept fresh by **conditional revalidation** - the site stays in sync with the
studio without you doing anything, and without a "publish" step.

How it stays fresh, cheaply:

- The studio publishes a tiny per-project **stamp** (`GET /api/content/version`)
  that changes on every content edit. The client checks it at most once every
  minute (one small request, no matter how many reads).
- While the stamp is unchanged, reads are served straight from cache - zero
  network.
- When the stamp moves, the affected read is **revalidated** with its `ETag`
  (`If-None-Match`): the studio answers `304 Not Modified` (keep the cached
  value, no transfer) or `200` with the new content. So a change to one dataset
  only refetches that dataset; everything else stays cached on a `304`.

What this buys you:

- **Edits go live on their own, within about a minute** for public visitors
  (instantly in a surface preview) - a safe promise to a client is "live within
  10 minutes". No button, no
  webhook, no cache to clear.
- **Resilient:** if the studio is unreachable, the last good value keeps being
  served for as long as the outage lasts, even past its TTL. That includes a
  `5xx`, `408` or `429`; any other `4xx` (e.g. a `404` for a deleted record,
  or a `401`/`403`) is definitive and surfaced as an error rather than masked. Only a read with nothing cached fails, as does a preview or
  `cache: false` read, which never falls back. After a failed attempt an
  entry waits one `revalidate` interval (1 minute if revalidation is off)
  before trying again, so reads don't each wait on the unreachable studio.
- The **TTL (7 days default)** is not the refresh interval either: it is how
  long an entry is served without asking the studio when the stamp gives no
  reason to. After that the next read refetches it (a `304` if nothing
  changed), and if the studio is down it falls back to the expired value.

Every knob is overridable:

```ts
const studio = createClient({
  apiKey, baseUrl,
  // defaults: ttl 7d, revalidate 60s (stamp check), maxEntries 500
  cache: { ttl: 604_800_000, revalidate: 60_000, maxEntries: 1000 },
})

// Never expire - only a stamp change makes an entry ask the studio again:
createClient({ apiKey, baseUrl, cache: { ttl: 0 } })

// Pure TTL, never check the stamp (content can be up to `ttl` stale while the
// studio is reachable; during an outage the last good value is served):
createClient({ apiKey, baseUrl, cache: { revalidate: false } })

// Disable caching entirely (every read hits the studio live):
createClient({ apiKey, baseUrl, cache: false })

// Bypass the cache for a single call (the fresh value still refreshes it):
await studio.listRecords('blog', 'posts', { cache: false })
```

> Caching is safe to leave on everywhere, including local/dev frontends: because
> every read revalidates against the stamp, a cached dev site is still always in
> sync. There is no "dev bypasses, production caches" split to manage.

### Preview requests

When the studio loads your site inside a surface preview it appends
`?sl-preview=…` to the URL. Pass the request through `forRequest()` and those
loads skip the cache completely, so an editor always sees their change
immediately:

```ts
// Next.js app router
export default async function Page({ searchParams }) {
  const studioForThisRequest = studio.forRequest(await searchParams)
  const posts = await studioForThisRequest.dataset('blog', 'posts').list()
}

// Anything with a Request object
const posts = await studio.forRequest(request).dataset('blog', 'posts').list()
```

`forRequest()` accepts a `Request`, a URL string or `URL`, `URLSearchParams`, or
a plain searchParams object, and returns this same client unchanged when the
marker is absent - so it is safe to call on every request. Preview reads share
the normal cache and refresh it, they do not maintain a second copy.

One caveat: this only bypasses **this client's** cache. If your page also sits
behind a CDN or a framework data cache, that layer needs the same treatment or
the editor still sees a stale page. In Next.js:

```ts
import { isPreviewRequest } from '@justmade/client'

export const dynamic = 'force-dynamic' // or, per fetch: cache: 'no-store'
```

### Clearing the cache

```ts
studio.clearCache()                               // everything
studio.clearCache('blog')                         // one node
studio.clearCache({ node: 'blog', dataset: 'posts' }) // one dataset
studio.dataset('blog', 'posts').clearCache()      // same, fluent
```

Bring your own store (share a cache across instances, or persist it) by
implementing `CacheStore` and passing it as `cache.store`.

## API

| Method | Description |
| --- | --- |
| `schema(opts?)` | Full reachable content shape (`{ nodes }`). |
| `nodes(opts?)` | Shortcut for `schema().nodes`. |
| `listRecords<T>(node, dataset, opts?)` | All records in a dataset. |
| `getRecord<T>(node, dataset, uid, opts?)` | One record by uid. |
| `createRecord<T>(node, dataset, data)` | Create a record (needs write scope). |
| `updateRecord<T>(node, dataset, uid, data)` | Merge-patch a record (needs write scope). |
| `query<V>(slug, opts?)` | Run a saved query. |
| `dataset<T>(node, dataset)` | Fluent handle: `.list() .get() .create() .update() .clearCache()`. |
| `clearCache(scope?)` | Clear all, one node, or one dataset. |
| `forRequest(req)` | Cache-bypassing view of this client for studio preview requests. |
| `isPreview` | Whether this client came from a preview request. |

`opts` is `{ cache?: boolean }`. All read methods accept a row type parameter
`<T>` for `record.data`.

## Node < 18

Global `fetch` is required. On older runtimes, pass one:

```ts
import fetch from 'node-fetch'
createClient({ apiKey, baseUrl, fetch: fetch as unknown as typeof globalThis.fetch })
```

## License

MIT
