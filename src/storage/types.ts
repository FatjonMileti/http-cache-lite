/**
 * Pluggable storage contract.
 *
 * Every method may return a plain value or a Promise of that value, so both
 * synchronous (in-memory) and asynchronous (Redis, filesystem, …) backends
 * implement the same interface without changing the core cache API.
 *
 * Implementations must scope all operations to this instance (no hidden
 * global state) and must not throw for missing keys — return `undefined`
 * / `false` instead.
 */
export interface CacheStorage<K, V> {
  get(key: K): Promise<V | undefined> | V | undefined;
  set(key: K, value: V): Promise<void> | void;
  has(key: K): Promise<boolean> | boolean;
  delete(key: K): Promise<boolean> | boolean;
  clear(): Promise<void> | void;
  size(): Promise<number> | number;
}
