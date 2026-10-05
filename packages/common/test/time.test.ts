import { describe, expect, it } from 'vitest';
import { backoffMs, sleep } from '../src/time';

const ZERO = (): number => 0;
const ALMOST_ONE = (): number => 0.999999;

describe('backoffMs', () => {
  it('doubles from 1000 ms with no jitter at random() = 0', () => {
    expect([0, 1, 2, 3, 4, 5].map((n) => backoffMs(n, ZERO))).toEqual([1000, 2000, 4000, 8000, 16000, 32000]);
  });

  it('caps the base at 60000 ms', () => {
    expect(backoffMs(6, ZERO)).toBe(60000);
    expect(backoffMs(20, ZERO)).toBe(60000);
    expect(backoffMs(2000, ZERO)).toBe(60000);
  });

  it('adds at most 20 percent jitter', () => {
    expect(backoffMs(0, ALMOST_ONE)).toBe(1199);
    expect(backoffMs(3, ALMOST_ONE)).toBe(9599);
    expect(backoffMs(30, ALMOST_ONE)).toBe(71999);
    expect(backoffMs(0, () => 0.5)).toBe(1100);
  });

  it('stays within [base, base * 1.2] for random draws at every attempt', () => {
    for (let attempt = 0; attempt <= 25; attempt++) {
      const base = Math.min(1000 * 2 ** attempt, 60000);
      for (let i = 0; i < 200; i++) {
        const delay = backoffMs(attempt);
        expect(Number.isInteger(delay)).toBe(true);
        expect(delay).toBeGreaterThanOrEqual(base);
        expect(delay).toBeLessThanOrEqual(base * 1.2);
      }
    }
  });

  it('rejects invalid attempt numbers', () => {
    expect(() => backoffMs(-1)).toThrow(RangeError);
    expect(() => backoffMs(1.5)).toThrow(RangeError);
    expect(() => backoffMs(Number.NaN)).toThrow(RangeError);
  });

  it('rejects a random source outside [0, 1)', () => {
    expect(() => backoffMs(0, () => 1)).toThrow(RangeError);
    expect(() => backoffMs(0, () => -0.1)).toThrow(RangeError);
  });
});

describe('sleep', () => {
  it('resolves after the delay', async () => {
    const started = Date.now();
    await sleep(20);
    expect(Date.now() - started).toBeGreaterThanOrEqual(15);
  });

  it('rejects when aborted', async () => {
    const controller = new AbortController();
    const pending = sleep(10_000, controller.signal);
    controller.abort(new Error('stop'));
    await expect(pending).rejects.toThrow('stop');
  });

  it('rejects immediately on an already-aborted signal', async () => {
    await expect(sleep(10_000, AbortSignal.abort())).rejects.toBeInstanceOf(Error);
  });
});
