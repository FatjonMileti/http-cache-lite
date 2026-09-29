import { InvalidOptionError, TimeoutError } from './errors.js';
import { MemoryStorage } from './storage/memory.js';
import type { CacheStorage } from './storage/types.js';
import type {
  CacheEntry,
  CacheEventHandler,
  CacheEventName,
  CacheStats,
  GetOrSetOptions,
  HttpCacheOptions,
  SetOptions,
} from './types.js';
import { assertValidTtl, byteSize, dedupeStrings } from './utils/hash.js';

const DEFAULT_TTL_MS = 60_000;
const DEFAULT_MAX_SIZE = 1_000;

function validateOptions(options: HttpCacheOptions<never>): {
  ttl: number;
  staleWhileRevalidate: number;
  maxSize: number;
} {
  const ttl = options.ttl ?? DEFAULT_TTL_MS;
  const staleWhileRevalidate = options.staleWhileRevalidate ?? 0;
  const maxSize = options.maxSize ?? DEFAULT_MAX_SIZE;
  assertValidTtl(ttl, 'ttl');
  assertValidTtl(staleWhileRevalidate, 'staleWhileRevalidate');
  if (typeof maxSize !== 'number' || !Number.isInteger(maxSize) || maxSize < 1) {
    throw new InvalidOptionError(
      `maxSize must be a positive integer, received: ${String(maxSize)}`,
    );
  }
  return { ttl, staleWhileRevalidate, maxSize };
}

function validateTags(tags: readonly string[] | undefined): string[] {
  if (tags === undefined) {
    return [];
  }
  if (!Array.isArray(tags)) {
    throw new InvalidOptionError('tags must be an array of strings');
  }
  const cleaned = tags.filter((t) => typeof t === 'string' && t.length > 0);
  if (cleaned.length !== tags.length) {
    throw new InvalidOptionError('tags must be non-empty strings');
  }
  return dedupeStrings(cleaned);
}

/**
 * Framework-independent in-memory cache with TTL, LRU eviction, tags,
 * stale-while-revalidate and single-flight request deduplication.
 *
 * All methods are async because pluggable storage backends may be async;
 * the default {@link MemoryStorage} simply resolves immediately.
 *
 * Ordering guarantees:
 * - `get` / `set` / `delete` are O(1) amortized (no full-cache scans).
 * - Expiration is lazy: entries are checked on access, never by sweeping.
 * - Tag invalidation uses a tag → keys index (O(matched entries)).
 */
export class HttpCache<K extends string = string, V = unknown> {
  private readonly ttl: number;
  private readonly staleWhileRevalidate: number;
  private readonly maxSize: number;
  private readonly storage: CacheStorage<K, CacheEntry<V>>;
  private readonly onError?: (err: unknown) => void;

  /** Access order for LRU: first key = least recently used. */
  private readonly order = new Map<K, true>();
  /** Tag → keys index for O(matched) invalidation. */
  private readonly tagIndex = new Map<string, Set<K>>();
  /** In-flight factory promises for stampede protection. */
  private readonly pending = new Map<K, Promise<V>>();
  /** Keys currently being revalidated in the background (SWR). */
  private readonly revalidating = new Set<K>();
  private readonly listeners = new Map<CacheEventName, Set<CacheEventHandler>>();

  private statsState: CacheStats = {
    hits: 0,
    misses: 0,
    sets: 0,
    evictions: 0,
    expirations: 0,
    staleHits: 0,
  };

  public constructor(options: HttpCacheOptions<V> = {}) {
    const validated = validateOptions(options as HttpCacheOptions<never>);
    this.ttl = validated.ttl;
    this.staleWhileRevalidate = validated.staleWhileRevalidate;
    this.maxSize = validated.maxSize;
    this.storage = options.storage ?? new MemoryStorage<K, CacheEntry<V>>();
    this.onError = options.onError;
    this.onError = options.onError;
  }

  // ---------------------------------------------------------------- events

  /** Subscribe to a cache event. Returns an unsubscribe function. */
  public on(event: CacheEventName, handler: CacheEventHandler): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(handler);
    return () => {
      set.delete(handler);
    };
  }

  /** Remove a previously registered handler (or all handlers for the event). */
  public off(event: CacheEventName, handler?: CacheEventHandler): void {
    if (!handler) {
      this.listeners.delete(event);
      return;
    }
    const set = this.listeners.get(event);
    if (set) {
      set.delete(handler);
    }
  }

  private emit(event: CacheEventName, key: K, entry?: CacheEntry<V>, error?: unknown): void {
    const set = this.listeners.get(event);
    if (!set || set.size === 0) {
      return;
    }
    for (const handler of [...set]) {
      try {
        handler({ key, entry, error });
      } catch (err) {
        if (event !== 'error') {
          this.reportError(err);
        }
      }
    }
  }

  private reportError(err: unknown): void {
    this.emit('error', '' as K, undefined, err);
    if (this.onError) {
      try {
        this.onError(err);
      } catch {
        // Never let error-reporting paths throw.
      }
    }
  }

  // ------------------------------------------------------------- internals

  private touch(key: K): void {
    // Map preserves insertion order: delete + re-insert moves key to MRU.
    this.order.delete(key);
    this.order.set(key, true);
  }

  private untrack(key: K, entry: CacheEntry<V> | undefined): void {
    this.order.delete(key);
    if (entry) {
      for (const tag of entry.tags) {
        const set = this.tagIndex.get(tag);
        if (set) {
          set.delete(key);
          if (set.size === 0) {
            this.tagIndex.delete(tag);
          }
        }
      }
    }
  }

  private indexTags(key: K, tags: readonly string[]): void {
    for (const tag of tags) {
      let set = this.tagIndex.get(tag);
      if (!set) {
        set = new Set();
        this.tagIndex.set(tag, set);
      }
      set.add(key);
    }
  }

  private async removeEntry(key: K, entry: CacheEntry<V> | undefined): Promise<void> {
    this.untrack(key, entry);
    await this.storage.delete(key);
  }

  /** Evict least-recently-used entries until under capacity. */
  private async evictIfNeeded(): Promise<void> {
    while (this.order.size >= this.maxSize) {
      const lru = this.order.keys().next();
      if (lru.done) {
        break;
      }
      const key = lru.value;
      const entry = await this.storage.get(key);
      await this.removeEntry(key, entry);
      this.statsState.evictions += 1;
      this.emit('eviction', key, entry ?? undefined);
    }
  }

  private resolveTtl(options?: SetOptions): { ttl: number; swr: number } {
    const ttl = options?.ttl ?? this.ttl;
    assertValidTtl(ttl, 'ttl');
    const swr = options?.staleWhileRevalidate ?? this.staleWhileRevalidate;
    assertValidTtl(swr, 'staleWhileRevalidate');
    return { ttl, swr };
  }

  // ------------------------------------------------------------ public API

  /**
   * Resolve with the full cache entry (fresh or servable-stale), or
   * `undefined` when missing or fully expired. Refreshes LRU recency and
   * records hit / stale statistics just like {@link get}.
   *
   * Useful for HTTP layers that need entry metadata (headers, ETag, status)
   * in addition to the value.
   */
  public async getEntry(key: K): Promise<CacheEntry<V> | undefined> {
    return (await this.readEntry(key, true)) ?? undefined;
  }

  private async readEntry(key: K, countMiss: boolean): Promise<CacheEntry<V> | undefined> {
    const entry = await this.storage.get(key);
    if (!entry) {
      if (countMiss) {
        this.statsState.misses += 1;
        this.emit('miss', key);
      }
      return undefined;
    }
    const now = Date.now();
    const staleUntil = entry.staleUntil ?? entry.expiresAt;
    if (now > staleUntil) {
      await this.removeEntry(key, entry);
      this.statsState.expirations += 1;
      if (countMiss) {
        this.statsState.misses += 1;
      }
      this.emit('expire', key, entry);
      if (countMiss) {
        this.emit('miss', key);
      }
      return undefined;
    }
    this.touch(key);
    if (now > entry.expiresAt) {
      this.statsState.staleHits += 1;
      this.emit('stale', key, entry);
    } else {
      this.statsState.hits += 1;
      this.emit('hit', key, entry);
    }
    return entry;
  }

  /** Resolve with the cached value, or `undefined` on miss / expiry. Stale entries are returned. */
  public async get(key: K): Promise<V | undefined> {
    const entry = await this.readEntry(key, true);
    return entry?.value;
  }

  /** Store a value with optional per-entry TTL / SWR window / tags. */
  public async set(key: K, value: V, options: SetOptions = {}): Promise<void> {
    const { ttl, swr } = this.resolveTtl(options);
    const tags = validateTags(options.tags);
    const now = Date.now();
    const previous = await this.storage.get(key);
    if (previous) {
      this.untrack(key, previous);
    } else {
      await this.evictIfNeeded();
    }
    const entry: CacheEntry<V> = {
      value,
      createdAt: now,
      expiresAt: now + ttl,
      tags,
      size: byteSize(value),
    };
    if (swr > 0) {
      entry.staleUntil = now + ttl + swr;
    }
    if (options.etag !== undefined) {
      if (typeof options.etag !== 'string' || options.etag.length === 0) {
        throw new InvalidOptionError('etag must be a non-empty string');
      }
      entry.etag = options.etag;
    }
    await this.storage.set(key, entry);
    this.order.set(key, true);
    this.indexTags(key, tags);
    this.statsState.sets += 1;
    this.emit('set', key, entry);
  }

  /** Resolve `true` when a live (fresh or servable-stale) entry exists. Does not affect LRU order. */
  public async has(key: K): Promise<boolean> {
    const entry = await this.storage.get(key);
    if (!entry) {
      return false;
    }
    const now = Date.now();
    const staleUntil = entry.staleUntil ?? entry.expiresAt;
    if (now > staleUntil) {
      await this.removeEntry(key, entry);
      this.statsState.expirations += 1;
      this.emit('expire', key, entry);
      return false;
    }
    return true;
  }

  /** Delete an entry. Resolves `true` when an entry was removed. */
  public async delete(key: K): Promise<boolean> {
    this.pending.delete(key);
    const entry = await this.storage.get(key);
    if (!entry && !(await this.storage.has(key))) {
      return false;
    }
    await this.removeEntry(key, entry ?? undefined);
    this.emit('delete', key, entry ?? undefined);
    return true;
  }

  /** Alias for {@link delete}. */
  public async invalidate(key: K): Promise<boolean> {
    return this.delete(key);
  }

  /**
   * Delete every entry carrying `tag`. Resolves with the number of
   * invalidated entries. Uses the tag index — no full-cache scan.
   */
  public async invalidateByTag(tag: string): Promise<number> {
    if (typeof tag !== 'string' || tag.length === 0) {
      throw new InvalidOptionError('tag must be a non-empty string');
    }
    const keys = this.tagIndex.get(tag);
    if (!keys || keys.size === 0) {
      return 0;
    }
    let count = 0;
    for (const key of [...keys]) {
      const entry = await this.storage.get(key);
      await this.removeEntry(key, entry);
      this.emit('delete', key, entry ?? undefined);
      count += 1;
    }
    return count;
  }

  /** Remove all entries (storage + indexes). Statistics are preserved. */
  public async clear(): Promise<void> {
    await this.storage.clear();
    this.order.clear();
    this.tagIndex.clear();
    this.pending.clear();
    this.revalidating.clear();
  }

  /** Number of entries currently tracked. */
  public async size(): Promise<number> {
    return this.storage.size();
  }

  /** Snapshot of cumulative counters. */
  public stats(): CacheStats {
    return { ...this.statsState };
  }

  /** Reset all counters to zero. */
  public resetStats(): void {
    this.statsState = { hits: 0, misses: 0, sets: 0, evictions: 0, expirations: 0, staleHits: 0 };
  }

  /**
   * Read-through helper with stampede protection: concurrent calls for the
   * same missing key share a single `factory` invocation.
   *
   * - Fresh entries resolve immediately (no factory call).
   * - Stale entries resolve immediately with the stale value while a single
   *   background revalidation refreshes the entry.
   * - Missing/expired entries trigger exactly one factory call; every
   *   waiter receives the same result. Factory rejections propagate to all
   *   waiters and are never cached or wrapped.
   */
  public async getOrSet(
    key: K,
    factory: () => Promise<V> | V,
    options: GetOrSetOptions = {},
  ): Promise<V> {
    if (typeof factory !== 'function') {
      throw new InvalidOptionError('factory must be a function');
    }
    if (options.timeout !== undefined) {
      const t = options.timeout;
      if (typeof t !== 'number' || !Number.isFinite(t) || t < 0) {
        throw new InvalidOptionError(
          `timeout must be a finite number >= 0, received: ${String(t)}`,
        );
      }
    }

    const entry = await this.storage.get(key);
    const now = Date.now();
    if (entry) {
      const staleUntil = entry.staleUntil ?? entry.expiresAt;
      if (now <= entry.expiresAt) {
        this.touch(key);
        this.statsState.hits += 1;
        this.emit('hit', key, entry);
        return entry.value;
      }
      if (now <= staleUntil) {
        this.touch(key);
        this.statsState.staleHits += 1;
        this.emit('stale', key, entry);
        this.revalidateInBackground(key, factory, options);
        return entry.value;
      }
      await this.removeEntry(key, entry);
      this.statsState.expirations += 1;
      this.emit('expire', key, entry);
    }
    this.statsState.misses += 1;
    this.emit('miss', key);

    const inFlight = this.pending.get(key);
    if (inFlight) {
      return inFlight;
    }
    const task = this.runFactory(key, factory, options);
    this.pending.set(key, task);
    try {
      return await task;
    } finally {
      if (this.pending.get(key) === task) {
        this.pending.delete(key);
      }
    }
  }

  private async runFactory(
    key: K,
    factory: () => Promise<V> | V,
    options: GetOrSetOptions,
  ): Promise<V> {
    let value: V;
    if (options.timeout !== undefined && options.timeout !== 0) {
      value = await withTimeout(Promise.resolve().then(factory), options.timeout, key as string);
    } else {
      value = await factory();
    }
    // Cache `undefined` too? No — treat undefined as "no value" is a design
    // choice; here we DO cache it explicitly is surprising for HTTP flows.
    // Decision: cache whatever the factory returned, including undefined,
    // because the caller asked to cache the result. (Documented + tested.)
    await this.set(key, value, options);
    return value;
  }

  private revalidateInBackground(
    key: K,
    factory: () => Promise<V> | V,
    options: GetOrSetOptions,
  ): void {
    if (this.revalidating.has(key)) {
      return;
    }
    this.revalidating.add(key);
    void (async () => {
      try {
        const value = await factory();
        await this.set(key, value, options);
      } catch (err) {
        // Keep serving stale data until `staleUntil`; just report the error.
        this.reportError(err);
      } finally {
        this.revalidating.delete(key);
      }
    })();
  }
}

async function withTimeout<V>(promise: Promise<V>, ms: number, key: string): Promise<V> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<V>((resolve, reject) => {
      timer = setTimeout(() => {
        reject(new TimeoutError(`Cache factory timed out after ${String(ms)}ms for key "${key}"`));
      }, ms);
      // Avoid leaking the timer handle into the event loop longer than needed.
      if (typeof (timer as { unref?: unknown }).unref === 'function') {
        (timer as unknown as { unref(): void }).unref();
      }
      promise.then(resolve, reject);
    });
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}
