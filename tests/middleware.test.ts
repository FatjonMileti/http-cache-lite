import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { HttpCache } from '../src/cache.js';
import { cacheMiddleware } from '../src/middleware.js';
import type { CachedResponse } from '../src/middleware.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function buildApp(
  handler: (req: express.Request, res: express.Response) => void,
  middlewareOptions: Parameters<typeof cacheMiddleware>[0] = {},
): express.Express {
  const app = express();
  app.get('/users', cacheMiddleware(middlewareOptions), handler);
  return app;
}

describe('Express middleware', () => {
  it('caches misses then serves hits with restored headers', async () => {
    let calls = 0;
    const app = buildApp((_req, res) => {
      calls += 1;
      res.set('X-Data', 'custom-value');
      res.set('Content-Type', 'application/json');
      res.json({ users: [1, 2, 3] });
    });

    const miss = await request(app).get('/users');
    expect(miss.headers['x-cache']).toBe('MISS');
    expect(miss.status).toBe(200);
    expect(miss.headers['etag']).toBeDefined();
    expect(calls).toBe(1);

    const hit = await request(app).get('/users');
    expect(hit.headers['x-cache']).toBe('HIT');
    expect(hit.headers['x-data']).toBe('custom-value');
    expect(hit.headers['content-type']).toMatch(/application\/json/);
    expect(hit.text).toBe(miss.text);
    expect(calls).toBe(1); // handler not re-run
  });

  it('normalizes query ordering into the same key', async () => {
    let calls = 0;
    const app = buildApp((_req, res) => {
      calls += 1;
      res.json({ ok: true });
    });
    await request(app).get('/users?page=1&limit=20');
    const second = await request(app).get('/users?limit=20&page=1');
    expect(second.headers['x-cache']).toBe('HIT');
    expect(calls).toBe(1);
  });

  it('does not cache POST by default', async () => {
    const app = express();
    let calls = 0;
    app.post('/users', cacheMiddleware(), (_req, res) => {
      calls += 1;
      res.json({ ok: true });
    });
    await request(app).post('/users');
    const second = await request(app).post('/users');
    expect(second.headers['x-cache']).toBeUndefined();
    expect(calls).toBe(2);
  });

  it('caches POST only when explicitly configured', async () => {
    const app = express();
    let calls = 0;
    app.post('/items', cacheMiddleware({ methods: ['GET', 'POST'] }), (_req, res) => {
      calls += 1;
      res.json({ ok: true });
    });
    await request(app).post('/items');
    const second = await request(app).post('/items');
    expect(second.headers['x-cache']).toBe('HIT');
    expect(calls).toBe(1);
  });

  it('supports custom key generation', async () => {
    let calls = 0;
    const app = buildApp(
      (_req, res) => {
        calls += 1;
        res.json({ ok: true });
      },
      { keyGenerator: () => 'fixed-key' },
    );
    await request(app).get('/users?a=1');
    const second = await request(app).get('/users?totally=other');
    expect(second.headers['x-cache']).toBe('HIT');
    expect(calls).toBe(1);
  });

  it('honors custom shouldCache', async () => {
    let calls = 0;
    const app = buildApp(
      (_req, res) => {
        calls += 1;
        res.json({ ok: true });
      },
      { shouldCache: () => false },
    );
    await request(app).get('/users');
    const second = await request(app).get('/users');
    expect(second.headers['x-cache']).toBe('MISS');
    expect(calls).toBe(2);
  });

  it('shouldCache receives status, headers and body', async () => {
    const seen: Array<{ statusCode: number; bodyLength: number }> = [];
    const app = buildApp(
      (_req, res) => {
        res.json({ hello: 'world' });
      },
      {
        shouldCache: (_req, response) => {
          seen.push({ statusCode: response.statusCode, bodyLength: response.body.length });
          return true;
        },
      },
    );
    await request(app).get('/users');
    expect(seen).toHaveLength(1);
    expect(seen[0]?.statusCode).toBe(200);
    expect(seen[0]?.bodyLength).toBeGreaterThan(0);
  });

  it('returns 304 for matching If-None-Match', async () => {
    const app = buildApp((_req, res) => {
      res.json({ users: [] });
    });
    const first = await request(app).get('/users');
    const etag = first.headers['etag'];
    expect(etag).toBeDefined();

    const notModified = await request(app).get('/users').set('If-None-Match', etag);
    expect(notModified.status).toBe(304);
    expect(notModified.text).toBe('');
  });

  it('supports If-None-Match: *', async () => {
    const app = buildApp((_req, res) => {
      res.json({ users: [] });
    });
    const res = await request(app).get('/users').set('If-None-Match', '*');
    expect(res.status).toBe(304);
  });

  it('only caches configured status codes', async () => {
    const created = express();
    created.get('/things', cacheMiddleware(), (_req, res) => {
      res.status(201).json({ created: true });
    });
    await request(created).get('/things');
    const second = await request(created).get('/things');
    expect(second.headers['x-cache']).toBe('MISS'); // 201 not in defaults

    let calls = 0;
    const custom = express();
    custom.get('/things', cacheMiddleware({ statusCodes: [201] }), (_req, res) => {
      calls += 1;
      res.status(201).json({ created: true });
    });
    await request(custom).get('/things');
    const hit = await request(custom).get('/things');
    expect(hit.headers['x-cache']).toBe('HIT');
    expect(calls).toBe(1);
  });

  it('skips responses with Set-Cookie by default', async () => {
    const app = buildApp((_req, res) => {
      res.set('Set-Cookie', 'session=abc; HttpOnly');
      res.json({ ok: true });
    });
    await request(app).get('/users');
    const second = await request(app).get('/users');
    expect(second.headers['x-cache']).toBe('MISS');
  });

  it('skips requests with Authorization by default, caches with cachePrivate', async () => {
    let calls = 0;
    const strict = buildApp((_req, res) => {
      calls += 1;
      res.json({ ok: true });
    });
    await request(strict).get('/users').set('Authorization', 'Bearer token');
    await request(strict).get('/users').set('Authorization', 'Bearer token');
    expect(calls).toBe(2);

    calls = 0;
    const lenient = buildApp(
      (_req, res) => {
        calls += 1;
        res.json({ ok: true });
      },
      { cachePrivate: true },
    );
    await request(lenient).get('/users').set('Authorization', 'Bearer token');
    const hit = await request(lenient).get('/users').set('Authorization', 'Bearer token');
    expect(hit.headers['x-cache']).toBe('HIT');
    expect(calls).toBe(1);
  });

  it('respects private/no-store response Cache-Control by default', async () => {
    const app = buildApp((_req, res) => {
      res.set('Cache-Control', 'private, max-age=60');
      res.json({ ok: true });
    });
    await request(app).get('/users');
    const second = await request(app).get('/users');
    expect(second.headers['x-cache']).toBe('MISS');
  });

  it('does not override handler-set Cache-Control unless asked', async () => {
    const app = buildApp(
      (_req, res) => {
        res.set('Cache-Control', 'public, max-age=5');
        res.json({ ok: true });
      },
      { cacheControl: true },
    );
    const res = await request(app).get('/users');
    expect(res.headers['cache-control']).toBe('public, max-age=5');
  });

  it('emits Cache-Control when enabled', async () => {
    const app = buildApp(
      (_req, res) => {
        res.json({ ok: true });
      },
      { cacheControl: true, ttl: 60_000 },
    );
    const res = await request(app).get('/users');
    expect(res.headers['cache-control']).toBe('public, max-age=60');
    const hit = await request(app).get('/users');
    expect(hit.headers['cache-control']).toBe('public, max-age=60');
  });

  it('shares a user-provided cache (tags + invalidation + stats)', async () => {
    const cache = new HttpCache<string, CachedResponse>({ ttl: 60_000 });
    const app = buildApp(
      (_req, res) => {
        res.json({ users: ['a'] });
      },
      { cache, tags: ['users'] },
    );
    await request(app).get('/users');
    expect(await cache.size()).toBe(1);
    const hit = await request(app).get('/users');
    expect(hit.headers['x-cache']).toBe('HIT');
    expect(cache.stats().hits).toBeGreaterThanOrEqual(1);

    expect(await cache.invalidateByTag('users')).toBe(1);
    const after = await request(app).get('/users');
    expect(after.headers['x-cache']).toBe('MISS');
  });

  it('serves stale responses while revalidating (SWR)', async () => {
    let calls = 0;
    const app = buildApp(
      (_req, res) => {
        calls += 1;
        res.json({ version: calls });
      },
      { ttl: 30, staleWhileRevalidate: 5_000 },
    );
    const first = await request(app).get('/users');
    expect(first.headers['x-cache']).toBe('MISS');
    await sleep(60);

    const stale = await request(app).get('/users');
    expect(stale.headers['x-cache']).toBe('STALE');
    expect(stale.body).toEqual(first.body);

    const revalidated = await request(app).get('/users'); // designated revalidator hits origin
    expect(revalidated.body).toEqual({ version: 2 });
    expect(calls).toBe(2);
  });

  it('custom ETag function is used', async () => {
    const app = buildApp(
      (_req, res) => {
        res.json({ ok: true });
      },
      { etag: () => '"custom-tag"' },
    );
    const res = await request(app).get('/users');
    expect(res.headers['etag']).toBe('"custom-tag"');
    const notModified = await request(app).get('/users').set('If-None-Match', '"custom-tag"');
    expect(notModified.status).toBe(304);
  });

  it('etag: false disables ETag handling', async () => {
    const app = buildApp(
      (_req, res) => {
        res.json({ ok: true });
      },
      { etag: false },
    );
    const res = await request(app).get('/users');
    expect(res.headers['etag']).toBeUndefined();
  });

  it('reports capture errors via onError without breaking responses', async () => {
    const errors: unknown[] = [];
    const app = buildApp(
      (_req, res) => {
        res.json({ ok: true });
      },
      {
        onError: (err) => {
          errors.push(err);
        },
        shouldCache: () => {
          throw new Error('shouldCache boom');
        },
      },
    );
    const res = await request(app).get('/users');
    expect(res.status).toBe(200);
    await sleep(20);
    expect(errors).toHaveLength(1);
  });

  it('forwards keyGenerator failures to origin', async () => {
    const app = buildApp(
      (_req, res) => {
        res.json({ ok: true });
      },
      {
        keyGenerator: () => {
          throw new Error('key boom');
        },
      },
    );
    const res = await request(app).get('/users');
    expect(res.status).toBe(200);
    expect(res.headers['x-cache']).toBeUndefined();
  });

  it('uses the Express onError spy cleanly', async () => {
    const onError = vi.fn();
    const app = buildApp(
      (_req, res) => {
        res.json({ ok: true });
      },
      { onError },
    );
    await request(app).get('/users');
    await request(app).get('/users');
    expect(onError).not.toHaveBeenCalled();
  });
});
