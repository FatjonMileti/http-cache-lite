import { describe, expect, it } from 'vitest';
import { HttpCache } from '../src/cache.js';

describe('tags', () => {
  it('assigns tags and invalidates by tag', async () => {
    const cache = new HttpCache<string, string>();
    await cache.set('user:1', 'a', { tags: ['users'] });
    await cache.set('user:2', 'b', { tags: ['users'] });
    await cache.set('post:1', 'c', { tags: ['posts'] });

    expect(await cache.invalidateByTag('users')).toBe(2);
    expect(await cache.get('user:1')).toBeUndefined();
    expect(await cache.get('user:2')).toBeUndefined();
    expect(await cache.get('post:1')).toBe('c');
  });

  it('supports multiple tags per entry', async () => {
    const cache = new HttpCache<string, string>();
    await cache.set('user:123', 'u', { tags: ['users', 'user:123'] });
    expect(await cache.invalidateByTag('user:123')).toBe(1);
    expect(await cache.has('user:123')).toBe(false);
  });

  it('one entry reachable through several tags', async () => {
    const cache = new HttpCache<string, string>();
    await cache.set('k', 'v', { tags: ['a', 'b', 'c'] });
    expect(await cache.invalidateByTag('b')).toBe(1);
    // Already removed: invalidating the other tags matches nothing.
    expect(await cache.invalidateByTag('a')).toBe(0);
    expect(await cache.invalidateByTag('c')).toBe(0);
  });

  it('invalidating an unknown tag returns 0', async () => {
    const cache = new HttpCache();
    await cache.set('k', 1);
    expect(await cache.invalidateByTag('nope')).toBe(0);
    expect(await cache.get('k')).toBe(1);
  });

  it('re-setting a key replaces its tags', async () => {
    const cache = new HttpCache<string, string>();
    await cache.set('k', 'v1', { tags: ['old'] });
    await cache.set('k', 'v2', { tags: ['new'] });
    expect(await cache.invalidateByTag('old')).toBe(0);
    expect(await cache.get('k')).toBe('v2');
    expect(await cache.invalidateByTag('new')).toBe(1);
  });

  it('duplicate tags are deduped', async () => {
    const cache = new HttpCache<string, string>();
    await cache.set('k', 'v', { tags: ['t', 't', 't'] });
    const entry = await cache.getEntry('k');
    expect(entry?.tags).toEqual(['t']);
    expect(await cache.invalidateByTag('t')).toBe(1);
  });

  it('deleting a key removes it from the tag index', async () => {
    const cache = new HttpCache<string, string>();
    await cache.set('k', 'v', { tags: ['t'] });
    await cache.delete('k');
    expect(await cache.invalidateByTag('t')).toBe(0);
  });

  it('getOrSet stores factory-provided tags', async () => {
    const cache = new HttpCache<string, string>();
    const value = await cache.getOrSet('users', async () => 'list', { tags: ['users'] });
    expect(value).toBe('list');
    expect(await cache.invalidateByTag('users')).toBe(1);
    expect(await cache.has('users')).toBe(false);
  });

  it('rejects invalid tag input', async () => {
    const cache = new HttpCache();
    await expect(cache.invalidateByTag('')).rejects.toThrow();
    await expect(cache.invalidateByTag(undefined as never)).rejects.toThrow();
  });

  it('tag invalidation scales without scanning (many unrelated entries)', async () => {
    const cache = new HttpCache<string, number>({ maxSize: 10_000 });
    for (let i = 0; i < 500; i++) {
      await cache.set(`other:${String(i)}`, i);
    }
    await cache.set('target', 1, { tags: ['hit-me'] });
    expect(await cache.invalidateByTag('hit-me')).toBe(1);
    expect(await cache.size()).toBe(500);
  });
});
