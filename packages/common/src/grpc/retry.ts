import { sleep as defaultSleep } from '../time';

export interface RetryOptions {
  /** Total attempts including the first, at least 1. `INLINE_BANK_RETRIES = 2` means 3. */
  attempts: number;
  baseMs: number;
  maxMs: number;
  /**
   * Whether an error may be retried. Required, with no default, because retrying the
   * wrong class (a definite failure or a bug) is a correctness bug: callers pass
   * `(err) => classify(err, target) === 'UNKNOWN_OUTCOME'`.
   */
  shouldRetry: (err: unknown) => boolean;
  /** Called before each retry; used for logging and the downstream-call metric. */
  onRetry?: (err: unknown, attempt: number, delayMs: number) => void;
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** Full-jitter delay before retry number `retry` (1-based): uniform in [0, min(max, base * 2^(retry-1))). */
export function fullJitterDelayMs(retry: number, baseMs: number, maxMs: number, random: () => number): number {
  const cap = Math.min(maxMs, baseMs * 2 ** (retry - 1));
  return Math.floor(random() * cap);
}

/**
 * Runs `fn` up to `attempts` times with exponential backoff and full jitter. Retries
 * only errors `shouldRetry` accepts; anything else, and the last error, is rethrown.
 */
export async function withRetry<T>(fn: (attempt: number) => Promise<T>, options: RetryOptions): Promise<T> {
  const { attempts, baseMs, maxMs, shouldRetry, onRetry } = options;
  if (!Number.isSafeInteger(attempts) || attempts < 1) {
    throw new RangeError(`withRetry: attempts must be an integer >= 1, got ${attempts}`);
  }
  if (!(baseMs >= 0) || !(maxMs >= baseMs)) {
    throw new RangeError(`withRetry: need 0 <= baseMs <= maxMs, got ${baseMs} and ${maxMs}`);
  }
  const random = options.random ?? Math.random;
  const sleep = options.sleep ?? defaultSleep;

  for (let attempt = 1; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      if (attempt >= attempts || !shouldRetry(err)) throw err;
      const delayMs = fullJitterDelayMs(attempt, baseMs, maxMs, random);
      onRetry?.(err, attempt, delayMs);
      await sleep(delayMs);
    }
  }
}
