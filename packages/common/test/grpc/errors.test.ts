import { Metadata, status as Status } from '@grpc/grpc-js';
import { describe, expect, it } from 'vitest';
import {
  classify,
  ERROR_CODE_TRAILER,
  errorCodeOf,
  GrpcError,
  isGrpcError,
  makeGrpcError,
  type ErrorClass,
} from '../../src/grpc/errors';

/** Shaped like the ServiceError grpc-js hands a client callback. */
function serviceError(code: Status, errorCode?: string): Error {
  const metadata = new Metadata();
  if (errorCode !== undefined) metadata.set(ERROR_CODE_TRAILER, errorCode);
  return Object.assign(new Error(`${Status[code]}: test`), { code, details: 'test', metadata });
}

const ALL_CODES = Object.values(Status).filter((v): v is Status => typeof v === 'number');

/** Spec section 14 classification table, written out by hand for every status code. */
const BANK: Record<string, ErrorClass> = {
  OK: 'UNKNOWN_OUTCOME',
  CANCELLED: 'UNKNOWN_OUTCOME',
  UNKNOWN: 'UNKNOWN_OUTCOME',
  INVALID_ARGUMENT: 'BUG',
  DEADLINE_EXCEEDED: 'UNKNOWN_OUTCOME',
  NOT_FOUND: 'DEFINITE_FAILURE',
  ALREADY_EXISTS: 'UNKNOWN_OUTCOME',
  PERMISSION_DENIED: 'BUG',
  RESOURCE_EXHAUSTED: 'UNKNOWN_OUTCOME',
  FAILED_PRECONDITION: 'DEFINITE_FAILURE',
  ABORTED: 'UNKNOWN_OUTCOME',
  OUT_OF_RANGE: 'UNKNOWN_OUTCOME',
  UNIMPLEMENTED: 'BUG',
  INTERNAL: 'UNKNOWN_OUTCOME',
  UNAVAILABLE: 'UNKNOWN_OUTCOME',
  DATA_LOSS: 'UNKNOWN_OUTCOME',
  UNAUTHENTICATED: 'BUG',
};

const LEDGER: Record<string, ErrorClass> = {
  ...BANK,
  INVALID_ARGUMENT: 'BUG',
  NOT_FOUND: 'BUG',
  ALREADY_EXISTS: 'BUG',
  FAILED_PRECONDITION: 'BUG',
};

describe('classify — every status code, no x-error-code', () => {
  it('covers all 17 gRPC status codes', () => {
    expect(ALL_CODES).toHaveLength(17);
    expect(Object.keys(BANK).sort()).toEqual(ALL_CODES.map((c) => Status[c]).sort());
  });

  for (const code of ALL_CODES) {
    const name = Status[code];
    it(`bank ${name} -> ${BANK[name]}`, () => {
      expect(classify(serviceError(code), 'bank')).toBe(BANK[name]);
    });
    it(`ledger ${name} -> ${LEDGER[name]}`, () => {
      expect(classify(serviceError(code), 'ledger')).toBe(LEDGER[name]);
    });
  }
});

describe('classify — bank error codes (spec section 8 table)', () => {
  const cases: [Status, string, ErrorClass][] = [
    [Status.FAILED_PRECONDITION, 'INSUFFICIENT_FUNDS', 'DEFINITE_FAILURE'],
    [Status.FAILED_PRECONDITION, 'ACCOUNT_BLOCKED', 'DEFINITE_FAILURE'],
    [Status.NOT_FOUND, 'ACCOUNT_NOT_FOUND', 'DEFINITE_FAILURE'],
    [Status.FAILED_PRECONDITION, 'REFERENCE_VOIDED', 'DEFINITE_FAILURE'],
    [Status.FAILED_PRECONDITION, 'NOTHING_TO_REVERSE', 'BUG'],
    [Status.INVALID_ARGUMENT, 'REFERENCE_CONFLICT', 'BUG'],
    [Status.INVALID_ARGUMENT, 'CURRENCY_MISMATCH', 'DEFINITE_FAILURE'],
  ];
  for (const [code, errorCode, expected] of cases) {
    it(`${Status[code]} / ${errorCode} -> ${expected}`, () => {
      expect(classify(serviceError(code, errorCode), 'bank')).toBe(expected);
    });
  }
});

describe('classify — ledger ignores bank-specific error codes', () => {
  it('CURRENCY_MISMATCH from the ledger is still a bug', () => {
    expect(classify(serviceError(Status.INVALID_ARGUMENT, 'CURRENCY_MISMATCH'), 'ledger')).toBe('BUG');
  });
  it('IDEMPOTENCY_KEY_REUSED from the ledger is a bug', () => {
    expect(classify(serviceError(Status.ALREADY_EXISTS, 'IDEMPOTENCY_KEY_REUSED'), 'ledger')).toBe('BUG');
  });
});

describe('classify — non-gRPC errors are unknown outcomes', () => {
  const nonGrpc: [string, unknown][] = [
    ['socket reset', Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })],
    ['plain Error', new Error('boom')],
    ['string', 'boom'],
    ['null', null],
    ['undefined', undefined],
    ['out-of-range numeric code', Object.assign(new Error('x'), { code: 99 })],
    ['non-integer code', Object.assign(new Error('x'), { code: 5.5 })],
  ];
  for (const [label, err] of nonGrpc) {
    it(`${label} -> UNKNOWN_OUTCOME for both targets`, () => {
      expect(classify(err, 'bank')).toBe('UNKNOWN_OUTCOME');
      expect(classify(err, 'ledger')).toBe('UNKNOWN_OUTCOME');
    });
  }
});

describe('makeGrpcError / errorCodeOf', () => {
  it('round-trips the x-error-code trailer', () => {
    const err = makeGrpcError(Status.FAILED_PRECONDITION, 'INSUFFICIENT_FUNDS', 'balance too low');
    expect(err).toBeInstanceOf(GrpcError);
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe(Status.FAILED_PRECONDITION);
    expect(err.details).toBe('balance too low');
    expect(err.message).toBe('balance too low');
    expect(errorCodeOf(err)).toBe('INSUFFICIENT_FUNDS');
    expect(isGrpcError(err)).toBe(true);
    expect(classify(err, 'bank')).toBe('DEFINITE_FAILURE');
  });

  it('returns undefined without a trailer or for non-gRPC errors', () => {
    expect(errorCodeOf(serviceError(Status.UNAVAILABLE))).toBeUndefined();
    expect(errorCodeOf(new Error('x'))).toBeUndefined();
    expect(errorCodeOf(Object.assign(new Error('x'), { code: Status.INTERNAL, metadata: {} }))).toBeUndefined();
  });
});
