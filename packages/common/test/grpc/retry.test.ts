import { describe, expect, it } from 'vitest';
import { fullJitterDelayMs, withRetry } from '../../src/grpc/retry';

const noSleep =
  (delays: number[]) =>
  (ms: number): Promise<void> => {
    delays.push(ms);
    return Promise.resolve();
  };

describe('withRetry', () => {
  it('returns the first success without retrying', async () => {
    let calls = 0;
    const result = await withRetry(
      () => {
        calls++;
        return Promise.resolve('ok');
      },
      { attempts: 3, baseMs: 100, maxMs: 800, shouldRetry: () => true, sleep: noSleep([]) },
    );
    expect(result).toBe('ok');
    expect(calls).toBe(1);
  });

  it('retries retryable errors until success, passing the attempt number', async () => {
    const seen: number[] = [];
    const result = await withRetry(
      (attempt) => {
        seen.push(attempt);
        return attempt < 3 ? Promise.reject(new Error('flaky')) : Promise.resolve(attempt);
      },
      { attempts: 3, baseMs: 100, maxMs: 800, shouldRetry: () => true, sleep: noSleep([]) },
    );
    expect(result).toBe(3);
    expect(seen).toEqual([1, 2, 3]);
  });

  it('makes exactly `attempts` calls, then rethrows the last error', async () => {
    let calls = 0;
    await expect(
      withRetry(
        () => {
          calls++;
          return Promise.reject(new Error(`fail ${calls}`));
        },
        { attempts: 3, baseMs: 100, maxMs: 800, shouldRetry: () => true, sleep: noSleep([]) },
      ),
    ).rejects.toThrow('fail 3');
    expect(calls).toBe(3);
  });

  it('never retries an error shouldRetry rejects', async () => {
    let calls = 0;
    await expect(
      withRetry(
        () => {
          calls++;
          return Promise.reject(new Error('definite'));
        },
        { attempts: 5, baseMs: 100, maxMs: 800, shouldRetry: () => false, sleep: noSleep([]) },
      ),
    ).rejects.toThrow('definite');
    expect(calls).toBe(1);
  });

  it('sleeps a full-jitter delay between attempts and reports each retry', async () => {
    const delays: number[] = [];
    const retries: [number, number][] = [];
    await expect(
      withRetry(() => Promise.reject(new Error('x')), {
        attempts: 5,
        baseMs: 100,
        maxMs: 800,
        shouldRetry: () => true,
        random: () => 0.999999,
        sleep: noSleep(delays),
        onRetry: (_err, attempt, delayMs) => retries.push([attempt, delayMs]),
      }),
    ).rejects.toThrow('x');
    // caps: 100, 200, 400, 800 -> floor(cap * 0.999999)
    expect(delays).toEqual([99, 199, 399, 799]);
    expect(retries).toEqual([
      [1, 99],
      [2, 199],
      [3, 399],
      [4, 799],
    ]);
  });

  it('rejects invalid options', async () => {
    const fn = (): Promise<number> => Promise.resolve(1);
    await expect(withRetry(fn, { attempts: 0, baseMs: 1, maxMs: 1, shouldRetry: () => true })).rejects.toThrow(
      RangeError,
    );
    await expect(withRetry(fn, { attempts: 1, baseMs: 10, maxMs: 5, shouldRetry: () => true })).rejects.toThrow(
      RangeError,
    );
  });
});

describe('fullJitterDelayMs', () => {
  it('is uniform below min(maxMs, baseMs * 2^(retry-1))', () => {
    expect(fullJitterDelayMs(1, 100, 800, () => 0)).toBe(0);
    expect(fullJitterDelayMs(10, 100, 800, () => 0.5)).toBe(400);
    for (let retry = 1; retry <= 10; retry++) {
      for (let i = 0; i < 100; i++) {
        const delay = fullJitterDelayMs(retry, 100, 800, Math.random);
        expect(delay).toBeGreaterThanOrEqual(0);
        expect(delay).toBeLessThan(Math.min(800, 100 * 2 ** (retry - 1)));
      }
    }
  });
});
