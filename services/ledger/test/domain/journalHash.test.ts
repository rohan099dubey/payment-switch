import { canonicalJson, sha256Hex } from '@switch/common';
import { describe, expect, it } from 'vitest';
import { compareLines, journalRequestHash } from '../../src/domain/journalHash';
import type { JournalLine } from '../../src/domain/validate';

const base = {
  referenceId: '7f1c',
  kind: 'TRANSFER_DEBIT_LEG',
  currency: 'INR',
  lines: [
    { accountCode: 'transit', direction: 'C', amount: 12500n },
    { accountCode: 'receivable:bank_a', direction: 'D', amount: 12500n },
  ] satisfies JournalLine[],
};

describe('journalRequestHash', () => {
  it('is sha256 of the canonical JSON in spec section 7, with lines sorted', () => {
    const expected = sha256Hex(
      canonicalJson({
        reference_id: '7f1c',
        kind: 'TRANSFER_DEBIT_LEG',
        currency: 'INR',
        lines: [
          { account_code: 'receivable:bank_a', direction: 'D', amount: 12500n },
          { account_code: 'transit', direction: 'C', amount: 12500n },
        ],
      }),
    );
    expect(journalRequestHash(base)).toBe(expected);
    expect(journalRequestHash(base)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('ignores line order', () => {
    expect(journalRequestHash({ ...base, lines: [...base.lines].reverse() })).toBe(journalRequestHash(base));
  });

  it('does not mutate the caller’s lines', () => {
    const lines = [...base.lines];
    journalRequestHash({ ...base, lines });
    expect(lines).toEqual(base.lines);
  });

  it('changes when any hashed field changes', () => {
    const h = journalRequestHash(base);
    expect(journalRequestHash({ ...base, referenceId: '7f1d' })).not.toBe(h);
    expect(journalRequestHash({ ...base, kind: 'TRANSFER_REVERSAL' })).not.toBe(h);
    expect(journalRequestHash({ ...base, currency: 'USD' })).not.toBe(h);
    expect(
      journalRequestHash({
        ...base,
        lines: [
          { accountCode: 'transit', direction: 'C', amount: 12501n },
          { accountCode: 'receivable:bank_a', direction: 'D', amount: 12501n },
        ],
      }),
    ).not.toBe(h);
    expect(
      journalRequestHash({
        ...base,
        lines: [
          { accountCode: 'transit', direction: 'C', amount: 12500n },
          { accountCode: 'receivable:bank_b', direction: 'D', amount: 12500n },
        ],
      }),
    ).not.toBe(h);
  });
});

describe('compareLines', () => {
  it('orders by account_code, then direction, then amount numerically', () => {
    const lines: JournalLine[] = [
      { accountCode: 'transit', direction: 'D', amount: 9n },
      { accountCode: 'transit', direction: 'C', amount: 100n },
      { accountCode: 'transit', direction: 'C', amount: 20n },
      { accountCode: 'payable:bank_b', direction: 'C', amount: 5n },
    ];
    expect([...lines].sort(compareLines)).toEqual([
      { accountCode: 'payable:bank_b', direction: 'C', amount: 5n },
      { accountCode: 'transit', direction: 'C', amount: 20n },
      { accountCode: 'transit', direction: 'C', amount: 100n },
      { accountCode: 'transit', direction: 'D', amount: 9n },
    ]);
  });
});
