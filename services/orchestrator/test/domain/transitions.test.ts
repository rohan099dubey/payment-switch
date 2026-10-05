import { describe, expect, it } from 'vitest';
import { TransferState } from '../../src/domain/states';
import type { Transfer } from '../../src/domain/transfer';
import {
  IllegalTransitionError,
  StaleTransferError,
  transition,
  type TransitionDeps,
} from '../../src/domain/transitions';
import { FakeStore, LEASE_OWNER, makeTransfer, silentLogger, type TimelineEntry } from './fakes';

const S = TransferState;

function setup(overrides: Partial<Transfer> = {}): { store: FakeStore; deps: TransitionDeps } {
  const timeline: TimelineEntry[] = [];
  const store = new FakeStore(makeTransfer(overrides), timeline);
  return { store, deps: { store, leaseMs: 15_000, logger: silentLogger } };
}

describe('transition()', () => {
  it('compare-and-sets on id, version, state and lease owner, and records one event', async () => {
    const { store, deps } = setup();
    const updated = await transition(deps, store.row, S.DEBIT_SENT, LEASE_OWNER, {
      reason: 'DEBIT_INTENT',
      detail: { a: 1 },
    });

    expect(updated.state).toBe(S.DEBIT_SENT);
    expect(updated.version).toBe(2);
    expect(store.casRequests).toEqual([
      {
        transferId: store.row.id,
        fromState: S.INITIATED,
        fromVersion: 1,
        toState: S.DEBIT_SENT,
        leaseOwner: LEASE_OWNER,
        leaseMs: 15_000,
        terminal: false,
        failureCode: null,
        failureMessage: null,
        reason: 'DEBIT_INTENT',
        detail: { a: 1 },
      },
    ]);
    expect(store.events).toEqual([{ from: S.INITIATED, to: S.DEBIT_SENT, reason: 'DEBIT_INTENT', detail: { a: 1 } }]);
  });

  it('passes the failure patch and marks terminal targets so the lease is cleared', async () => {
    const { store, deps } = setup({ state: S.DEBIT_SENT });
    const updated = await transition(deps, store.row, S.FAILED, LEASE_OWNER, {
      reason: 'INSUFFICIENT_FUNDS',
      patch: { failureCode: 'INSUFFICIENT_FUNDS', failureMessage: 'insufficient funds' },
    });
    expect(store.casRequests[0]).toMatchObject({
      terminal: true,
      failureCode: 'INSUFFICIENT_FUNDS',
      failureMessage: 'insufficient funds',
    });
    expect(updated.leaseOwner).toBeNull();
    expect(updated.failureCode).toBe('INSUFFICIENT_FUNDS');
  });

  it('throws IllegalTransitionError before touching the store', async () => {
    const { store, deps } = setup({ state: S.SUCCESS });
    await expect(transition(deps, store.row, S.FAILED, LEASE_OWNER, { reason: 'x' })).rejects.toBeInstanceOf(
      IllegalTransitionError,
    );
    const { store: s2, deps: d2 } = setup({ state: S.INITIATED });
    await expect(transition(d2, s2.row, S.DEBITED, LEASE_OWNER, { reason: 'x' })).rejects.toThrow(
      'illegal transfer transition INITIATED -> DEBITED',
    );
    expect(store.casRequests).toHaveLength(0);
    expect(s2.casRequests).toHaveLength(0);
  });

  it.each([
    ['a stale version', { version: 7 }],
    ['a stale state', { state: S.DEBIT_SENT }],
  ])('throws StaleTransferError for %s (zero rows) and writes no event', async (_name, stale) => {
    const { store, deps } = setup();
    // The caller's in-memory copy disagrees with the row: e.g. it thinks the transfer is
    // in DEBIT_SENT at version 7, but the row is INITIATED at version 1.
    const snapshot = { ...store.row, ...stale };
    const to = snapshot.state === S.INITIATED ? S.DEBIT_SENT : S.DEBITED;
    await expect(transition(deps, snapshot, to, LEASE_OWNER, { reason: 'x' })).rejects.toBeInstanceOf(
      StaleTransferError,
    );
    expect(store.events).toHaveLength(0);
    expect(store.row.version).toBe(1);
  });

  it('throws StaleTransferError when the lease belongs to someone else', async () => {
    const { store, deps } = setup({ leaseOwner: 'other:lease' });
    await expect(transition(deps, store.row, S.DEBIT_SENT, LEASE_OWNER, { reason: 'x' })).rejects.toBeInstanceOf(
      StaleTransferError,
    );
    expect(store.row.state).toBe(S.INITIATED);
  });
});
