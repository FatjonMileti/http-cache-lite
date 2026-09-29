import { describe, expect, it } from 'vitest';
import { HttpCache } from '../src/cache.js';
import { MemoryStorage } from '../src/storage/memory.js';
import { TimeoutError } from '../src/errors.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('edge cases', () => {
  it('factory throwing synchronously propagates and caches nothing', async () => {
    const cache = new HttpCache<string, number>();
    const bad = (): number => {
      throw new Error('sync boom');
    };
    await expect(cache.getOrSet('k', bad as never)).rejects.toThrow('sync boom');
    expect(await cache.has('k')).toBe(false);
  });

  it('factory returning undefined caches undefined explicitly', async () => {
    const cache = new HttpCache<string, undefined>();
    let calls = 0;
    const factory = async (): Promise<undefined> => {
      calls += 1;
      return undefined;
    };
    expect(await cache.getOrSet('k', factory)).toBeUndefined();
    expect(await cache.getOrSet('k', factory)).toBeUndefined();
    expect(calls).toBe(1);
    expect(cache.stats().hits).toBe(1);
  });

  it('handles empty-string and large values', async () => {
    const cache = new HttpCache<string, string>();
    await cache.set('empty', '');
    expect(await cache.get('empty')).toBe('');
    const big = 'x'.repeat(1_000_000);
    await cache.set('big', big);
    expect((await cache.get('big'))?.length).toBe(1_000_000);
    const entry = await cache.getEntry('big');
    expect(entry?.size).toBe(1_000_000);
  });

  it('handles object values (size 0, reference preserved in memory)', async () => {
    const cache = new HttpCache<string, { n: number }>();
    const obj = { n: 1 };
    await cache.set('o', obj);
    expect(await cache.get('o')).toBe(obj);
  });

  it('concurrent delete and set resolve deterministically', async () => {
    const cache = new HttpCache<string, number>();
    await cache.set('k', 1);
    await Promise.all([cache.delete('k'), cache.set('k', 2), cache.get('k')]);
    // Either 2 survived or the delete landed last; both are valid linearizations.
    const value = await cache.get('k');
    expect(value === 2 || value === undefined).toBe(true);
  });

  it('concurrent getOrSet + delete does not leave stale pending state', async () => {
    const cache = new HttpCache<string, number>();
    const slow = async (): Promise<number> => {
      await sleep(30);
      return 1;
    };
    const pending = cache.getOrSet('k', slow);
    await cache.delete('k');
    expect(await pending).toBe(1);
    expect(await cache.get('k')).toBe(1);
  });

  it('expired entries count as misses and are removed', async () => {
    const cache = new HttpCache<string, number>({ ttl: 20 });
    await cache.set('k', 1);
    await sleep(35);
    expect(await cache.get('k')).toBeUndefined();
    expect(await cache.size()).toBe(0);
  });

  it('getOrSet timeout: 0 means no timeout', async () => {
    const cache = new HttpCache<string, number>();
    const slow = async (): Promise<number> => {
      await sleep(30);
      return 3;
    };
    expect(await cache.getOrSet('k', slow, { timeout: 0 })).toBe(3);
  });

  it('TimeoutError carries code TIMEOUT', async () => {
    const cache = new HttpCache<string, number>();
    const slow = async (): Promise<number> => {
      await sleep(100);
      return 1;
    };
    const err = await cache.getOrSet('k', slow, { timeout: 10 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TimeoutError);
    expect((err as TimeoutError).code).toBe('TIMEOUT');
  });

  it('storage failures surface to callers', async () => {
    const failing = {
      get(): undefined {
        return undefined;
      },
      set(): void {
        throw new Error('disk on fire');
      },
      has(): boolean {
        return false;
      },
      delete(): boolean {
        return false;
      },
      clear(): void {},
      size(): number {
        return 0;
      },
    };
    const cache = new HttpCache<string, number>({ storage: failing });
    await expect(cache.set('k', 1)).rejects.toThrow('disk on fire');
  });

  it('many keys with unicode and special characters', async () => {
    const cache = new HttpCache<string, string>();
    const keys = ['héllo/wörld?a=1&b=2', 'key with spaces', 'emoji-🚀-key', 'a'.repeat(500)];
    for (const [i, k] of keys.entries()) {
      await cache.set(k, `v${String(i)}`);
    }
    for (const [i, k] of keys.entries()) {
      expect(await cache.get(k)).toBe(`v${String(i)}`);
    }
    expect(await cache.size()).toBe(keys.length);
  });

  it('MemoryStorage is independent per instance', () => {
    const a = new MemoryStorage<string, number>();
    const b = new MemoryStorage<string, number>();
    a.set('k', 1);
    expect(b.has('k')).toBe(false);
  });

  it('clear() during in-flight getOrSet is safe', async () => {
    const cache = new HttpCache<string, number>();
    const slow = async (): Promise<number> => {
      await sleep(20);
      return 1;
    };
    const p = cache.getOrSet('k', slow);
    await cache.clear();
    expect(await p).toBe(1);
  });
});
