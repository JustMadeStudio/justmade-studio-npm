/**
 * A `CacheStore` that keeps its entries on disk as well as in memory, so a
 * restarted process still has the last good content - also when the studio is
 * down at that very moment.
 *
 * Node only (it uses `node:fs`), which is why it lives at its own entry point,
 * `@justmade/client/file-store`, and the main entry stays browser-safe.
 *
 * ```ts
 * import { createClient } from '@justmade/client'
 * import { FileCacheStore } from '@justmade/client/file-store'
 *
 * const studio = createClient({
 *   apiKey,
 *   cache: { store: new FileCacheStore({ dir: '/data/studio-cache' }) },
 * })
 * ```
 *
 * Reads come from memory; the disk is read once, when the store is created, and
 * written through on every change. One directory per site: cache keys do not
 * include the project or the API key, so two sites sharing a directory would
 * serve each other's content while the studio is unreachable.
 */
import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CacheEntry, CacheStore } from './cache'

export interface FileCacheStoreOptions {
  /** Directory for the cache files. Created when missing. Put it on a volume that survives a redeploy. */
  dir: string
  /** Soft cap on entries; oldest are evicted first, from memory and disk. Default `500`. */
  maxEntries?: number
  /**
   * Called when the disk cannot be read or written. The store then keeps
   * working from memory, like the default store. Default: one `console.warn`
   * per store, so a read-only volume is noticed without flooding the log.
   */
  onError?: (err: unknown) => void
}

/** On-disk shape. `v` leaves room to change it without misreading old files. */
interface StoredFile {
  v: 1
  key: string
  entry: CacheEntry
}

const SUFFIX = '.json'

/**
 * The only names this store reads, replaces or removes: the sha256 of a cache
 * key (see `fileOf`), and the temp file of a write to one. `dir` may hold other
 * files - a mistyped path can point at a project root - and those are never
 * touched, whatever their extension.
 */
const CACHE_FILE = /^[0-9a-f]{64}\.json$/
const TEMP_FILE = /^[0-9a-f]{64}\.json\.\d+(\.[0-9a-f]+)?\.tmp$/

/**
 * How old a temp file must be before a starting store takes it for an orphan.
 * A write takes milliseconds, so anything younger may be a write under way in
 * another process on the same directory: the old and the new container during
 * a redeploy, or the workers of a cluster.
 */
const TEMP_ORPHAN_MS = 60_000

export class FileCacheStore implements CacheStore {
  private readonly dir: string
  private readonly maxEntries: number
  private readonly onError: (err: unknown) => void
  /** Same order contract as `MemoryCacheStore`: oldest written first. */
  private readonly map = new Map<string, CacheEntry>()

  constructor(options: FileCacheStoreOptions) {
    if (!options?.dir) throw new Error('FileCacheStore: `dir` is required')
    this.dir = options.dir
    this.maxEntries = options.maxEntries ?? 500

    let warned = false
    this.onError = options.onError ?? ((err) => {
      if (warned) return
      warned = true
      console.warn(`[@justmade/client] file cache at ${this.dir} unusable, continuing in memory:`, err instanceof Error ? err.message : err)
    })

    this.load()
  }

  get(key: string): CacheEntry | undefined {
    return this.map.get(key)
  }

  set(key: string, entry: CacheEntry): void {
    this.map.delete(key)
    this.map.set(key, entry)
    this.write(key, entry)
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value
      if (oldest === undefined) break
      this.delete(oldest)
    }
  }

  delete(key: string): void {
    this.map.delete(key)
    this.remove(this.fileOf(key))
  }

  keys(): Iterable<string> {
    return this.map.keys()
  }

  clear(): void {
    this.map.clear()
    for (const name of this.list()) {
      if (CACHE_FILE.test(name)) this.remove(join(this.dir, name))
    }
  }

  // ── Disk ────────────────────────────────────────────────────────────────────

  /** File name per key: a hash, as keys hold `/` and `:` and may be long. */
  private fileOf(key: string): string {
    return join(this.dir, createHash('sha256').update(key).digest('hex') + SUFFIX)
  }

  /** Fills memory from disk, oldest file first so eviction order survives a restart. */
  private load(): void {
    try {
      mkdirSync(this.dir, { recursive: true })
    }
    catch (err) {
      this.fail(err)
      return
    }

    const found: { key: string, entry: CacheEntry, mtime: number }[] = []
    for (const name of this.list()) {
      const file = join(this.dir, name)
      // Left behind by a process killed between write and rename - unless it
      // is fresh, and then it belongs to a write that is still happening.
      if (TEMP_FILE.test(name)) {
        if (this.orphaned(file)) this.remove(file)
        continue
      }
      // Not one of ours: leave it exactly as it is.
      if (!CACHE_FILE.test(name)) continue
      try {
        const stored = JSON.parse(readFileSync(file, 'utf8')) as StoredFile
        if (stored?.v !== 1 || typeof stored.key !== 'string' || !stored.entry || file !== this.fileOf(stored.key)) {
          throw new Error('not a cache file')
        }
        found.push({ key: stored.key, entry: stored.entry, mtime: statSync(file).mtimeMs })
      }
      catch {
        // Ours by name but unreadable, or filed under another key: it can only
        // ever be a miss, so drop it.
        this.remove(file)
      }
    }

    found.sort((a, b) => a.mtime - b.mtime)
    for (const { key, entry } of found) this.map.set(key, entry)
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value
      if (oldest === undefined) break
      this.delete(oldest)
    }
  }

  /** Temp file plus rename, so a reader (or a crash) never sees half a file. */
  private write(key: string, entry: CacheEntry): void {
    const file = this.fileOf(key)
    // The random part keeps two processes apart that write the same key at the
    // same moment. The pid alone does not: in a container it is 1 for both.
    const tmp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
    try {
      const stored: StoredFile = { v: 1, key, entry }
      writeFileSync(tmp, JSON.stringify(stored))
      renameSync(tmp, file)
    }
    catch (err) {
      this.remove(tmp)
      this.fail(err)
    }
  }

  /**
   * Hands a disk problem to `onError`. Never throws and never leaves a rejection
   * behind: this runs inside a cache write, which runs inside a read, and a
   * hook that fails (or an `async` one whose own work fails) must not fail the
   * read or stop the process over a cache that merely fell back to memory.
   */
  private fail(err: unknown): void {
    try {
      const outcome: unknown = this.onError(err)
      if (typeof (outcome as { then?: unknown } | null | undefined)?.then === 'function') {
        (outcome as PromiseLike<unknown>).then(undefined, () => {})
      }
    }
    catch {
      /* the hook's own problem */
    }
  }

  /** Whether a temp file is old enough to have been abandoned. Unknown counts as "no". */
  private orphaned(file: string): boolean {
    try {
      return Date.now() - statSync(file).mtimeMs > TEMP_ORPHAN_MS
    }
    catch {
      return false
    }
  }

  private remove(file: string): void {
    try {
      rmSync(file, { force: true })
    }
    catch (err) {
      this.fail(err)
    }
  }

  private list(): string[] {
    try {
      return readdirSync(this.dir)
    }
    catch (err) {
      this.fail(err)
      return []
    }
  }
}
