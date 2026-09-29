import { describe, expect, it } from 'vitest';
import { HttpCache } from '../src/cache.js';
import { TimeoutError } from '../src/errors.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('request deduplication / stampede protection', () => {
  it('runs the factory only once for concurrent same-key requests', async () => {
    const cache = new HttpCache<string, number>();
    let calls = 0;
    const factory = async (): Promise<number> => {
      calls += 1;
      await sleep(30);
      return 42;
    };
    const [a, b, c] = await Promise.all([
      cache.getOrSet('key', factory),
      cache.getOrSet('key', factory),
      cache.getOrSet('key', factory),
    ]);
    expect(calls).toBe(1);
    expect(a).toBe(42);
    expect(b).toBe(42);
    expect(c).toBe(42);
  });

  it('caches the single-flight result for later callers', async () => {
    const cache = new HttpCache<string, number>();
    let calls = 0;
    const factory = async (): Promise<number> => {
      calls += 1;
      await sleep(10);
      return 7;
    };
    await Promise.all([cache.getOrSet('k', factory), cache.getOrSet('k', factory)]);
    expect(await cache.getOrSet('k', factory)).toBe(7);
    expect(calls).toBe(1);
  });

  it('propagates factory rejection to all waiters without caching', async () => {
    const cache = new HttpCache<string, number>();
    let calls = 0;
    const boom = new Error('boom');
    const factory = async (): Promise<number> => {
      calls += 1;
      await sleep(10);
      throw boom;
    };
    const results = await Promise.allSettled([
      cache.getOrSet('k', factory),
      cache.getOrSet('k', factory),
      cache.getOrSet('k', factory),
    ]);
    expect(calls).toBe(1);
    for (const r of results) {
      expect(r.status).toBe('rejected');
      if (r.status === 'rejected') {
        expect(r.reason).toBe(boom); // never wrapped
      }
    }
    // Nothing cached: a later call retries the factory.
    let retry = 0;
    expect(
      await cache.getOrSet('k', async () => {
        retry += 1;
        return 1;
      }),
    ).toBe(1);
    expect(retry).toBe(1);
  });

  it('supports per-call timeouts and cleans up pending state', async () => {
    const cache = new HttpCache<string, number>();
    const slow = async (): Promise<number> => {
      await sleep(200);
      return 1;
    };
    await expect(cache.getOrSet('k', slow, { timeout: 20 })).rejects.toThrow(TimeoutError);
    // Pending slot released: a fast factory works right after.
    expect(await cache.getOrSet('k', async () => 2)).toBe(2);
    expect(await cache.get('k')).toBe(2);
  });

  it('timeout rejects every concurrent waiter', async () => {
    const cache = new HttpCache<string, number>();
    const slow = async (): Promise<number> => {
      await sleep(200);
      return 1;
    };
    const outcomes = await Promise.allSettled([
      cache.getOrSet('t', slow, { timeout: 20 }),
      cache.getOrSet('t', slow, { timeout: 20 }),
    ]);
    expect(outcomes.every((o) => o.status === 'rejected')).toBe(true);
  });

  it('deduplicates per key, not across keys', async () => {
    const cache = new HttpCache<string, string>();
    const calls: string[] = [];
    const make = (name: string) => async (): Promise<string> => {
      calls.push(name);
      await sleep(15);
      return name;
    };
    const [a, b] = await Promise.all([
      cache.getOrSet('k1', make('one')),
      cache.getOrSet('k2', make('two')),
    ]);
    expect(a).toBe('one');
    expect(b).toBe('two');
    expect(calls.sort()).toEqual(['one', 'two']);
  });

  it('supports synchronous factories', async () => {
    const cache = new HttpCache<string, number>();
    let calls = 0;
    const value = await cache.getOrSet('k', () => {
      calls += 1;
      return 5;
    });
    expect(value).toBe(5);
    expect(calls).toBe(1);
  });

  it('late joiners during a slow factory still share the result', async () => {
    const cache = new HttpCache<string, number>();
    let calls = 0;
    const factory = async (): Promise<number> => {
      calls += 1;
      await sleep(40);
      return 9;
    };
    const first = cache.getOrSet('k', factory);
    await sleep(10);
    const second = cache.getOrSet('k', factory);
    expect(await first).toBe(9);
    expect(await second).toBe(9);
    expect(calls).toBe(1);
  });
});
