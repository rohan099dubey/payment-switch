import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../../src/chaos/prng';

function take(random: () => number, n: number): number[] {
  return Array.from({ length: n }, () => random());
}

describe('mulberry32', () => {
  it('is deterministic: the same seed gives the same sequence', () => {
    expect(take(mulberry32(42), 1000)).toEqual(take(mulberry32(42), 1000));
  });

  it('gives different sequences for different seeds', () => {
    expect(take(mulberry32(42), 10)).not.toEqual(take(mulberry32(43), 10));
  });

  it('treats seeds modulo 2^32, so any uint32 works including 0 and the maximum', () => {
    expect(take(mulberry32(0), 5)).toEqual(take(mulberry32(2 ** 32), 5));
    const max = take(mulberry32(0xffffffff), 100);
    expect(max.every((v) => v >= 0 && v < 1)).toBe(true);
  });

  it('stays in [0, 1)', () => {
    const values = take(mulberry32(7), 100_000);
    expect(Math.min(...values)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...values)).toBeLessThan(1);
  });

  it('is roughly uniform: each tenth of [0, 1) gets about 10 percent of 100k draws', () => {
    const buckets = new Array<number>(10).fill(0);
    for (const v of take(mulberry32(12345), 100_000)) {
      const i = Math.floor(v * 10);
      buckets[i] = (buckets[i] ?? 0) + 1;
    }
    for (const count of buckets) {
      expect(count).toBeGreaterThan(9_500);
      expect(count).toBeLessThan(10_500);
    }
  });
});
