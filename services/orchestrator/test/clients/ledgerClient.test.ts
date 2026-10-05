import { EntryDirection } from '@switch/proto-gen/ledger/v1';
import { describe, expect, it } from 'vitest';
import { buildJournal, journalIdempotencyKey } from '../../src/clients/ledgerClient';

const transfer = {
  id: '0f0e0d0c-0b0a-4908-8706-050403020100',
  payer: { bankId: 'bank_a', accountId: 'A1' },
  payee: { bankId: 'bank_b', accountId: 'B1' },
  amount: 12_500n,
};

const D = EntryDirection.ENTRY_DIRECTION_DEBIT;
const C = EntryDirection.ENTRY_DIRECTION_CREDIT;

describe('journal templates (section 7)', () => {
  it('debit-leg: Dr receivable:{payer_bank}, Cr transit', () => {
    expect(buildJournal(transfer, 'debit-leg')).toEqual({
      idempotencyKey: `transfer:${transfer.id}:debit-leg`,
      referenceId: transfer.id,
      kind: 'TRANSFER_DEBIT_LEG',
      description: '',
      currency: 'INR',
      lines: [
        { accountCode: 'receivable:bank_a', direction: D, amount: '12500' },
        { accountCode: 'transit', direction: C, amount: '12500' },
      ],
    });
  });

  it('credit-leg: Dr transit, Cr payable:{payee_bank}', () => {
    expect(buildJournal(transfer, 'credit-leg')).toEqual({
      idempotencyKey: `transfer:${transfer.id}:credit-leg`,
      referenceId: transfer.id,
      kind: 'TRANSFER_CREDIT_LEG',
      description: '',
      currency: 'INR',
      lines: [
        { accountCode: 'transit', direction: D, amount: '12500' },
        { accountCode: 'payable:bank_b', direction: C, amount: '12500' },
      ],
    });
  });

  it('reversal: Dr transit, Cr receivable:{payer_bank} (undoes the debit leg exactly)', () => {
    expect(buildJournal(transfer, 'reversal')).toEqual({
      idempotencyKey: `transfer:${transfer.id}:reversal`,
      referenceId: transfer.id,
      kind: 'TRANSFER_REVERSAL',
      description: '',
      currency: 'INR',
      lines: [
        { accountCode: 'transit', direction: D, amount: '12500' },
        { accountCode: 'receivable:bank_a', direction: C, amount: '12500' },
      ],
    });
  });

  it('uses the bank ids of the transfer, not fixed ones', () => {
    const reversed = {
      ...transfer,
      payer: { bankId: 'bank_b', accountId: 'B9' },
      payee: { bankId: 'bank_a', accountId: 'A9' },
    };
    expect(buildJournal(reversed, 'debit-leg').lines[0]?.accountCode).toBe('receivable:bank_b');
    expect(buildJournal(reversed, 'credit-leg').lines[1]?.accountCode).toBe('payable:bank_a');
  });

  it('keeps amounts exact past 2^53', () => {
    const big = { ...transfer, amount: 9_007_199_254_740_993n };
    expect(buildJournal(big, 'debit-leg').lines.map((l) => l.amount)).toEqual(['9007199254740993', '9007199254740993']);
  });

  it('derives keys from the transfer id only, so a retry after a crash regenerates the same key', () => {
    expect(journalIdempotencyKey(transfer.id, 'credit-leg')).toBe(journalIdempotencyKey(transfer.id, 'credit-leg'));
    expect(buildJournal(transfer, 'debit-leg')).toEqual(buildJournal({ ...transfer }, 'debit-leg'));
  });

  it('every template balances: one debit and one credit of the transfer amount', () => {
    for (const leg of ['debit-leg', 'credit-leg', 'reversal'] as const) {
      const lines = buildJournal(transfer, leg).lines;
      expect(lines.map((l) => l.direction).sort()).toEqual([D, C].sort());
      expect(new Set(lines.map((l) => l.amount))).toEqual(new Set(['12500']));
    }
  });
});
