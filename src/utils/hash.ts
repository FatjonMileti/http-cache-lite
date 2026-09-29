import { createHash } from 'node:crypto';

/** SHA-1 hex digest of the given input. Used for deterministic ETags. */
export function sha1Hex(input: string | Uint8Array): string {
  return createHash('sha1').update(input).digest('hex');
}

/** Byte length of a value: strings (UTF-8), Buffers/Uint8Arrays, else 0. */
export function byteSize(value: unknown): number {
  if (typeof value === 'string') {
    return Buffer.byteLength(value, 'utf8');
  }
  if (value instanceof Uint8Array) {
    return value.byteLength;
  }
  if (ArrayBuffer.isView(value)) {
    return value.byteLength;
  }
  return 0;
}

/** Remove duplicates while preserving first-seen order. */
export function dedupeStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/** Validate that `ttl` is a usable millisecond duration. */
export function assertValidTtl(ttl: number, what = 'ttl'): void {
  if (typeof ttl !== 'number' || !Number.isFinite(ttl) || ttl < 0) {
    throw new TypeError(`${what} must be a finite number >= 0, received: ${String(ttl)}`);
  }
}
