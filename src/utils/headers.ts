/**
 * Hop-by-hop / connection-specific headers that must never be replayed from
 * a cached response. See RFC 9110 §7.6.1.
 */
export const HOP_BY_HOP_HEADERS: ReadonlySet<string> = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/** Lower-case header names and drop hop-by-hop headers. */
export function sanitizeHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower)) {
      continue;
    }
    out[lower] = value;
  }
  return out;
}

/** Normalize Node/Express-style header values to a plain string map. */
export function normalizeHeaderValue(
  value: string | string[] | number | undefined,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (Array.isArray(value)) {
    return value.join(', ');
  }
  return String(value);
}
