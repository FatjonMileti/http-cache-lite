import type { NextFunction, Request, Response } from 'express';
import { HttpCache } from './cache.js';
import { generateETag, matchesIfNoneMatch } from './http/etag.js';
import { buildCacheControl, isUncacheableDirective } from './http/cache-control.js';
import type { CacheControlOptions } from './http/cache-control.js';
import type { CacheEntry } from './types.js';
import type { CacheStorage } from './storage/types.js';
import { sanitizeHeaders } from './utils/headers.js';

export const DEFAULT_CACHEABLE_METHODS = ['GET', 'HEAD'] as const;
export const DEFAULT_CACHEABLE_STATUS_CODES = [200, 203, 204, 206] as const;

/** A captured HTTP response suitable for caching and replay. */
export interface CachedResponse {
  statusCode: number;
  /** Lower-cased header names, hop-by-hop headers already removed. */
  headers: Record<string, string>;
  body: Uint8Array;
  etag?: string;
}

/** Minimal request shape needed for key generation (subset of Express `Request`). */
export interface CacheKeyRequest {
  method?: string;
  originalUrl?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
}

export interface ShouldCacheArgs {
  statusCode: number;
  headers: Record<string, string>;
  body: Uint8Array;
}

export interface CacheMiddlewareOptions {
  /** Shared cache instance. A new one is created from the other options when omitted. */
  cache?: HttpCache<string, CachedResponse>;
  /** Default TTL in ms for cached responses. @default 60000 */
  ttl?: number;
  /** Stale-while-revalidate window in ms. Stale responses are served with `X-Cache: STALE`. @default 0 */
  staleWhileRevalidate?: number;
  /** Maximum entries before LRU eviction. @default 1000 */
  maxSize?: number;
  /** Custom backing store for the internally created cache. */
  storage?: CacheStorage<string, CacheEntry<CachedResponse>>;
  /** Background error handler. */
  onError?: (err: unknown) => void;
  /** HTTP methods eligible for caching. @default ['GET', 'HEAD'] */
  methods?: string[];
  /** Response status codes eligible for caching. @default [200, 203, 204, 206] */
  statusCodes?: number[];
  /** Tags stored with each entry (for `invalidateByTag`). */
  tags?: string[] | ((req: Request) => string[] | Promise<string[]>);
  /** Custom cache key. Defaults to {@link defaultKeyGenerator}. */
  keyGenerator?: (req: Request) => string;
  /**
   * Request headers folded into the default cache key.
   * `accept-encoding` is included by default so compressed and uncompressed
   * representations are never served as each other. @default ['accept-encoding']
   */
  varyHeaders?: string[];
  /** Extra gate evaluated after the response is captured. Return `false` to skip storing. */
  shouldCache?: (req: Request, response: ShouldCacheArgs) => boolean | Promise<boolean>;
  /** ETag handling: `true` generates + validates, a function customizes generation, `false` disables. @default true */
  etag?: boolean | ((body: Uint8Array) => string);
  /**
   * Emit `Cache-Control` on cached responses: `true` derives
   * `public, max-age=<ttl>, stale-while-revalidate=<swr>`; an object uses
   * custom directives (missing `maxAge` falls back to the ttl).
   * A handler-set header always wins unless `override: true`. @default false
   */
  cacheControl?: boolean | (CacheControlOptions & { override?: boolean });
  /**
   * Honor response `Cache-Control: private/no-store/no-cache` by refusing to
   * store such responses. @default true
   */
  respectResponseCacheControl?: boolean;
  /**
   * When `true`, responses with `Set-Cookie` and requests carrying
   * `Authorization`/`Cookie` become cacheable (still subject to
   * `shouldCache`). Default is conservative (`false`).
   * @default false
   */
  cachePrivate?: boolean;
}

function toBuffer(body: unknown): Uint8Array {
  if (body instanceof Uint8Array) {
    return body;
  }
  if (typeof body === 'string') {
    return Buffer.from(body, 'utf8');
  }
  if (body === undefined || body === null) {
    return Buffer.alloc(0);
  }
  if (typeof body === 'object') {
    try {
      return Buffer.from(JSON.stringify(body), 'utf8');
    } catch {
      return Buffer.alloc(0);
    }
  }
  if (typeof body === 'number' || typeof body === 'boolean' || typeof body === 'bigint') {
    return Buffer.from(String(body), 'utf8');
  }
  // Symbols, functions and other exotic values have no useful representation.
  return Buffer.alloc(0);
}

function forceSet(res: Response, name: string, value: string): void {
  try {
    res.set(name, value);
  } catch {
    // Headers may already be sent or invalid — never break the response.
  }
}

/** Normalize an `Accept-Encoding`-style header: lower-case, split, trim, sort. */
export function normalizeEncodingHeader(value: string | string[] | undefined): string {
  const raw = Array.isArray(value) ? value.join(',') : (value ?? '');
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .sort()
    .join(',');
}

/**
 * Deterministic cache key: `METHOD:/path?sorted-query[|header=value…]`.
 *
 * Query parameters are sorted so `?page=1&limit=20` and `?limit=20&page=1`
 * produce the same key. Relevant request headers (default: accept-encoding)
 * are folded in so different representations never collide.
 */
export function defaultKeyGenerator(
  req: CacheKeyRequest,
  varyHeaders: string[] = ['accept-encoding'],
): string {
  const method = (req.method ?? 'GET').toUpperCase();
  const rawUrl = req.originalUrl ?? req.url ?? '/';
  let path = rawUrl;
  let query = '';
  try {
    const parsed = new URL(rawUrl, 'http://localhost');
    path = parsed.pathname;
    const params = new URLSearchParams(parsed.search);
    params.sort();
    query = params.toString();
  } catch {
    const qIndex = rawUrl.indexOf('?');
    if (qIndex === -1) {
      path = rawUrl;
    } else {
      path = rawUrl.slice(0, qIndex);
      const params = new URLSearchParams(rawUrl.slice(qIndex + 1));
      params.sort();
      query = params.toString();
    }
  }
  let key = query ? `${method}:${path}?${query}` : `${method}:${path}`;
  for (const name of varyHeaders) {
    const lower = name.toLowerCase();
    const value = req.headers[lower] ?? req.headers[name];
    const normalized =
      lower === 'accept-encoding' ? normalizeEncodingHeader(value) : String(value ?? '').trim();
    if (normalized) {
      key += `|${lower}=${normalized}`;
    }
  }
  return key;
}

/**
 * Express middleware that caches successful responses in an {@link HttpCache}.
 *
 * - Cacheable methods default to `GET`/`HEAD`; others pass through.
 * - `POST`/`PUT`/`PATCH`/`DELETE` are never cached unless listed in `methods`.
 * - Responses with `Set-Cookie`, requests with `Authorization`/`Cookie`, and
 *   `private`/`no-store`/`no-cache` responses are skipped by default
 *   (see `cachePrivate` / `shouldCache` to override intentionally).
 * - Only `res.send`-based bodies are captured (covers `res.json`/`res.send`).
 */
export function cacheMiddleware(options: CacheMiddlewareOptions = {}) {
  const methods = new Set(
    (options.methods ?? [...DEFAULT_CACHEABLE_METHODS]).map((m) => m.toUpperCase()),
  );
  const statusCodes = new Set(options.statusCodes ?? [...DEFAULT_CACHEABLE_STATUS_CODES]);
  const varyHeaders = (options.varyHeaders ?? ['accept-encoding']).map((h) => h.toLowerCase());
  const respectCC = options.respectResponseCacheControl ?? true;
  const cachePrivate = options.cachePrivate ?? false;
  const etagOption = options.etag ?? true;
  const keyGenerator =
    options.keyGenerator ?? ((req: Request) => defaultKeyGenerator(req, varyHeaders));

  const cache =
    options.cache ??
    new HttpCache<string, CachedResponse>({
      ttl: options.ttl,
      staleWhileRevalidate: options.staleWhileRevalidate,
      maxSize: options.maxSize,
      storage: options.storage,
      onError: options.onError,
    });

  // SWR bookkeeping: keys queued for revalidation + origins currently running.
  const revalidateQueued = new Set<string>();
  const originInFlight = new Set<string>();

  const resolveCacheControl = (
    ttlMs: number | undefined,
    swrMs: number | undefined,
  ): string | undefined => {
    if (!options.cacheControl) {
      return undefined;
    }
    if (options.cacheControl === true) {
      const parts = ['public'];
      if (ttlMs !== undefined) {
        parts.push(`max-age=${Math.floor(ttlMs / 1000)}`);
      }
      if (swrMs) {
        parts.push(`stale-while-revalidate=${Math.floor(swrMs / 1000)}`);
      }
      return parts.join(', ');
    }
    const { override: _override, ...directives } = options.cacheControl;
    const opts: CacheControlOptions = { ...directives };
    if (opts.maxAge === undefined && ttlMs !== undefined) {
      opts.maxAge = Math.floor(ttlMs / 1000);
    }
    if (opts.staleWhileRevalidate === undefined && swrMs) {
      opts.staleWhileRevalidate = Math.floor(swrMs / 1000);
    }
    if (opts.isPublic === undefined && opts.isPrivate === undefined) {
      opts.isPublic = true;
    }
    return buildCacheControl(opts);
  };

  function serveCached(
    res: Response,
    req: Request,
    entry: CacheEntry<CachedResponse>,
    hitKind: 'HIT' | 'STALE',
  ): void {
    const { value, expiresAt, createdAt } = entry;
    const headers = { ...value.headers };
    delete headers['content-length'];

    if (value.etag && etagOption !== false) {
      headers['etag'] = value.etag;
    }
    const generatedCC = resolveCacheControl(
      expiresAt - createdAt,
      entry.staleUntil ? entry.staleUntil - expiresAt : 0,
    );
    if (generatedCC) {
      const override =
        typeof options.cacheControl === 'object' && Boolean(options.cacheControl.override);
      if (override || !headers['cache-control']) {
        headers['cache-control'] = generatedCC;
      }
    }
    headers['x-cache'] = hitKind;
    if (hitKind === 'STALE') {
      headers['warning'] = '110 - "Response is Stale"';
    }

    if (value.etag && etagOption !== false) {
      const ifNoneMatch = req.headers['if-none-match'];
      const inm = Array.isArray(ifNoneMatch) ? ifNoneMatch.join(', ') : ifNoneMatch;
      if (matchesIfNoneMatch(inm, value.etag)) {
        res.status(304);
        res.set('etag', value.etag);
        res.set('x-cache', hitKind);
        if (headers['cache-control']) {
          res.set('cache-control', headers['cache-control']);
        }
        res.end();
        return;
      }
    }

    res.status(value.statusCode);
    for (const [name, val] of Object.entries(headers)) {
      try {
        res.set(name, val);
      } catch {
        // Ignore headers Express refuses (e.g. pseudo-headers).
      }
    }
    res.send(Buffer.from(value.body));
  }

  return function httpCacheLiteMiddleware(req: Request, res: Response, next: NextFunction): void {
    const method = req.method.toUpperCase();
    if (!methods.has(method)) {
      next();
      return;
    }
    let key: string;
    try {
      key = keyGenerator(req);
    } catch (err) {
      if (options.onError) {
        try {
          options.onError(err);
        } catch {
          // ignore reporting errors
        }
      }
      next();
      return;
    }

    void (async () => {
      const entry = await cache.getEntry(key);
      const now = Date.now();

      if (entry !== undefined && now <= entry.expiresAt) {
        serveCached(res, req, entry, 'HIT');
        return;
      }

      if (entry !== undefined) {
        // Servable-stale. Exactly one later request becomes the designated
        // revalidator; everyone else (including concurrent requests while the
        // origin is running) keeps getting the stale response.
        if (revalidateQueued.has(key) && !originInFlight.has(key)) {
          // This request is the designated revalidator: fall through to origin.
        } else {
          revalidateQueued.add(key);
          serveCached(res, req, entry, 'STALE');
          return;
        }
      }

      // Miss / expired / designated revalidator → run the handler and capture.
      originInFlight.add(key);
      const originalSend = res.send.bind(res);
      let responded = false;

      const finishFlight = (): void => {
        originInFlight.delete(key);
      };

      res.send = function sendAndCache(body?: unknown): Response {
        if (responded) {
          return originalSend(body);
        }
        responded = true;
        const buffer = Buffer.from(toBuffer(body));
        const statusCode = res.statusCode;
        const rawHeaders: Record<string, string> = {};
        for (const [name, value] of Object.entries(res.getHeaders())) {
          if (typeof value === 'string') {
            rawHeaders[name.toLowerCase()] = value;
          } else if (typeof value === 'number') {
            rawHeaders[name.toLowerCase()] = String(value);
          } else if (Array.isArray(value)) {
            rawHeaders[name.toLowerCase()] = value.join(', ');
          }
        }
        const headers = sanitizeHeaders(rawHeaders);

        // Synchronous cacheability pre-check (everything except the optional
        // user gate). Headers derived here are applied to the live response
        // BEFORE the original send flushes, so MISS responses already carry
        // the same ETag / Cache-Control that later HITs will replay.
        const cacheableStatus = statusCodes.has(statusCode);
        const hasSetCookie = 'set-cookie' in headers;
        const reqAuth = req.headers['authorization'] !== undefined;
        const reqCookie = req.headers['cookie'] !== undefined;
        const privateResponse = isUncacheableDirective(headers['cache-control']);
        const preselected =
          cacheableStatus &&
          (cachePrivate || (!hasSetCookie && !privateResponse)) &&
          (cachePrivate || (!reqAuth && !reqCookie)) &&
          !(respectCC && !cachePrivate && privateResponse);

        const reportError = (err: unknown): void => {
          if (options.onError) {
            try {
              options.onError(err);
            } catch {
              // ignore reporting errors
            }
          }
        };

        if (preselected) {
          const bodyBytes = new Uint8Array(buffer);
          if (typeof etagOption === 'function') {
            // An explicit generator expresses user intent: it wins over
            // any origin/framework-set ETag.
            try {
              const custom = etagOption(bodyBytes);
              headers['etag'] = custom;
              forceSet(res, 'ETag', custom);
            } catch (err) {
              reportError(err);
            }
          } else if (etagOption && !headers['etag']) {
            const generated = generateETag(bodyBytes);
            headers['etag'] = generated;
            forceSet(res, 'ETag', generated);
          }
        }
        if (etagOption === false && headers['etag']) {
          delete headers['etag'];
          try {
            res.removeHeader('ETag');
          } catch {
            // ignore
          }
        }

        const finalize = (gatePassed: boolean): void => {
          void (async () => {
            try {
              if (!preselected || !gatePassed) {
                return;
              }
              // Re-check: an async gate may have resolved after headers were
              // prepared; only stored entries advertise Cache-Control.
              const generatedCC = resolveCacheControl(options.ttl, options.staleWhileRevalidate);
              if (generatedCC && !headers['cache-control']) {
                headers['cache-control'] = generatedCC;
              }
              let tags: string[] = [];
              if (typeof options.tags === 'function') {
                tags = await options.tags(req);
              } else if (Array.isArray(options.tags)) {
                tags = options.tags;
              }
              const etag = headers['etag'];
              const response: CachedResponse = { statusCode, headers, body: buffer, etag };
              await cache.set(key, response, {
                ttl: options.ttl,
                staleWhileRevalidate: options.staleWhileRevalidate,
                tags,
                etag,
              });
              revalidateQueued.delete(key);
            } catch (err) {
              reportError(err);
            } finally {
              finishFlight();
            }
          })();
        };

        if (preselected && options.shouldCache) {
          let gate: boolean | Promise<boolean>;
          try {
            gate = options.shouldCache(req, { statusCode, headers, body: buffer });
          } catch (err) {
            reportError(err);
            finishFlight();
            return setMissHeaderAndSend();
          }
          if (gate instanceof Promise) {
            gate.then(
              (passed) => {
                finalize(passed);
              },
              (err: unknown) => {
                reportError(err);
                finishFlight();
              },
            );
            return setMissHeaderAndSend();
          }
          if (!gate) {
            finishFlight();
            return setMissHeaderAndSend();
          }
          // Sync gate passed: advertise Cache-Control on the MISS response too.
          const generatedCC = resolveCacheControl(options.ttl, options.staleWhileRevalidate);
          if (generatedCC && !headers['cache-control']) {
            headers['cache-control'] = generatedCC;
            forceSet(res, 'Cache-Control', generatedCC);
          }
          finalize(true);
          return setMissHeaderAndSend();
        }

        if (preselected) {
          const generatedCC = resolveCacheControl(options.ttl, options.staleWhileRevalidate);
          if (generatedCC && !headers['cache-control']) {
            headers['cache-control'] = generatedCC;
            forceSet(res, 'Cache-Control', generatedCC);
          }
          finalize(true);
        } else {
          finishFlight();
        }
        return setMissHeaderAndSend();

        function setMissHeaderAndSend(): Response {
          if (!res.getHeader('x-cache')) {
            try {
              res.set('x-cache', 'MISS');
            } catch {
              // ignore
            }
          }
          if (etagOption === false) {
            // Express/compatible frameworks generate a weak ETag inside
            // res.send when none is present. Suppress it for this response
            // only. This is race-free: send() flushes synchronously, so no
            // other request can interleave between set and restore.
            try {
              const app = req.app;
              const previous: unknown = app.get('etag');
              app.set('etag', false);
              try {
                return originalSend(body);
              } finally {
                app.set('etag', previous);
              }
            } catch {
              return originalSend(body);
            }
          }
          return originalSend(body);
        }
      };

      res.on('close', () => {
        // If the handler never called res.send (e.g. res.end directly),
        // release the flight so future requests are not stuck.
        finishFlight();
      });

      next();
    })().catch((err: unknown) => {
      originInFlight.delete(key);
      next(err as Error);
    });
  };
}
