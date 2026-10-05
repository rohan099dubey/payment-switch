export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function abortError(signal: AbortSignal | undefined): Error {
  const reason: unknown = signal?.reason;
  return reason instanceof Error ? reason : new Error('sleep aborted');
}

export const RECOVERY_BACKOFF_BASE_MS = 1000;
export const RECOVERY_BACKOFF_MAX_MS = 60_000;
export const RECOVERY_BACKOFF_JITTER = 0.2;

/**
 * Recovery delay for the given attempt count (spec section 14):
 * `min(1000 * 2^attempt, 60000)` plus up to 20 percent jitter.
 *
 * `random` must return a value in [0, 1); it is injectable so tests are deterministic.
 * The result is an integer in [base, floor(base * 1.2)].
 */
export function backoffMs(attempt: number, random: () => number = Math.random): number {
  if (!Number.isSafeInteger(attempt) || attempt < 0) {
    throw new RangeError(`backoffMs: attempt must be a non-negative integer, got ${attempt}`);
  }
  const base = Math.min(RECOVERY_BACKOFF_BASE_MS * 2 ** attempt, RECOVERY_BACKOFF_MAX_MS);
  const r = random();
  if (!(r >= 0 && r < 1)) {
    throw new RangeError(`backoffMs: random() must return a value in [0, 1), got ${r}`);
  }
  return base + Math.floor(base * RECOVERY_BACKOFF_JITTER * r);
}
