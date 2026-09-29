/** Options for building a `Cache-Control` response header. */
export interface CacheControlOptions {
  /** Emit `public` (shared caches may store). Mutually exclusive with `private`. */
  isPublic?: boolean;
  /** Emit `private` (single-user caches only). Mutually exclusive with `isPublic`. */
  isPrivate?: boolean;
  /** `max-age` in seconds. */
  maxAge?: number;
  /** `s-maxage` in seconds. */
  sMaxAge?: number;
  /** `stale-while-revalidate` in seconds. */
  staleWhileRevalidate?: number;
  /** Emit `no-store`. */
  noStore?: boolean;
  /** Emit `no-cache` (revalidate before reuse). */
  noCache?: boolean;
  /** Emit `must-revalidate`. */
  mustRevalidate?: boolean;
  /** Emit `immutable`. */
  immutable?: boolean;
}

/**
 * Build a `Cache-Control` header value, e.g.
 * `public, max-age=60, stale-while-revalidate=120`.
 */
export function buildCacheControl(options: CacheControlOptions): string {
  const parts: string[] = [];
  if (options.noStore) {
    parts.push('no-store');
  }
  if (options.noCache) {
    parts.push('no-cache');
  }
  if (options.isPublic) {
    parts.push('public');
  } else if (options.isPrivate) {
    parts.push('private');
  }
  if (options.maxAge !== undefined) {
    parts.push(`max-age=${Math.max(0, Math.floor(options.maxAge))}`);
  }
  if (options.sMaxAge !== undefined) {
    parts.push(`s-maxage=${Math.max(0, Math.floor(options.sMaxAge))}`);
  }
  if (options.staleWhileRevalidate !== undefined) {
    parts.push(`stale-while-revalidate=${Math.max(0, Math.floor(options.staleWhileRevalidate))}`);
  }
  if (options.mustRevalidate) {
    parts.push('must-revalidate');
  }
  if (options.immutable) {
    parts.push('immutable');
  }
  return parts.join(', ');
}

/** Parsed `Cache-Control` directives: directive name (lower-cased) → value or `true`. */
export type ParsedCacheControl = Map<string, string | true>;

/** Parse a `Cache-Control` header value into directives. */
export function parseCacheControl(header: string | undefined): ParsedCacheControl {
  const out: ParsedCacheControl = new Map();
  if (!header) {
    return out;
  }
  for (const part of header.split(',')) {
    const trimmed = part.trim();
    if (!trimmed) {
      continue;
    }
    const eq = trimmed.indexOf('=');
    if (eq === -1) {
      out.set(trimmed.toLowerCase(), true);
    } else {
      const name = trimmed.slice(0, eq).trim().toLowerCase();
      let value = trimmed.slice(eq + 1).trim();
      if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
        value = value.slice(1, -1);
      }
      out.set(name, value);
    }
  }
  return out;
}

/**
 * Whether a response `Cache-Control` value forbids shared caching
 * (`private`, `no-store` or `no-cache` present).
 */
export function isUncacheableDirective(header: string | undefined): boolean {
  const parsed = parseCacheControl(header);
  return parsed.has('no-store') || parsed.has('no-cache') || parsed.has('private');
}
