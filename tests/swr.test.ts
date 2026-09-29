import { describe, expect, it, vi } from 'vitest';
import { HttpCache } from '../src/cache.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('stale-while-revalidate', () => {
  it('serves fresh entries without revalidating', async () => {
    const cache = new HttpCache<string, number>({ ttl: 5_000, staleWhileRevalidate: 5_000 });
    let calls = 0;
    await cache.set('k', 1);
    const value = await cache.getOrSet('k', async () => {
      calls += 1;
      return 2;
    });
    expect(value).toBe(1);
    expect(calls).toBe(0);
    expect(cache.stats().hits).toBe(1);
  });

  it('serves stale immediately and refreshes in the background', async () => {
    const cache = new HttpCache<string, number>({ ttl: 30, staleWhileRevalidate: 5_000 });
    await cache.set('k', 1);
    await sleep(50); // stale but within the SWR window

    const stale = await cache.getOrSet('k', async () => {
      await sleep(20);
      return 2;
    });
    expect(stale).toBe(1); // stale served synchronously
    expect(cache.stats().staleHits).toBe(1);

    await sleep(60); // background revalidation lands
    expect(await cache.get('k')).toBe(2);
  });

  it('coalesces concurrent revalidations into one factory call', async () => {
    const cache = new HttpCache<string, number>({ ttl: 25, staleWhileRevalidate: 5_000 });
    await cache.set('k', 1);
    await sleep(40);

    let calls = 0;
    const factory = async (): Promise<number> => {
      calls += 1;
      await sleep(30);
      return 2;
    };
    const values = await Promise.all([
      cache.getOrSet('k', factory),
      cache.getOrSet('k', factory),
      cache.getOrSet('k', factory),
    ]);
    expect(values).toEqual([1, 1, 1]);
    await sleep(80);
    expect(calls).toBe(1);
    expect(await cache.get('k')).toBe(2);
  });

  it('keeps stale data when background refresh fails', async () => {
    const errors: unknown[] = [];
    const cache = new HttpCache<string, number>({
      ttl: 25,
      staleWhileRevalidate: 5_000,
      onError: (err) => {
        errors.push(err);
      },
    });
    await cache.set('k', 1);
    await sleep(40);

    const stale = await cache.getOrSet('k', async () => {
      throw new Error('origin down');
    });
    expect(stale).toBe(1);
    await sleep(20);
    expect(await cache.get('k')).toBe(1); // stale preserved
    expect(errors).toHaveLength(1);
    const firstError = errors[0];
    expect(firstError).toBeInstanceOf(Error);
    expect((firstError as Error).message).toBe('origin down');
  });

  it('drops entries once the stale window expires', async () => {
    const cache = new HttpCache<string, number>({ ttl: 25, staleWhileRevalidate: 40 });
    await cache.set('k', 1);
    await sleep(90); // past ttl + swr
    expect(await cache.get('k')).toBeUndefined();
    expect(await cache.has('k')).toBe(false);
    expect(cache.stats().expirations).toBeGreaterThanOrEqual(1);
  });

  it('expired entries (no SWR) trigger a single-flight refresh', async () => {
    const cache = new HttpCache<string, number>({ ttl: 25 });
    await cache.set('k', 1);
    await sleep(40);
    let calls = 0;
    const values = await Promise.all([
      cache.getOrSet('k', async () => {
        calls += 1;
        await sleep(10);
        return 2;
      }),
      cache.getOrSet('k', async () => {
        calls += 1;
        await sleep(10);
        return 2;
      }),
    ]);
    expect(values).toEqual([2, 2]);
    expect(calls).toBe(1);
  });

  it('per-entry SWR window overrides the global default', async () => {
    const cache = new HttpCache<string, number>({ ttl: 25, staleWhileRevalidate: 0 });
    await cache.set('k', 1, { staleWhileRevalidate: 5_000 });
    await sleep(40);
    // Stale served thanks to the per-entry window.
    const stale = await cache.getOrSet('k', async () => 2);
    expect(stale).toBe(1);
    await sleep(20);
    expect(await cache.get('k')).toBe(2);
  });

  it('emits stale events for stale reads', async () => {
    const cache = new HttpCache<string, number>({ ttl: 20, staleWhileRevalidate: 5_000 });
    const staleKeys: string[] = [];
    cache.on('stale', ({ key }) => {
      staleKeys.push(key);
    });
    await cache.set('k', 1);
    await sleep(35);
    await cache.get('k');
    expect(staleKeys).toEqual(['k']);
  });

  it('plain get() returns stale values without a factory', async () => {
    const cache = new HttpCache<string, number>({ ttl: 20, staleWhileRevalidate: 5_000 });
    await cache.set('k', 1);
    await sleep(35);
    expect(await cache.get('k')).toBe(1);
    expect(cache.stats().staleHits).toBe(1);
  });

  it('listener errors never break cache reads', async () => {
    const cache = new HttpCache<string, number>();
    cache.on('hit', () => {
      throw new Error('listener boom');
    });
    await cache.set('k', 1);
    await expect(cache.get('k')).resolves.toBe(1);
    expect(vi.fn()).toBeDefined();
  });
});
