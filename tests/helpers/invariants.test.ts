/**
 * Unit tests (no I/O) for the pure invariant checks: each must accept correct evidence and
 * reject each way the books can be wrong. The live data already showed I3/I4/I5 catching
 * the M3 mutation artifacts (ADR-021); these pin every branch deterministically.
 */
import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import {
  checkI5,
  checkI6,
  checkI7,
  checkI8,
  checkI9,
  checkScoped,
  readQuery,
  type Evidence,
  type NotificationFacts,
  type OutboxFacts,
  type RunTransfer,
} from './invariants';
import type { JournalView } from './ledgerClient';

const AMOUNT = 1000n;

function transfer(state: string, overrides: Partial<RunTransfer> = {}): RunTransfer {
  return {
    id: `t-${state}`,
    idempotencyKey: `k-${state}`,
    state,
    failureCode: null,
    payerBank: 'bank_a',
    payeeBank: 'bank_b',
    amount: AMOUNT,
    ...overrides,
  };
}

const applied = { status: 'APPLIED' as const, amount: AMOUNT };
const none = { status: 'NOT_FOUND' as const, amount: 0n };
const voided = { status: 'VOIDED' as const, amount: 0n };

function journal(kind: string, debit: string, credit: string, amount = AMOUNT): JournalView {
  return {
    kind,
    lines: [
      { accountCode: debit, direction: 'D', amount },
      { accountCode: credit, direction: 'C', amount },
    ],
  };
}
const debitLeg = journal('TRANSFER_DEBIT_LEG', 'receivable:bank_a', 'transit');
const creditLeg = journal('TRANSFER_CREDIT_LEG', 'transit', 'payable:bank_b');
const reversal = journal('TRANSFER_REVERSAL', 'transit', 'receivable:bank_a');

const success = (): Evidence => ({
  transfer: transfer('SUCCESS'),
  debit: applied,
  credit: applied,
  reverse: none,
  journals: [debitLeg, creditLeg],
});
const reversed = (): Evidence => ({
  transfer: transfer('REVERSED'),
  debit: applied,
  credit: none,
  reverse: applied,
  journals: [debitLeg, reversal],
});
const failed = (): Evidence => ({
  transfer: transfer('FAILED'),
  debit: voided,
  credit: none,
  reverse: none,
  journals: [],
});

describe('I5 — exactly-once effects by final state', () => {
  it('accepts correct SUCCESS, REVERSED and FAILED evidence', () => {
    expect(checkI5([success(), reversed(), failed()]).problems).toEqual([]);
  });

  it.each([
    ['SUCCESS without the credit', { ...success(), credit: none }],
    ['SUCCESS with a refund as well', { ...success(), reverse: applied }],
    ['SUCCESS missing the credit leg', { ...success(), journals: [debitLeg] }],
    ['SUCCESS with a duplicate debit leg', { ...success(), journals: [debitLeg, debitLeg, creditLeg] }],
    ['SUCCESS debited the wrong amount', { ...success(), debit: { status: 'APPLIED' as const, amount: 999n } }],
    [
      'SUCCESS journal line with the wrong amount',
      { ...success(), journals: [debitLeg, journal('TRANSFER_CREDIT_LEG', 'transit', 'payable:bank_b', 1n)] },
    ],
    ['REVERSED without the refund', { ...reversed(), reverse: none }],
    ['REVERSED although the payee was credited', { ...reversed(), credit: applied }],
    ['REVERSED missing the reversal journal (the M3 mutant B artifact)', { ...reversed(), journals: [debitLeg] }],
    ['FAILED although the debit applied', { ...failed(), debit: applied }],
    ['FAILED with a journal', { ...failed(), journals: [debitLeg] }],
    ['FAILED with a voided credit row', { ...failed(), credit: voided }],
    ['a non-terminal transfer', { ...success(), transfer: transfer('DEBIT_SENT') }],
  ])('rejects %s', (_name, evidence) => {
    const result = checkI5([evidence]);
    expect(result.ok).toBe(false);
    expect(result.problems.length).toBeGreaterThan(0);
  });
});

describe('scoped I2–I4 (no baseline)', () => {
  it('balanced evidence passes all three', () => {
    expect(checkScoped([success(), reversed(), failed()]).map((r) => r.ok)).toEqual([true, true, true]);
  });

  it('a missing reversal journal moves transit and breaks bank_a (as found in the live data)', () => {
    const [i2, i3, i4] = checkScoped([{ ...reversed(), journals: [debitLeg] }]);
    expect(i2?.ok).toBe(true); // the money itself was refunded...
    expect(i3?.problems).toEqual([`transit moved by ${AMOUNT}`]); // ...but the books say otherwise
    expect(i4?.ok).toBe(false);
  });

  it('a debit leg that credits payable instead of transit (M3 mutant E) is caught', () => {
    const wrong = journal('TRANSFER_DEBIT_LEG', 'receivable:bank_a', 'payable:bank_a');
    const [, i3, i4] = checkScoped([{ ...success(), journals: [wrong, creditLeg] }]);
    expect(i3?.ok).toBe(false);
    expect(i4?.ok).toBe(false);
  });

  it('money that left a payer but never reached a payee breaks I2', () => {
    const [i2] = checkScoped([{ ...success(), credit: none }]);
    expect(i2?.ok).toBe(false);
  });
});

describe('I6 and I7', () => {
  it('I6 rejects non-terminal and manual-review transfers', () => {
    expect(checkI6([transfer('SUCCESS'), transfer('FAILED'), transfer('REVERSED')]).ok).toBe(true);
    expect(checkI6([transfer('CREDIT_SENT')]).ok).toBe(false);
    expect(checkI6([transfer('NEEDS_MANUAL_REVIEW', { failureCode: 'RECOVERY_EXHAUSTED' })]).ok).toBe(false);
  });

  it('I7 needs one id per key, equal to the stored transfer, which is terminal', () => {
    const stored = [transfer('SUCCESS', { id: 'x', idempotencyKey: 'k' })];
    expect(checkI7([{ idempotencyKey: 'k', responseIds: ['x', 'x'] }], stored).ok).toBe(true);
    expect(checkI7([{ idempotencyKey: 'k', responseIds: ['x', 'y'] }], stored).ok).toBe(false);
    expect(checkI7([{ idempotencyKey: 'k', responseIds: ['y'] }], stored).ok).toBe(false);
    expect(checkI7([{ idempotencyKey: 'missing', responseIds: ['x'] }], stored).ok).toBe(false);
    const pending = [transfer('DEBIT_SENT', { id: 'x', idempotencyKey: 'k' })];
    expect(checkI7([{ idempotencyKey: 'k', responseIds: ['x'] }], pending).ok).toBe(false);
  });
});

describe('checkI8 (the outbox, ADR-025)', () => {
  const cutoff = new Date('2026-10-07T00:00:00Z');
  const after = new Date('2026-10-07T01:00:00Z');
  const before = new Date('2026-10-06T23:00:00Z');
  const facts = (overrides: Partial<OutboxFacts> = {}): OutboxFacts => ({
    transferId: 't1',
    state: 'SUCCESS',
    amount: 12_500n,
    terminalAt: after,
    events: [
      {
        eventType: 'transfer.succeeded',
        payload: { transfer_id: 't1', state: 'SUCCESS', amount: '12500' },
        publishedAt: after,
      },
    ],
    ...overrides,
  });

  it('holds for one published event of the matching type', () => {
    expect(checkI8([facts()], cutoff, true).ok).toBe(true);
  });

  it('fails a terminal transfer with no event, or with two', () => {
    expect(checkI8([facts({ events: [] })], cutoff, true).ok).toBe(false);
    const one = facts().events;
    expect(checkI8([facts({ events: [...one, ...one] })], cutoff, true).ok).toBe(false);
  });

  it('fails an event of the wrong type, or a payload naming another transfer, state or amount', () => {
    const wrongType = facts({ state: 'FAILED' });
    expect(checkI8([wrongType], cutoff, true).ok).toBe(false);
    for (const payload of [
      { transfer_id: 'other', state: 'SUCCESS', amount: '12500' },
      { transfer_id: 't1', state: 'FAILED', amount: '12500' },
      { transfer_id: 't1', state: 'SUCCESS', amount: 12500 },
    ]) {
      const f = facts({ events: [{ eventType: 'transfer.succeeded', payload, publishedAt: after }] });
      expect(checkI8([f], cutoff, true).ok).toBe(false);
    }
  });

  it('requires publication only on a quiet stack', () => {
    const [event] = facts().events;
    if (event === undefined) throw new Error('fixture has no event');
    const unpublished = facts({ events: [{ ...event, publishedAt: null }] });
    expect(checkI8([unpublished], cutoff, true).ok).toBe(false);
    expect(checkI8([unpublished], cutoff, false).ok).toBe(true);
  });

  it('expects no event before the outbox existed, nor for a non-terminal transfer', () => {
    expect(checkI8([facts({ terminalAt: before, events: [] })], cutoff, true).ok).toBe(true);
    expect(checkI8([facts({ terminalAt: before })], cutoff, true).ok).toBe(false);
    expect(checkI8([facts({ state: 'DEBIT_SENT', terminalAt: null, events: [] })], cutoff, true).ok).toBe(true);
    expect(checkI8([facts({ state: 'DEBIT_SENT', terminalAt: null })], cutoff, true).ok).toBe(false);
  });
});

describe('readQuery (ADR-021, 2026-10-07 amendment)', () => {
  const ok = { rows: [{ n: 1 }] };
  const fakePool = (answers: unknown[]): { pool: Pool; calls: () => number } => {
    let calls = 0;
    const pool = {
      query: () => {
        const next = answers[calls++];
        return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
      },
    } as unknown as Pool;
    return { pool, calls: () => calls };
  };
  const reset = (): Error => Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });

  it('retries a reset connection and returns the result', { timeout: 10_000 }, async () => {
    const { pool, calls } = fakePool([reset(), ok]);
    expect((await readQuery(pool, 'SELECT 1')).rows).toEqual([{ n: 1 }]);
    expect(calls()).toBe(2);
  });

  it('gives up after three attempts', { timeout: 10_000 }, async () => {
    const { pool, calls } = fakePool([reset(), reset(), reset(), ok]);
    await expect(readQuery(pool, 'SELECT 1')).rejects.toThrow('ECONNRESET');
    expect(calls()).toBe(3);
  });

  it('never retries a SQL error', async () => {
    const sqlError = Object.assign(new Error('relation does not exist'), { code: '42P01' });
    const { pool, calls } = fakePool([sqlError, ok]);
    await expect(readQuery(pool, 'SELECT 1')).rejects.toThrow('relation does not exist');
    expect(calls()).toBe(1);
  });
});

describe('checkI9 (notifications, ADR-026)', () => {
  const fact = (overrides: Partial<NotificationFacts> = {}): NotificationFacts => ({
    eventId: '1',
    transferId: 't1',
    payeeAccountId: 'ACC002',
    outcome: 'DELIVERED',
    attempts: 1,
    ...overrides,
  });

  it('holds when each published event has its expected outcome', () => {
    expect(
      checkI9([fact(), fact({ eventId: '2', payeeAccountId: 'whfail-x', outcome: 'DEAD_LETTERED', attempts: 5 })]).ok,
    ).toBe(true);
  });

  it('fails an event with no outcome, the wrong outcome, or an impossible attempt count', () => {
    expect(checkI9([fact({ outcome: null, attempts: null })]).ok).toBe(false);
    expect(checkI9([fact({ outcome: 'DEAD_LETTERED' })]).ok).toBe(false);
    expect(checkI9([fact({ payeeAccountId: 'whfail-x' })]).ok).toBe(false);
    expect(checkI9([fact({ attempts: 6 })]).ok).toBe(false);
  });
});
