import { describe, expect, it } from 'vitest';
import { HttpCache } from '../src/cache.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('LRU eviction', () => {
  it('inserts and retrieves up to maxSize', async () => {
    const cache = new HttpCache<string, number>({ maxSize: 3 });
    await cache.set('a', 1);
    await cache.set('b', 2);
    await cache.set('c', 3);
    expect(await cache.size()).toBe(3);
    expect(await cache.get('a')).toBe(1);
  });

  it('evicts the least recently used entry', async () => {
    const cache = new HttpCache<string, number>({ maxSize: 2 });
    await cache.set('a', 1);
    await cache.set('b', 2);
    await cache.set('c', 3); // evicts 'a'
    expect(await cache.get('a')).toBeUndefined();
    expect(await cache.get('b')).toBe(2);
    expect(await cache.get('c')).toBe(3);
    expect(cache.stats().evictions).toBe(1);
  });

  it('recently accessed items become most-recently-used', async () => {
    const cache = new HttpCache<string, number>({ maxSize: 2 });
    await cache.set('a', 1);
    await cache.set('b', 2);
    await cache.get('a'); // 'a' is now MRU, 'b' is LRU
    await cache.set('c', 3); // evicts 'b'
    expect(await cache.get('b')).toBeUndefined();
    expect(await cache.get('a')).toBe(1);
    expect(await cache.get('c')).toBe(3);
  });

  it('updating an existing key does not trigger eviction', async () => {
    const cache = new HttpCache<string, number>({ maxSize: 2 });
    await cache.set('a', 1);
    await cache.set('b', 2);
    await cache.set('a', 10);
    expect(await cache.size()).toBe(2);
    expect(await cache.get('a')).toBe(10);
    expect(await cache.get('b')).toBe(2);
    expect(cache.stats().evictions).toBe(0);
  });

  it('evicts repeatedly under sustained overflow', async () => {
    const cache = new HttpCache<string, number>({ maxSize: 5 });
    for (let i = 0; i < 20; i++) {
      await cache.set(`k${String(i)}`, i);
    }
    expect(await cache.size()).toBe(5);
    expect(cache.stats().evictions).toBe(15);
    // The 5 most recent survive.
    for (let i = 15; i < 20; i++) {
      expect(await cache.get(`k${String(i)}`)).toBe(i);
    }
    expect(await cache.get('k0')).toBeUndefined();
  });

  it('delete frees capacity', async () => {
    const cache = new HttpCache<string, number>({ maxSize: 2 });
    await cache.set('a', 1);
    await cache.set('b', 2);
    await cache.delete('a');
    await cache.set('c', 3);
    expect(cache.stats().evictions).toBe(0);
    expect(await cache.get('c')).toBe(3);
    expect(await cache.get('b')).toBe(2);
  });

  it('maxSize: 1 keeps only the latest entry', async () => {
    const cache = new HttpCache<string, number>({ maxSize: 1 });
    await cache.set('a', 1);
    await cache.set('b', 2);
    expect(await cache.get('a')).toBeUndefined();
    expect(await cache.get('b')).toBe(2);
  });

  it('clear resets LRU order', async () => {
    const cache = new HttpCache<string, number>({ maxSize: 2 });
    await cache.set('a', 1);
    await cache.set('b', 2);
    await cache.clear();
    await cache.set('c', 3);
    await cache.set('d', 4);
    expect(cache.stats().evictions).toBe(0);
    expect(await cache.size()).toBe(2);
  });

  it('expiration and eviction interact sanely', async () => {
    const cache = new HttpCache<string, number>({ maxSize: 2, ttl: 25 });
    await cache.set('a', 1);
    await cache.set('b', 2);
    await sleep(40); // both expired now
    await cache.set('c', 3); // evicts LRU 'a' (expired entries are evicted like any other)
    expect(await cache.get('c')).toBe(3);
    expect(await cache.size()).toBeLessThanOrEqual(2);
  });
});
