/**
 * One leg of a transfer as each side of the books sees it (ADR-027). A bank operation and
 * a ledger journal describe the same leg when bank, reference id and operation agree:
 *   TRANSFER_DEBIT_LEG  (D receivable:bank_X) <-> bank_X DEBIT
 *   TRANSFER_CREDIT_LEG (C payable:bank_Y)    <-> bank_Y CREDIT
 *   TRANSFER_REVERSAL   (C receivable:bank_X) <-> bank_X REVERSE_DEBIT
 */
export type LegOperation = 'DEBIT' | 'CREDIT' | 'REVERSE_DEBIT';
export type BreakType = 'MISSING_IN_LEDGER' | 'MISSING_AT_BANK' | 'AMOUNT_MISMATCH';

export interface Leg {
  bankId: string;
  referenceId: string;
  operation: LegOperation;
  amount: bigint;
}

export const legKey = (leg: { bankId: string; referenceId: string; operation: LegOperation }): string =>
  `${leg.bankId}|${leg.referenceId}|${leg.operation}`;

/** A ledger journal line, as `ListJournals` / `ListJournalsByTime` return it. */
export interface JournalLine {
  accountCode: string;
  direction: 'DEBIT' | 'CREDIT';
  amount: bigint;
}

export interface JournalView {
  referenceId: string;
  kind: string;
  lines: JournalLine[];
}

const KIND_TO_LEG: Record<string, { operation: LegOperation; prefix: string; direction: 'DEBIT' | 'CREDIT' }> = {
  TRANSFER_DEBIT_LEG: { operation: 'DEBIT', prefix: 'receivable:', direction: 'DEBIT' },
  TRANSFER_CREDIT_LEG: { operation: 'CREDIT', prefix: 'payable:', direction: 'CREDIT' },
  TRANSFER_REVERSAL: { operation: 'REVERSE_DEBIT', prefix: 'receivable:', direction: 'CREDIT' },
};

/**
 * The leg a journal records, or null for a journal that does not describe a bank leg (any
 * other kind). The bank is the suffix of the journal's `receivable:` or `payable:` line.
 */
export function legOfJournal(journal: JournalView): Leg | null {
  const shape = KIND_TO_LEG[journal.kind];
  if (shape === undefined) return null;
  const line = journal.lines.find((l) => l.accountCode.startsWith(shape.prefix) && l.direction === shape.direction);
  if (line === undefined) return null;
  return {
    bankId: line.accountCode.slice(shape.prefix.length),
    referenceId: journal.referenceId,
    operation: shape.operation,
    amount: line.amount,
  };
}

/**
 * What the two sides say about one leg. `null`: they agree. Undefined sides never reach
 * here: each candidate's missing side is looked up by reference first, at any time.
 */
export function classify(bank: Leg | null, ledger: Leg | null): BreakType | null {
  if (bank === null && ledger === null) return null;
  if (ledger === null) return 'MISSING_IN_LEDGER';
  if (bank === null) return 'MISSING_AT_BANK';
  return bank.amount === ledger.amount ? null : 'AMOUNT_MISMATCH';
}
