import { EntryDirection, EntryLine, type PostJournalRequest } from '@switch/proto-gen/ledger/v1';
import { describe, expect, it } from 'vitest';
import { validatePostJournal, type ValidationResult } from '../../src/domain/validate';

const D = EntryDirection.ENTRY_DIRECTION_DEBIT;
const C = EntryDirection.ENTRY_DIRECTION_CREDIT;

function line(accountCode: string, direction: EntryDirection, amount: string): EntryLine {
  return { accountCode, direction, amount };
}

/** The debit-leg template from spec section 7, 12,500 paise. */
function debitLeg(overrides: Partial<PostJournalRequest> = {}): PostJournalRequest {
  return {
    idempotencyKey: 'transfer:7f1c:debit-leg',
    referenceId: '7f1c',
    kind: 'TRANSFER_DEBIT_LEG',
    description: 'debit leg',
    currency: 'INR',
    lines: [line('receivable:bank_a', D, '12500'), line('transit', C, '12500')],
    ...overrides,
  };
}

function reason(result: ValidationResult): string {
  if (result.ok) throw new Error('expected validation to fail');
  return result.reason;
}

describe('validatePostJournal — accepts', () => {
  it('a balanced two-line journal, converting amounts to bigint', () => {
    const result = validatePostJournal(debitLeg());
    expect(result).toEqual({
      ok: true,
      journal: {
        idempotencyKey: 'transfer:7f1c:debit-leg',
        referenceId: '7f1c',
        kind: 'TRANSFER_DEBIT_LEG',
        description: 'debit leg',
        currency: 'INR',
        lines: [
          { accountCode: 'receivable:bank_a', direction: 'D', amount: 12500n },
          { accountCode: 'transit', direction: 'C', amount: 12500n },
        ],
      },
    });
  });

  it('ten lines, the maximum', () => {
    const lines = [
      ...Array.from({ length: 5 }, () => line('receivable:bank_a', D, '1')),
      ...Array.from({ length: 5 }, () => line('transit', C, '1')),
    ];
    expect(validatePostJournal(debitLeg({ lines })).ok).toBe(true);
  });

  it('a multi-line journal that balances in total but not pairwise', () => {
    const lines = [line('receivable:bank_a', D, '300'), line('transit', C, '100'), line('transit', C, '200')];
    expect(validatePostJournal(debitLeg({ lines })).ok).toBe(true);
  });

  it('an empty description', () => {
    expect(validatePostJournal(debitLeg({ description: '' })).ok).toBe(true);
  });

  it('a 200-character key, counting characters rather than UTF-16 units', () => {
    expect(validatePostJournal(debitLeg({ idempotencyKey: 'k'.repeat(200) })).ok).toBe(true);
    expect(validatePostJournal(debitLeg({ idempotencyKey: '😀'.repeat(200) })).ok).toBe(true);
  });

  it('amounts at the int64 maximum, summing beyond it without overflow', () => {
    const max = '9223372036854775807';
    const lines = [line('a', D, max), line('b', D, max), line('c', C, max), line('d', C, max)];
    expect(validatePostJournal(debitLeg({ lines })).ok).toBe(true);
  });
});

describe('validatePostJournal — rejects', () => {
  it('an unbalanced journal', () => {
    const lines = [line('receivable:bank_a', D, '12500'), line('transit', C, '12499')];
    expect(reason(validatePostJournal(debitLeg({ lines })))).toBe('journal is unbalanced: debits 12500 credits 12499');
  });

  it('a journal that is all debits', () => {
    const lines = [line('receivable:bank_a', D, '100'), line('transit', D, '100')];
    expect(reason(validatePostJournal(debitLeg({ lines })))).toMatch(/unbalanced/);
  });

  it('fewer than 2 or more than 10 lines', () => {
    expect(reason(validatePostJournal(debitLeg({ lines: [] })))).toMatch(/2 to 10 lines, got 0/);
    expect(reason(validatePostJournal(debitLeg({ lines: [line('transit', D, '1')] })))).toMatch(/got 1/);
    const eleven = Array.from({ length: 11 }, (_, i) => line('transit', i % 2 === 0 ? D : C, '1'));
    expect(reason(validatePostJournal(debitLeg({ lines: eleven })))).toMatch(/got 11/);
  });

  it('a zero, negative or non-integer amount', () => {
    for (const amount of ['0', '-12500']) {
      const lines = [line('receivable:bank_a', D, amount), line('transit', C, amount)];
      expect(reason(validatePostJournal(debitLeg({ lines })))).toMatch(/greater than 0/);
    }
    for (const amount of ['', '1.5', '1e3', 'abc']) {
      const lines = [line('receivable:bank_a', D, amount), line('transit', C, '1')];
      expect(reason(validatePostJournal(debitLeg({ lines })))).toMatch(/not an integer/);
    }
  });

  it('an amount above int64', () => {
    const lines = [line('a', D, '9223372036854775808'), line('b', C, '9223372036854775808')];
    expect(reason(validatePostJournal(debitLeg({ lines })))).toMatch(/exceeds int64/);
  });

  it('an unset or unrecognised direction', () => {
    for (const direction of [EntryDirection.ENTRY_DIRECTION_UNSPECIFIED, EntryDirection.UNRECOGNIZED]) {
      const lines = [line('receivable:bank_a', direction, '1'), line('transit', C, '1')];
      expect(reason(validatePostJournal(debitLeg({ lines })))).toMatch(/line 0: direction/);
    }
  });

  it('a direction value from a newer schema, exactly as it arrives on the wire', () => {
    // Field 2 (direction), varint 7. Binary decode keeps the raw number, not UNRECOGNIZED.
    const decoded = EntryLine.decode(Uint8Array.from([0x10, 0x07]));
    expect(decoded.direction).toBe(7);
    const lines = [{ ...decoded, accountCode: 'receivable:bank_a', amount: '1' }, line('transit', C, '1')];
    expect(reason(validatePostJournal(debitLeg({ lines })))).toMatch(/line 0: direction/);
  });

  it('a currency other than INR', () => {
    for (const currency of ['USD', 'inr', '']) {
      expect(reason(validatePostJournal(debitLeg({ currency })))).toMatch(/currency must be INR/);
    }
  });

  it('an empty or over-long idempotency key', () => {
    expect(reason(validatePostJournal(debitLeg({ idempotencyKey: '' })))).toMatch(/1 to 200 characters, got 0/);
    expect(reason(validatePostJournal(debitLeg({ idempotencyKey: 'k'.repeat(201) })))).toMatch(/got 201/);
  });

  it('an empty reference_id, kind or account_code', () => {
    expect(reason(validatePostJournal(debitLeg({ referenceId: '' })))).toMatch(/reference_id/);
    expect(reason(validatePostJournal(debitLeg({ kind: '' })))).toMatch(/kind/);
    const lines = [line('', D, '1'), line('transit', C, '1')];
    expect(reason(validatePostJournal(debitLeg({ lines })))).toMatch(/line 0: account_code/);
  });
});
