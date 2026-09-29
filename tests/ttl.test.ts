import { describe, expect, it } from 'vitest';
import { HttpCache } from '../src/cache.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('TTL', () => {
  it('expires entries after the global default TTL', async () => {
    const cache = new HttpCache<string, string>({ ttl: 30 });
    await cache.set('a', 'value');
    expect(await cache.get('a')).toBe('value');
    await sleep(50);
    expect(await cache.get('a')).toBeUndefined();
    expect(await cache.has('a')).toBe(false);
    expect(cache.stats().expirations).toBeGreaterThanOrEqual(1);
  });

  it('supports per-entry TTL overriding the default', async () => {
    const cache = new HttpCache<string, string>({ ttl: 10_000 });
    await cache.set('short', 's', { ttl: 30 });
    await cache.set('long', 'l', { ttl: 10_000 });
    await sleep(50);
    expect(await cache.get('short')).toBeUndefined();
    expect(await cache.get('long')).toBe('l');
  });

  it('falls back to the global TTL when per-entry TTL is omitted', async () => {
    const cache = new HttpCache<string, string>({ ttl: 30 });
    await cache.set('a', 'value');
    await sleep(50);
    expect(await cache.get('a')).toBeUndefined();
  });

  it('ttl: 0 expires immediately on next read', async () => {
    const cache = new HttpCache<string, string>({ ttl: 10_000 });
    await cache.set('a', 'value', { ttl: 0 });
    await sleep(5);
    expect(await cache.get('a')).toBeUndefined();
  });

  it('updating a key refreshes its TTL', async () => {
    const cache = new HttpCache<string, string>({ ttl: 40 });
    await cache.set('a', 'one');
    await sleep(25);
    await cache.set('a', 'two');
    await sleep(25);
    expect(await cache.get('a')).toBe('two');
  });

  it('getOrSet refreshes expired entries via the factory', async () => {
    const cache = new HttpCache<string, number>({ ttl: 25 });
    let n = 0;
    const factory = async (): Promise<number> => {
      n += 1;
      return n;
    };
    expect(await cache.getOrSet('k', factory)).toBe(1);
    expect(await cache.getOrSet('k', factory)).toBe(1);
    await sleep(40);
    expect(await cache.getOrSet('k', factory)).toBe(2);
  });

  it('expired getOrSet honors per-call TTL', async () => {
    const cache = new HttpCache<string, string>({ ttl: 10_000 });
    await cache.set('k', 'old', { ttl: 20 });
    await sleep(35);
    const value = await cache.getOrSet('k', async () => 'fresh', { ttl: 10_000 });
    expect(value).toBe('fresh');
    await sleep(35);
    expect(await cache.get('k')).toBe('fresh');
  });
});
