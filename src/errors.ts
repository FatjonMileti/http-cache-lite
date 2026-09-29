/**
 * Typed errors for http-cache-lite.
 *
 * User-provided factory / callback errors are never wrapped: they propagate
 * to the caller unchanged. These errors are only thrown for misuse of the
 * library itself (invalid options, timeouts, storage failures).
 */

export class HttpCacheError extends Error {
  public readonly code: string;

  public constructor(message: string, code = 'HTTP_CACHE_ERROR') {
    super(message);
    this.name = 'HttpCacheError';
    this.code = code;
    // Maintain a proper prototype chain when targeting ES2022 with ESM/CJS dual output.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class InvalidOptionError extends HttpCacheError {
  public constructor(message: string) {
    super(message, 'INVALID_OPTION');
    this.name = 'InvalidOptionError';
  }
}

export class TimeoutError extends HttpCacheError {
  public constructor(message: string) {
    super(message, 'TIMEOUT');
    this.name = 'TimeoutError';
  }
}

export class StorageError extends HttpCacheError {
  public constructor(message: string, cause?: unknown) {
    super(message, 'STORAGE_ERROR');
    this.name = 'StorageError';
    if (cause !== undefined) {
      (this as { cause?: unknown }).cause = cause;
    }
  }
}
