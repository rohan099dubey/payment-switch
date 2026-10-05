import { status as Status } from '@grpc/grpc-js';
import { classify, makeGrpcError } from '@switch/common';
import { DatabaseError } from 'pg';
import { describe, expect, it } from 'vitest';
import { databaseRejectionOf } from '../../src/repo/journalRepo';

function pgError(code: string | undefined, message = 'boom'): DatabaseError {
  const err = new DatabaseError(message, message.length, 'error');
  err.code = code;
  return err;
}

describe('databaseRejectionOf (ADR-017)', () => {
  it('recognises RAISE EXCEPTION from the ledger triggers (P0001)', () => {
    expect(databaseRejectionOf(pgError('P0001', 'journal x unbalanced: debits 100 credits 99'))).toEqual({
      sqlstate: 'P0001',
      message: 'journal x unbalanced: debits 100 credits 99',
    });
  });

  it('recognises a CHECK violation (23514)', () => {
    expect(databaseRejectionOf(pgError('23514'))).toEqual({ sqlstate: '23514', message: 'boom' });
  });

  it.each([
    ['unique violation', '23505'],
    ['serialization failure', '40001'],
    ['deadlock', '40P01'],
    ['connection failure', '08006'],
    ['admin shutdown', '57P01'],
    ['no code', undefined],
  ])('ignores %s, which may be transient or is handled elsewhere', (_name, code) => {
    expect(databaseRejectionOf(pgError(code))).toBeNull();
  });

  it('ignores errors that are not from Postgres, even with a matching code property', () => {
    const lookalike = Object.assign(new Error('not pg'), { code: 'P0001' });
    expect(databaseRejectionOf(lookalike)).toBeNull();
    expect(databaseRejectionOf('P0001')).toBeNull();
    expect(databaseRejectionOf(null)).toBeNull();
  });

  it('the status the handler sends for it is classified BUG by the Orchestrator, not UNKNOWN_OUTCOME', () => {
    const sent = makeGrpcError(Status.FAILED_PRECONDITION, 'LEDGER_INVARIANT_VIOLATION', 'rejected');
    expect(classify(sent, 'ledger')).toBe('BUG');
    // What it used to be: instrument() turned the raw pg error into INTERNAL.
    expect(classify(makeGrpcError(Status.INTERNAL, 'INTERNAL', 'internal error'), 'ledger')).toBe('UNKNOWN_OUTCOME');
  });
});
