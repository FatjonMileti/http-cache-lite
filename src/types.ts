import type { CacheStorage } from './storage/types.js';

/**
 * A single cached entry with all metadata required for TTL, LRU, tags,
 * ETag, Cache-Control, stale-while-revalidate and HTTP response replay.
 */
export interface CacheEntry<V = unknown> {
  /** The cached value. */
  value: V;
  /** Epoch millis when the entry was created. */
  createdAt: number;
  /** Epoch millis after which the entry is stale (or expired when no SWR window). */
  expiresAt: number;
  /** Epoch millis until which a stale entry may still be served. Omitted when SWR is disabled. */
  staleUntil?: number;
  /** Strong ETag for the value, when known. */
  etag?: string;
  /** Tags attached to this entry for group invalidation. */
  tags: string[];
  /** MIME type of a cached HTTP response body. */
  contentType?: string;
  /** HTTP status code of a cached response. */
  statusCode?: number;
  /** HTTP headers of a cached response (lower-cased names). */
  headers?: Record<string, string>;
  /** Approximate byte size of the entry (UTF-8 length for strings, Buffer length, else 0). */
  size: number;
}

/** Options accepted by {@link HttpCache.set}. */
export interface SetOptions {
  /** Per-entry TTL in milliseconds. Falls back to the cache-level default. */
  ttl?: number;
  /** Per-entry stale-while-revalidate window in milliseconds. Falls back to the cache default. */
  staleWhileRevalidate?: number;
  /** Tags attached to this entry. */
  tags?: string[];
  /** Optional pre-computed ETag stored alongside the entry. */
  etag?: string;
}

/** Options accepted by {@link HttpCache.getOrSet}. */
export interface GetOrSetOptions extends SetOptions {
  /**
   * Maximum time in milliseconds to wait for `factory` before rejecting
   * with a {@link TimeoutError}. No timeout when omitted.
   */
  timeout?: number;
}

/** Cache-level configuration. */
export interface HttpCacheOptions<V = unknown> {
  /** Default TTL in milliseconds for entries set without an explicit `ttl`. @default 60000 */
  ttl?: number;
  /** Default stale-while-revalidate window in milliseconds. @default 0 (disabled) */
  staleWhileRevalidate?: number;
  /** Maximum number of entries before LRU eviction kicks in. @default 1000 */
  maxSize?: number;
  /** Backing store. @default a new {@link MemoryStorage} */
  storage?: CacheStorage<string, CacheEntry<V>>;
  /** Called with background (SWR revalidation / event listener) errors. */
  onError?: (err: unknown) => void;
}

/** Cumulative cache counters. All counters only increase until {@link HttpCache.resetStats}. */
export interface CacheStats {
  hits: number;
  misses: number;
  sets: number;
  evictions: number;
  expirations: number;
  staleHits: number;
}

export type CacheEventName =
  'hit' | 'miss' | 'set' | 'delete' | 'eviction' | 'expire' | 'stale' | 'error';

export interface CacheEventPayload {
  key: string;
  entry?: CacheEntry;
  error?: unknown;
}

export type CacheEventHandler = (payload: CacheEventPayload) => void;
