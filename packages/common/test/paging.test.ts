import { describe, expect, it } from 'vitest';
import { decodePageToken, encodePageToken, pageSize } from '../src/paging';

describe('page tokens (ADR-027)', () => {
  it('round-trips a sort key, microseconds included', () => {
    const key = ['2026-10-07 06:31:08.075123+00', '3826712e-725b-44ea-a8cf-5f41a346c6b2', 'DEBIT'];
    expect(decodePageToken(encodePageToken(key), 3)).toEqual(key);
  });

  it('rejects garbage, the wrong arity and non-string parts', () => {
    expect(decodePageToken('not-a-token', 3)).toBeNull();
    expect(decodePageToken(encodePageToken(['a', 'b']), 3)).toBeNull();
    expect(decodePageToken(Buffer.from('[1,2]').toString('base64url'), 2)).toBeNull();
  });

  it('page sizes: 0 means the maximum; outside 0..max is invalid', () => {
    expect(pageSize(0)).toBe(1000);
    expect(pageSize(250)).toBe(250);
    expect(pageSize(1001)).toBeNull();
    expect(pageSize(-1)).toBeNull();
    expect(pageSize(1.5)).toBeNull();
  });
});
