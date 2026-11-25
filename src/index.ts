export { JustmadeClient, DatasetHandle, DEFAULT_BASE_URL, PREVIEW_PARAM, isPreviewRequest } from './client'
export type { JustmadeClientOptions, ReadOptions, PreviewInput, StudioFailure } from './client'
export { JustmadeError } from './errors'
export { ContentCache, MemoryCacheStore } from './cache'
export type { CacheOptions, CacheStore, CacheEntry } from './cache'
export type {
  ContentSchema,
  SchemaNode,
  SchemaDataset,
  SchemaField,
  FieldKind,
  FieldType,
  ContentRecord,
  ContentLocale,
  QueryResult,
  QueryShape,
} from './types'

import { JustmadeClient, type JustmadeClientOptions } from './client'

/** Convenience factory: `createClient({ apiKey, baseUrl })`. */
export function createClient(options: JustmadeClientOptions): JustmadeClient {
  return new JustmadeClient(options)
}
