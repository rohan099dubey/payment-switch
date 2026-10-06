/**
 * Unit tests (no I/O) for the pure invariant checks: each must accept correct evidence and
 * reject each way the books can be wrong. The live data already showed I3/I4/I5 catching
 * the M3 mutation artifacts (ADR-021); these pin every branch deterministically.
 */
import { describe, expect, it } from 'vitest';
import { checkI5, checkI6, checkI7, checkScoped, type Evidence, type RunTransfer } from './invariants';
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
