import { sha1Hex, byteSize } from '../utils/hash.js';

/**
 * Generate a deterministic strong ETag for a response body.
 *
 * Format matches the widely used `"<length>-<sha1>"` convention, so equal
 * bodies always produce equal tags across processes and restarts.
 */
export function generateETag(body: string | Uint8Array): string {
  const bytes = typeof body === 'string' ? body : Buffer.from(body);
  const len = byteSize(bytes);
  const hash = sha1Hex(typeof bytes === 'string' ? bytes : new Uint8Array(bytes));
  return `"${len.toString(16)}-${hash.slice(0, 27)}"`;
}

/**
 * Check an `If-None-Match` header value against a cached ETag.
 * Supports `*` and comma-separated tag lists, ignoring weak prefixes (`W/`).
 */
export function matchesIfNoneMatch(ifNoneMatch: string | undefined, etag: string): boolean {
  if (!ifNoneMatch) {
    return false;
  }
  const candidates = ifNoneMatch.split(',').map((s) => s.trim());
  const strong = (tag: string): string => (tag.startsWith('W/') ? tag.slice(2) : tag);
  const target = strong(etag);
  return candidates.some((c) => c === '*' || strong(c) === target);
}
