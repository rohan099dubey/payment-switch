import { describe, expect, it } from 'vitest';
import { canonicalJson, sha256Hex } from '../src/hash';

describe('canonicalJson', () => {
  it('sorts object keys at every depth', () => {
    const a = { payee: { bank_id: 'bank_b', account_id: 'A002' }, amount: 12500, currency: 'INR' };
    const b = { currency: 'INR', amount: 12500, payee: { account_id: 'A002', bank_id: 'bank_b' } };
    expect(canonicalJson(a)).toBe('{"amount":12500,"currency":"INR","payee":{"account_id":"A002","bank_id":"bank_b"}}');
    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });

  it('emits no whitespace', () => {
    expect(canonicalJson({ a: [1, 2, { b: 'x y' }] })).toBe('{"a":[1,2,{"b":"x y"}]}');
  });

  it('preserves array order', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
    expect(canonicalJson([3, 1, 2])).not.toBe(canonicalJson([1, 2, 3]));
  });

  it('serializes primitives like JSON', () => {
    expect(canonicalJson(null)).toBe('null');
    expect(canonicalJson(true)).toBe('true');
    expect(canonicalJson(false)).toBe('false');
    expect(canonicalJson(0)).toBe('0');
    expect(canonicalJson(-1.5)).toBe('-1.5');
    expect(canonicalJson('é"\n')).toBe(JSON.stringify('é"\n'));
  });

  it('writes bigint as a bare number, distinct from the string form', () => {
    expect(canonicalJson({ amount: 12500n })).toBe('{"amount":12500}');
    expect(canonicalJson({ amount: 9007199254740993n })).toBe('{"amount":9007199254740993}');
    expect(canonicalJson({ amount: 12500n })).not.toBe(canonicalJson({ amount: '12500' }));
  });

  it('omits undefined properties but keeps null', () => {
    expect(canonicalJson({ a: undefined, b: null })).toBe('{"b":null}');
    expect(canonicalJson({ a: 1 })).toBe(canonicalJson({ a: 1, note: undefined }));
  });

  it('writes undefined array items as null', () => {
    expect(canonicalJson([1, undefined])).toBe('[1,null]');
  });

  it('honours toJSON (Date)', () => {
    expect(canonicalJson({ at: new Date('2026-10-05T00:00:00.000Z') })).toBe('{"at":"2026-10-05T00:00:00.000Z"}');
  });

  it('accepts null-prototype objects', () => {
    const o = Object.create(null) as Record<string, unknown>;
    o.z = 1;
    o.a = 2;
    expect(canonicalJson(o)).toBe('{"a":2,"z":1}');
  });

  it('rejects values JSON.stringify would silently mangle', () => {
    expect(() => canonicalJson(Number.NaN)).toThrow(TypeError);
    expect(() => canonicalJson(Number.POSITIVE_INFINITY)).toThrow(TypeError);
    expect(() => canonicalJson(undefined)).toThrow(TypeError);
    expect(() => canonicalJson({ f: () => 1 })).toThrow(TypeError);
    expect(() => canonicalJson({ s: Symbol('x') })).toThrow(TypeError);
    expect(() => canonicalJson(new Map([['a', 1]]))).toThrow(TypeError);
    expect(() => canonicalJson(new Set([1]))).toThrow(TypeError);
  });

  it('rejects circular references', () => {
    const o: Record<string, unknown> = {};
    o.self = o;
    expect(() => canonicalJson(o)).toThrow(/circular/);
  });

  it('allows the same object twice when it is not a cycle', () => {
    const shared = { x: 1 };
    expect(canonicalJson({ a: shared, b: shared })).toBe('{"a":{"x":1},"b":{"x":1}}');
  });
});

describe('sha256Hex', () => {
  it('matches the known digest of the empty string and of "abc"', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});
