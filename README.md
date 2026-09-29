# http-cache-lite

Lightweight, framework-friendly HTTP response caching for Node.js/TypeScript. In-memory cache with TTL, LRU eviction, tags, ETag, Cache-Control, stale-while-revalidate (SWR), single-flight request deduplication and pluggable storage — plus a drop-in Express middleware. Zero runtime dependencies.

## Features

- **In-memory HTTP response caching** with a framework-independent core
- **TTL expiration** — global default plus per-entry override
- **LRU eviction** — O(1) amortized `get`/`set`, configurable `maxSize`
- **Cache invalidation** — by key (`delete`/`invalidate`) or by tag (`invalidateByTag`)
- **Cache tags** with a tag → keys index (no full-cache scans)
- **ETag support** — deterministic generation, `If-None-Match` → `304`
- **Cache-Control support** — generate, respect, or override
- **Stale-while-revalidate** — serve stale instantly, refresh once in the background
- **Request deduplication** — concurrent `getOrSet` calls share one factory invocation
- **Pluggable storage** — `MemoryStorage` built in, Redis-style adapters fit the same interface
- **TypeScript-first** — strict types, generics, no `any` in the public API
- **Express middleware** — key generation, query normalization, safety defaults
- **Observability** — stats, lightweight events, optional `onError`

## Installation

```bash
npm install http-cache-lite
```

Requires Node.js >= 18. Express (`^4 || ^5`) is an **optional peer dependency** — only needed if you use the middleware.

## Quick start

```ts
import { HttpCache } from 'http-cache-lite';

const cache = new HttpCache({ ttl: 60_000, maxSize: 1_000 });

const users = await cache.getOrSet('users', async () => fetchUsers(), {
  ttl: 30_000,
  tags: ['users'],
});

// Later, after a mutation:
await cache.invalidateByTag('users');
```

Express:

```ts
import express from 'express';
import { cacheMiddleware } from 'http-cache-lite';

const app = express();

app.get('/users', cacheMiddleware({ ttl: 30_000 }), async (_req, res) => {
  res.json(await getUsers());
});
```

## Core API

```ts
const cache = new HttpCache<string, User>({
  ttl: 60_000, // default TTL (ms)
  staleWhileRevalidate: 0, // SWR window (ms), 0 = disabled
  maxSize: 1_000, // LRU capacity
  storage: undefined, // defaults to MemoryStorage
  onError: (err) => console.error(err), // background-error hook
});

await cache.set(key, value, { ttl, staleWhileRevalidate, tags, etag });
await cache.get(key); // fresh or servable-stale value, else undefined
await cache.getEntry(key); // full entry incl. metadata, else undefined
await cache.has(key); // live entry? (does not affect LRU order)
await cache.delete(key); // true when something was removed
await cache.invalidate(key); // alias for delete()
await cache.invalidateByTag('users'); // number of removed entries
await cache.clear(); // everything (stats are preserved)
await cache.size(); // number of tracked entries

await cache.getOrSet(key, factory, { ttl, tags, timeout });

cache.stats(); // { hits, misses, sets, evictions, expirations, staleHits }
cache.resetStats();

const off = cache.on('hit', ({ key }) => console.log('hit', key));
cache.off('hit');
off(); // unsubscribe
```

All methods are async because storage backends may be async. The default `MemoryStorage` resolves immediately, so `await` costs nothing.

### Read-through with `getOrSet`

```ts
const [a, b, c] = await Promise.all([
  cache.getOrSet('users', fetchUsers),
  cache.getOrSet('users', fetchUsers),
  cache.getOrSet('users', fetchUsers),
]);
// fetchUsers() ran exactly once; all three callers share the result.
```

Factory rejections propagate unchanged to every waiter and are never cached. An optional `timeout` (ms) rejects all waiters with a `TimeoutError` and releases the single-flight slot.

## Express middleware

```ts
import { cacheMiddleware } from 'http-cache-lite';
// or: import { cacheMiddleware } from 'http-cache-lite/express';

app.get('/users', cacheMiddleware({ ttl: 30_000 }), handler);
```

### What it does

1. Builds a cache key (`METHOD:/path?sorted-query`, plus `Accept-Encoding` by default).
2. Serves fresh entries (`X-Cache: HIT`) or servable-stale entries (`X-Cache: STALE`).
3. Answers `If-None-Match` with `304 Not Modified` when the ETag matches.
4. Otherwise runs the handler, captures `res.send` output (`res.json` included) and stores cacheable responses (`X-Cache: MISS`).

### Defaults

- Methods: `GET`, `HEAD`. `POST`/`PUT`/`PATCH`/`DELETE` pass through unless added via `methods`.
- Status codes: `200, 203, 204, 206` (configurable via `statusCodes`).
- Skipped by default: responses with `Set-Cookie`, requests with `Authorization`/`Cookie`, and responses with `private`/`no-store`/`no-cache` Cache-Control.
- Only `res.send`-captured bodies are cached; handlers that use `res.end()` directly bypass the cache.
- Concurrent cold misses each hit the origin (single-flight applies to `getOrSet` and to SWR revalidation, see below).

### Configuration

```ts
app.get(
  '/users',
  cacheMiddleware({
    cache, // share an instance (tags, stats, manual invalidation)
    ttl: 30_000,
    staleWhileRevalidate: 60_000,
    maxSize: 500,
    methods: ['GET', 'HEAD'],
    statusCodes: [200, 203, 204, 206],
    tags: ['users'], // or (req) => [...] / async
    keyGenerator: (req) => `users:${req.query.page ?? 1}`,
    varyHeaders: ['accept-encoding'],
    shouldCache: (req, res) => res.statusCode === 200 && res.body.length < 1_000_000,
    etag: true, // true | false | ((body) => string)
    cacheControl: true, // false | true | { maxAge, ...directives, override }
    respectResponseCacheControl: true,
    cachePrivate: false, // opt in to cookie/auth caching (see Security)
    onError: (err) => logger.error(err),
  }),
  handler,
);
```

## TTL

```ts
new HttpCache({ ttl: 60_000 }); // global default
await cache.set('k', v); // uses the default
await cache.set('k', v, { ttl: 10_000 }); // per-entry override
```

`ttl` must be a finite number >= 0 (`0` expires on next read). Invalid values throw `TypeError`. Expiration is lazy — entries are checked on access, never by sweeping the cache.

## LRU

`maxSize` (positive integer, default `1000`) bounds the cache. `get`/`set`/`getOrSet` refresh recency in O(1) amortized time; `has` intentionally does **not** affect order. When full, the least-recently-used entry is evicted (`evictions` counter + `eviction` event). Updating an existing key never evicts.

## Tags

```ts
await cache.set('user:123', user, { tags: ['users', 'user:123'] });
await cache.invalidateByTag('users'); // → number removed
```

A tag → keys index makes invalidation O(matched entries). Re-setting a key replaces its tags; deleting a key removes it from the index; duplicates are deduped.

## ETag

- Core entries can carry an explicit `etag` via `set(key, value, { etag })`.
- The middleware keeps an origin-set ETag, generates a deterministic `"<len>-<sha1>"` tag when missing and `etag` is enabled, and strips ETags entirely when `etag: false`.
- Pass a function (`etag: (body) => string`) to fully control generation — it overrides origin/framework tags.
- Matching `If-None-Match` (including `W/` prefixes, lists and `*`) yields `304` with no body.

## Cache-Control

```ts
import { buildCacheControl, parseCacheControl } from 'http-cache-lite';

buildCacheControl({ isPublic: true, maxAge: 60, staleWhileRevalidate: 120 });
// 'public, max-age=60, stale-while-revalidate=120'
```

Middleware precedence:

1. A handler-set `Cache-Control` always wins, unless `cacheControl: { ..., override: true }`.
2. When `cacheControl` is enabled and no header exists, one is generated (`true` → `public, max-age=<ttl-s>[, stale-while-revalidate=<swr-s>]`; an object supplies custom directives with `maxAge` defaulting to the ttl).
3. With `respectResponseCacheControl` (default `true`), responses carrying `private`/`no-store`/`no-cache` are never stored.

## Stale-while-revalidate

```ts
new HttpCache({ ttl: 30_000, staleWhileRevalidate: 60_000 });
// 0s–30s:  fresh      → served, counted as hit
// 30s–90s: stale      → served immediately (+ background refresh via getOrSet)
// >90s:    expired    → removed, counted as expiration
```

Core `getOrSet` on a stale entry returns the stale value synchronously and triggers **one** background revalidation shared by all concurrent callers. If revalidation fails, the stale value keeps serving until `staleUntil`; the error goes to `onError` (and the `error` event) without crashing.

The Express middleware approximates this without a re-runnable origin: a stale hit is served with `X-Cache: STALE` (plus `Warning: 110`), and exactly one subsequent request becomes the designated revalidator that refreshes the entry. Concurrent requests during revalidation keep receiving the stale response.

## Request deduplication

`getOrSet` keeps an in-flight promise per key: N concurrent callers for a missing/expired key cause exactly one `factory()` execution, and every caller receives the same result (or the same rejection). Slots are always released (`finally`), timeouts via `TimeoutError` release them too, and different keys never block each other.

## Custom storage

```ts
import type { CacheStorage } from 'http-cache-lite';
import type { CacheEntry } from 'http-cache-lite';

class RedisStorage implements CacheStorage<string, CacheEntry<MyValue>> {
  async get(key: string) {
    /* ... */
  }
  async set(key: string, value: CacheEntry<MyValue>) {
    /* ... */
  }
  // has / delete / clear / size …
}

const cache = new HttpCache<string, MyValue>({ storage: new RedisStorage() });
```

Every method may return a value **or** a promise. LRU order, TTL, tags, stats, dedup and SWR live in the core, so custom backends inherit the policies. (Serialize `CacheEntry` — e.g. JSON with base64 bodies — when the backend is not in-process.)

## Statistics & events

```ts
cache.stats();
// { hits, misses, sets, evictions, expirations, staleHits }
cache.resetStats();

cache.on('hit', ({ key, entry }) => {});
cache.on('miss', ({ key }) => {});
cache.on('stale', ({ key, entry }) => {});
cache.on('set', ({ key, entry }) => {});
cache.on('delete', ({ key }) => {});
cache.on('eviction', ({ key, entry }) => {});
cache.on('expire', ({ key, entry }) => {});
cache.on('error', ({ error }) => {});
```

Events are synchronous, lightweight, and listener exceptions are routed to `onError` instead of breaking cache operations.

## Error handling

- `InvalidOptionError` — bad constructor/set/tag/timeout/factory arguments.
- `TimeoutError` (`code: 'TIMEOUT'`) — `getOrSet` factory exceeded `timeout`.
- `StorageError` — reserved for backend failures (backends should throw their own errors; the core never hides them).
- Factory errors are never wrapped or swallowed; SWR background failures go to `onError`.

## Security considerations

Caching is conservative by default, but caches are a classic source of data leaks — review this list:

- **Authenticated / personalized responses are not cached** unless you opt in: requests with `Authorization`/`Cookie` and responses with `Set-Cookie` or `private`/`no-store`/`no-cache` are skipped. Set `cachePrivate: true` only for endpoints you have verified are safe to share, or use `shouldCache` for surgical control.
- **Cache poisoning**: the default key covers method + path + sorted query + `Accept-Encoding`. If responses vary by other headers (e.g. `Accept-Language`, custom tenants), add them via `varyHeaders` or a custom `keyGenerator`; otherwise one user's representation can be served to another.
- **Key collisions**: custom `keyGenerator` functions must be deterministic and collision-resistant — never fold two security contexts into one key.
- **Unbounded memory**: always set `maxSize` appropriate for your value sizes; a single huge entry still fits, so also bound origin response sizes via `shouldCache` if needed.
- **Hop-by-hop headers** (`connection`, `transfer-encoding`, …) are stripped before storing and never replayed.
- **Encryption / PII**: the cache stores plaintext in process memory. Do not cache secrets, tokens or credentials; prefer short TTLs for sensitive-but-cacheable data.

## Performance

Hot paths are O(1) amortized (`get`/`set`/`delete`/recency touch); tag invalidation is O(matched entries); expiration is lazy (no sweeps); `size()` delegates to the backend. Run `npm run bench` for local ops/sec numbers — measure on your own hardware rather than trusting any published figure.

## API reference

### `new HttpCache<K, V>(options?)`

| Option                 | Default         | Description                           |
| ---------------------- | --------------- | ------------------------------------- |
| `ttl`                  | `60_000`        | Default TTL (ms, finite, >= 0)        |
| `staleWhileRevalidate` | `0`             | Default SWR window (ms)               |
| `maxSize`              | `1000`          | LRU capacity (positive integer)       |
| `storage`              | `MemoryStorage` | `CacheStorage<string, CacheEntry<V>>` |
| `onError`              | —               | Background-error hook                 |

Methods: `get`, `getEntry`, `set`, `has`, `delete`, `invalidate`, `invalidateByTag`, `clear`, `size`, `getOrSet`, `stats`, `resetStats`, `on`, `off`.

### Subpath exports

```ts
import { HttpCache } from 'http-cache-lite';
import { cacheMiddleware } from 'http-cache-lite/express';
import { MemoryStorage } from 'http-cache-lite/storage';
import type { CacheStorage } from 'http-cache-lite/storage';
```

### HTTP utilities

`generateETag(body)`, `matchesIfNoneMatch(header, etag)`, `buildCacheControl(opts)`, `parseCacheControl(header)`, `isUncacheableDirective(header)`, `sanitizeHeaders(headers)`, `defaultKeyGenerator(req, varyHeaders?)`.

## Examples

Runnable demo at [`examples/express/app.ts`](examples/express/app.ts):

```bash
npm run example
curl -i http://localhost:3000/users        # MISS
curl -i http://localhost:3000/users        # HIT
curl -i -H 'If-None-Match: "<etag>"' http://localhost:3000/users  # 304
curl http://localhost:3000/stats           # cache statistics
```

## Development

```bash
npm install
npm run lint        # eslint, zero warnings allowed
npm run typecheck   # tsc --noEmit
npm test            # vitest (106 tests)
npm run build       # tsup → ESM + CJS + DTS in dist/
npm pack            # inspect the published tarball
```

## Testing

Vitest suites cover core CRUD, TTL, LRU, tags, deduplication, SWR, the Express middleware (hits, headers, ETag/304, query normalization, safety defaults, custom hooks), HTTP utilities and edge cases (factory failures, timeouts, undefined/empty/large values, unicode keys, concurrent delete/set).

## License

MIT — see [LICENSE](LICENSE).
