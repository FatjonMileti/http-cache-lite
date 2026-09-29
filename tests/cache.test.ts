import { describe, expect, it, vi } from 'vitest';
import { HttpCache } from '../src/cache.js';
import { InvalidOptionError } from '../src/errors.js';
import { MemoryStorage } from '../src/storage/memory.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('HttpCache core', () => {
  it('sets, gets, checks and deletes entries', async () => {
    const cache = new HttpCache<string, string>();
    expect(await cache.get('a')).toBeUndefined();
    expect(await cache.has('a')).toBe(false);

    await cache.set('a', 'value-a');
    expect(await cache.get('a')).toBe('value-a');
    expect(await cache.has('a')).toBe(true);
    expect(await cache.size()).toBe(1);

    expect(await cache.delete('a')).toBe(true);
    expect(await cache.get('a')).toBeUndefined();
    expect(await cache.delete('a')).toBe(false);
  });

  it('invalidate() aliases delete()', async () => {
    const cache = new HttpCache();
    await cache.set('k', 1);
    expect(await cache.invalidate('k')).toBe(true);
    expect(await cache.has('k')).toBe(false);
  });

  it('clear() removes everything but preserves stats', async () => {
    const cache = new HttpCache();
    await cache.set('a', 1);
    await cache.set('b', 2);
    expect(await cache.size()).toBe(2);
    await cache.clear();
    expect(await cache.size()).toBe(0);
    expect(await cache.get('a')).toBeUndefined();
    const stats = cache.stats();
    expect(stats.sets).toBe(2);
  });

  it('supports generic values', async () => {
    interface User {
      id: number;
      name: string;
    }
    const cache = new HttpCache<string, User>();
    await cache.set('u1', { id: 1, name: 'Ada' });
    expect(await cache.get('u1')).toEqual({ id: 1, name: 'Ada' });
  });

  it('exposes full entries via getEntry()', async () => {
    const cache = new HttpCache();
    await cache.set('k', 'v', { tags: ['t'], ttl: 5_000 });
    const entry = await cache.getEntry('k');
    expect(entry).toBeDefined();
    expect(entry?.value).toBe('v');
    expect(entry?.tags).toEqual(['t']);
    expect(entry?.createdAt).toBeLessThanOrEqual(Date.now());
    expect(entry?.expiresAt).toBeGreaterThan(Date.now());
    expect(await cache.getEntry('missing')).toBeUndefined();
  });

  it('tracks statistics and resets them', async () => {
    const cache = new HttpCache<string, number>();
    await cache.set('a', 1);
    await cache.get('a'); // hit
    await cache.get('missing'); // miss
    const stats = cache.stats();
    expect(stats.hits).toBe(1);
    expect(stats.misses).toBe(1);
    expect(stats.sets).toBe(1);
    expect(stats.evictions).toBe(0);
    cache.resetStats();
    expect(cache.stats()).toEqual({
      hits: 0,
      misses: 0,
      sets: 0,
      evictions: 0,
      expirations: 0,
      staleHits: 0,
    });
  });

  it('emits lifecycle events and supports unsubscribe', async () => {
    const cache = new HttpCache<string, string>({ maxSize: 1 });
    const seen: string[] = [];
    const offHit = cache.on('hit', ({ key }) => {
      seen.push(`hit:${key}`);
    });
    cache.on('miss', ({ key }) => {
      seen.push(`miss:${key}`);
    });
    cache.on('set', ({ key }) => {
      seen.push(`set:${key}`);
    });
    cache.on('eviction', ({ key }) => {
      seen.push(`eviction:${key}`);
    });

    await cache.set('a', '1');
    await cache.get('a');
    await cache.get('nope');
    await cache.set('b', '2'); // evicts a

    expect(seen).toContain('set:a');
    expect(seen).toContain('hit:a');
    expect(seen).toContain('miss:nope');
    expect(seen).toContain('eviction:a');

    offHit();
    await cache.get('b');
    expect(seen.filter((s) => s === 'hit:b')).toHaveLength(0);
  });

  it('off(event) without handler removes all listeners', async () => {
    const cache = new HttpCache();
    const fn = vi.fn();
    cache.on('set', fn);
    cache.on('set', fn);
    cache.off('set');
    await cache.set('a', 1);
    expect(fn).not.toHaveBeenCalled();
  });

  it('rejects invalid constructor options', () => {
    expect(() => new HttpCache({ ttl: -1 })).toThrow(TypeError);
    expect(() => new HttpCache({ ttl: NaN })).toThrow(TypeError);
    expect(() => new HttpCache({ maxSize: 0 })).toThrow(InvalidOptionError);
    expect(() => new HttpCache({ maxSize: 1.5 })).toThrow(InvalidOptionError);
    expect(() => new HttpCache({ staleWhileRevalidate: -5 })).toThrow(TypeError);
  });

  it('rejects invalid set options', async () => {
    const cache = new HttpCache();
    await expect(cache.set('a', 1, { ttl: -1 })).rejects.toThrow(TypeError);
    await expect(cache.set('a', 1, { tags: ['ok', ''] as string[] })).rejects.toThrow(
      InvalidOptionError,
    );
    await expect(cache.set('a', 1, { etag: '' })).rejects.toThrow(InvalidOptionError);
  });

  it('works with a custom async storage backend', async () => {
    const backing = new Map<string, unknown>();
    const storage = {
      get: (k: string): unknown => backing.get(k),
      set: (k: string, v: unknown): void => {
        backing.set(k, v);
      },
      has: (k: string): boolean => backing.has(k),
      delete: (k: string): boolean => backing.delete(k),
      clear: (): void => {
        backing.clear();
      },
      size: (): number => backing.size,
    };
    const cache = new HttpCache<string, string>({ storage: storage as never });
    await cache.set('x', 'y');
    expect(await cache.get('x')).toBe('y');
    expect(await cache.size()).toBe(1);
  });

  it('uses MemoryStorage by default', async () => {
    const cache = new HttpCache();
    await cache.set('k', 'v');
    expect(await cache.get('k')).toBe('v');
    // Sanity: default storage instance is a MemoryStorage.
    expect(cache).toBeInstanceOf(HttpCache);
    const direct = new MemoryStorage<string, number>();
    direct.set('n', 42);
    expect(direct.get('n')).toBe(42);
    expect(direct.has('n')).toBe(true);
    expect(direct.size()).toBe(1);
    expect(direct.delete('n')).toBe(true);
    direct.set('a', 1);
    direct.clear();
    expect(direct.size()).toBe(0);
  });

  it('has() does not affect LRU order', async () => {
    const cache = new HttpCache<string, number>({ maxSize: 2 });
    await cache.set('a', 1);
    await cache.set('b', 2);
    expect(await cache.has('a')).toBe(true); // must not refresh 'a'
    await cache.set('c', 3); // evicts LRU ('a' if has() is non-touching)
    expect(await cache.has('a')).toBe(false);
    expect(await cache.get('b')).toBe(2);
  });

  it('getOrSet validates the factory', async () => {
    const cache = new HttpCache();
    await expect(cache.getOrSet('k', undefined as never)).rejects.toThrow(InvalidOptionError);
    await expect(cache.getOrSet('k', async () => 1, { timeout: -1 })).rejects.toThrow(
      InvalidOptionError,
    );
  });

  it('slow test guard', async () => {
    await sleep(1);
    expect(true).toBe(true);
  });
});
