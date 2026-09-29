import type { CacheStorage } from './types.js';

/**
 * Default synchronous in-memory storage backed by a `Map`.
 *
 * Complexity: `get` / `set` / `has` / `delete` are O(1) amortized,
 * `clear` is O(1), `size` is O(1).
 *
 * This store is intentionally "dumb": recency tracking, TTL enforcement,
 * tag indexing and statistics live in {@link HttpCache} so that every
 * future storage adapter (e.g. Redis) benefits from the same policies
 * without reimplementing them.
 */
export class MemoryStorage<K, V> implements CacheStorage<K, V> {
  private readonly map = new Map<K, V>();

  public get(key: K): V | undefined {
    return this.map.get(key);
  }

  public set(key: K, value: V): void {
    this.map.set(key, value);
  }

  public has(key: K): boolean {
    return this.map.has(key);
  }

  public delete(key: K): boolean {
    return this.map.delete(key);
  }

  public clear(): void {
    this.map.clear();
  }

  public size(): number {
    return this.map.size;
  }
}
