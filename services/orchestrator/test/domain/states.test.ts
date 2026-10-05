import { describe, expect, it } from 'vitest';
import {
  ALL_STATES,
  ALLOWED_TRANSITIONS,
  canTransition,
  isTerminal,
  NON_TERMINAL_STATES,
  TERMINAL_STATES,
  TransferState,
} from '../../src/domain/states';

const S = TransferState;

/** Section 11's transition table, written out independently of the implementation. */
const LEGAL: ReadonlySet<string> = new Set([
  'INITIATED->DEBIT_SENT',
  'DEBIT_SENT->DEBITED',
  'DEBIT_SENT->FAILED',
  'DEBITED->CREDIT_SENT',
  'CREDIT_SENT->CREDITED',
  'CREDIT_SENT->REVERSING',
  'CREDITED->SUCCESS',
  'REVERSING->REVERSED',
  // Bugs and recovery exhaustion (section 6 step 3, section 13 scenario 14) can strike in any non-terminal state.
  'INITIATED->NEEDS_MANUAL_REVIEW',
  'DEBIT_SENT->NEEDS_MANUAL_REVIEW',
  'DEBITED->NEEDS_MANUAL_REVIEW',
  'CREDIT_SENT->NEEDS_MANUAL_REVIEW',
  'CREDITED->NEEDS_MANUAL_REVIEW',
  'REVERSING->NEEDS_MANUAL_REVIEW',
]);

const pairs = ALL_STATES.flatMap((from) => ALL_STATES.map((to) => [from, to] as const));

describe('transfer states', () => {
  it('has exactly the ten states of the transfers.state CHECK constraint', () => {
    expect([...ALL_STATES].sort()).toEqual(
      [
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
      ].sort(),
    );
  });

  it('has exactly four terminal states', () => {
    expect([...TERMINAL_STATES].sort()).toEqual([S.FAILED, S.NEEDS_MANUAL_REVIEW, S.REVERSED, S.SUCCESS].sort());
    for (const state of ALL_STATES) expect(isTerminal(state)).toBe(TERMINAL_STATES.has(state));
  });

  it('lists the non-terminal states exactly as the recovery claim query does', () => {
    expect(NON_TERMINAL_STATES).toEqual(['INITIATED', 'DEBIT_SENT', 'DEBITED', 'CREDIT_SENT', 'CREDITED', 'REVERSING']);
  });

  it('checks all 100 (from, to) pairs: 14 legal, 86 illegal', () => {
    const legal = pairs.filter(([from, to]) => canTransition(from, to));
    expect(legal).toHaveLength(14);
    expect(pairs).toHaveLength(100);
  });

  it.each(pairs.filter(([f, t]) => LEGAL.has(`${f}->${t}`)))('allows %s -> %s', (from, to) => {
    expect(canTransition(from, to)).toBe(true);
  });

  it.each(pairs.filter(([f, t]) => !LEGAL.has(`${f}->${t}`)))('forbids %s -> %s', (from, to) => {
    expect(canTransition(from, to)).toBe(false);
  });

  it('nothing ever leaves a terminal state', () => {
    for (const terminal of TERMINAL_STATES) expect(ALLOWED_TRANSITIONS[terminal]).toEqual([]);
  });

  it('no state transitions to itself, and nothing returns to INITIATED', () => {
    for (const state of ALL_STATES) {
      expect(canTransition(state, state)).toBe(false);
      expect(canTransition(state, S.INITIATED)).toBe(false);
    }
  });

  it('FAILED is reachable only from DEBIT_SENT, and REVERSED only from REVERSING', () => {
    expect(ALL_STATES.filter((s) => canTransition(s, S.FAILED))).toEqual([S.DEBIT_SENT]);
    expect(ALL_STATES.filter((s) => canTransition(s, S.REVERSED))).toEqual([S.REVERSING]);
    expect(ALL_STATES.filter((s) => canTransition(s, S.SUCCESS))).toEqual([S.CREDITED]);
  });
});
