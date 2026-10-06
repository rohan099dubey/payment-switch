import { TransferState } from '@switch/proto-gen/orchestrator/v1';
import { describe, expect, it } from 'vitest';
import {
  createStatusCode,
  mapGrpcError,
  publicStatus,
  stateName,
  toTransferResource,
  type StateName,
} from '../src/mappers';
import { grpcError, Status, transfer } from './harness';

const ALL: StateName[] = [
  'INITIATED',
  'DEBIT_SENT',
  'DEBITED',
  'CREDIT_SENT',
  'CREDITED',
  'SUCCESS',
  'FAILED',
  'REVERSING',
  'REVERSED',
  'NEEDS_MANUAL_REVIEW',
];

describe('state -> public status and HTTP status (section 5)', () => {
  it('maps every state', () => {
    expect(Object.fromEntries(ALL.map((s) => [s, publicStatus(s)]))).toEqual({
      INITIATED: 'PENDING',
      DEBIT_SENT: 'PENDING',
      DEBITED: 'PENDING',
      CREDIT_SENT: 'PENDING',
      CREDITED: 'PENDING',
      SUCCESS: 'SUCCEEDED',
      FAILED: 'FAILED',
      REVERSING: 'PENDING',
      REVERSED: 'REVERSED',
      NEEDS_MANUAL_REVIEW: 'UNDER_REVIEW',
    });
  });

  it('first response and replay codes for every state', () => {
    const table = Object.fromEntries(ALL.map((s) => [s, [createStatusCode(s, false), createStatusCode(s, true)]]));
    expect(table).toEqual({
      INITIATED: [202, 202],
      DEBIT_SENT: [202, 202],
      DEBITED: [202, 202],
      CREDIT_SENT: [202, 202],
      CREDITED: [202, 202],
      SUCCESS: [201, 200],
      FAILED: [422, 422],
      REVERSING: [202, 202],
      REVERSED: [422, 422],
      NEEDS_MANUAL_REVIEW: [202, 202],
    });
  });

  it('every proto state has a name; UNSPECIFIED and unknown values are a contract violation', () => {
    const named = Object.values(TransferState)
      .filter((v): v is TransferState => typeof v === 'number')
      .filter((v) => v !== TransferState.TRANSFER_STATE_UNSPECIFIED && v !== TransferState.UNRECOGNIZED);
    expect(named.map(stateName).sort()).toEqual([...ALL].sort());
    expect(() => stateName(TransferState.TRANSFER_STATE_UNSPECIFIED)).toThrow();
    expect(() => stateName(TransferState.UNRECOGNIZED)).toThrow();
  });
});

describe('toTransferResource', () => {
  it('turns empty proto strings into null and the amount into a JSON number', () => {
    const r = toTransferResource(transfer({ note: '', failureCode: '', failureMessage: '', amount: '10000000' }));
    expect(r).toMatchObject({ note: null, failure_code: null, failure_message: null, amount: 10_000_000 });
  });

  it('refuses an amount that cannot be a safe JSON number', () => {
    expect(() => toTransferResource(transfer({ amount: '9007199254740993' }))).toThrow(/safe integer/);
  });
});

describe('mapGrpcError', () => {
  it.each([
    [Status.INVALID_ARGUMENT, 'INVALID_AMOUNT', 'create', 400, 'INVALID_AMOUNT'],
    [Status.INVALID_ARGUMENT, 'UNSUPPORTED_CURRENCY', 'create', 400, 'UNSUPPORTED_CURRENCY'],
    [Status.ALREADY_EXISTS, 'IDEMPOTENCY_KEY_REUSED', 'create', 409, 'IDEMPOTENCY_KEY_REUSED'],
    [Status.NOT_FOUND, 'TRANSFER_NOT_FOUND', 'get', 404, 'TRANSFER_NOT_FOUND'],
    [Status.NOT_FOUND, 'TRANSFER_NOT_FOUND', 'create', 500, 'INTERNAL'],
    [Status.UNAVAILABLE, 'X', 'get', 503, 'UPSTREAM_UNAVAILABLE'],
    [Status.DEADLINE_EXCEEDED, 'X', 'create', 504, 'UPSTREAM_TIMEOUT'],
    [Status.CANCELLED, 'X', 'create', 500, 'INTERNAL'],
    [Status.PERMISSION_DENIED, 'X', 'get', 500, 'INTERNAL'],
    [Status.RESOURCE_EXHAUSTED, 'X', 'create', 500, 'INTERNAL'],
  ] as const)('%s %s on %s -> %i %s', (code, trailer, op, status, apiCode) => {
    const mapped = mapGrpcError(grpcError(code, trailer), op);
    expect([mapped.statusCode, mapped.code]).toEqual([status, apiCode]);
  });

  it('INVALID_ARGUMENT without a trailer defaults to VALIDATION_ERROR', () => {
    const err = Object.assign(new Error('bad'), { code: Status.INVALID_ARGUMENT, details: 'bad' });
    expect(mapGrpcError(err, 'create').code).toBe('VALIDATION_ERROR');
  });
});
