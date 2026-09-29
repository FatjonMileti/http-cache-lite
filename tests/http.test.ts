import { describe, expect, it } from 'vitest';
import { generateETag, matchesIfNoneMatch } from '../src/http/etag.js';
import {
  buildCacheControl,
  isUncacheableDirective,
  parseCacheControl,
} from '../src/http/cache-control.js';
import { sanitizeHeaders } from '../src/utils/headers.js';
import { defaultKeyGenerator } from '../src/middleware.js';

describe('ETag', () => {
  it('is deterministic for equal bodies', () => {
    expect(generateETag('hello')).toBe(generateETag('hello'));
    expect(generateETag(Buffer.from('hello'))).toBe(generateETag('hello'));
  });

  it('differs for different bodies', () => {
    expect(generateETag('a')).not.toBe(generateETag('b'));
  });

  it('matches If-None-Match including weak tags and lists', () => {
    const tag = generateETag('body');
    expect(matchesIfNoneMatch(tag, tag)).toBe(true);
    expect(matchesIfNoneMatch(`W/${tag}`, tag)).toBe(true);
    expect(matchesIfNoneMatch(`"other", ${tag}`, tag)).toBe(true);
    expect(matchesIfNoneMatch('*', tag)).toBe(true);
    expect(matchesIfNoneMatch('"nope"', tag)).toBe(false);
    expect(matchesIfNoneMatch(undefined, tag)).toBe(false);
  });
});

describe('Cache-Control', () => {
  it('builds directive strings', () => {
    expect(buildCacheControl({ isPublic: true, maxAge: 60, staleWhileRevalidate: 120 })).toBe(
      'public, max-age=60, stale-while-revalidate=120',
    );
    expect(buildCacheControl({ noStore: true })).toBe('no-store');
    expect(buildCacheControl({ isPrivate: true, noCache: true })).toBe('no-cache, private');
  });

  it('parses directive strings', () => {
    const parsed = parseCacheControl('public, max-age=60, stale-while-revalidate=120');
    expect(parsed.get('public')).toBe(true);
    expect(parsed.get('max-age')).toBe('60');
    expect(parsed.get('stale-while-revalidate')).toBe('120');
    expect(parseCacheControl(undefined).size).toBe(0);
    expect(parseCacheControl('PRIVATE')).toHaveProperty('size', 1);
  });

  it('detects uncacheable directives', () => {
    expect(isUncacheableDirective('private, max-age=0')).toBe(true);
    expect(isUncacheableDirective('no-store')).toBe(true);
    expect(isUncacheableDirective('no-cache')).toBe(true);
    expect(isUncacheableDirective('public, max-age=60')).toBe(false);
    expect(isUncacheableDirective(undefined)).toBe(false);
  });
});

describe('headers', () => {
  it('strips hop-by-hop headers and lower-cases names', () => {
    const out = sanitizeHeaders({
      'Content-Type': 'application/json',
      Connection: 'keep-alive',
      'Transfer-Encoding': 'chunked',
      'X-Custom': 'yes',
    });
    expect(out).toEqual({
      'content-type': 'application/json',
      'x-custom': 'yes',
    });
  });
});

describe('defaultKeyGenerator', () => {
  const base = { headers: {} };

  it('builds METHOD:path?query keys (query sorted for determinism)', () => {
    expect(defaultKeyGenerator({ ...base, method: 'GET', url: '/users?page=1&limit=20' })).toBe(
      'GET:/users?limit=20&page=1',
    );
  });

  it('normalizes query parameter ordering', () => {
    const a = defaultKeyGenerator({ ...base, method: 'GET', url: '/users?page=1&limit=20' });
    const b = defaultKeyGenerator({ ...base, method: 'GET', url: '/users?limit=20&page=1' });
    expect(a).toBe(b);
  });

  it('distinguishes methods and paths', () => {
    const get = defaultKeyGenerator({ ...base, method: 'GET', url: '/users' });
    const head = defaultKeyGenerator({ ...base, method: 'HEAD', url: '/users' });
    expect(get).not.toBe(head);
  });

  it('folds accept-encoding into the key so representations never collide', () => {
    const gzip = defaultKeyGenerator({
      method: 'GET',
      url: '/data',
      headers: { 'accept-encoding': 'gzip' },
    });
    const br = defaultKeyGenerator({
      method: 'GET',
      url: '/data',
      headers: { 'accept-encoding': 'br' },
    });
    const none = defaultKeyGenerator({ ...base, method: 'GET', url: '/data' });
    expect(gzip).not.toBe(br);
    expect(gzip).not.toBe(none);
  });

  it('prefers originalUrl when present (Express mounted apps)', () => {
    expect(
      defaultKeyGenerator({
        ...base,
        method: 'GET',
        originalUrl: '/api/users?a=1',
        url: '/users?a=1',
      }),
    ).toBe('GET:/api/users?a=1');
  });
});
