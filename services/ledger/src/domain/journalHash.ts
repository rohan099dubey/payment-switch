import { canonicalJson, sha256Hex } from '@switch/common';
import type { JournalLine, ValidJournal } from './validate';

/**
 * `request_hash` for idempotency (spec section 7, step 2):
 * `sha256Hex(canonicalJson({reference_id, kind, currency, lines}))`, lines sorted by
 * `(account_code, direction, amount)`.
 *
 * Line order therefore does not matter, and neither does `description`. `amount` is a
 * bigint, which `canonicalJson` writes as a bare JSON number and compares numerically.
 */
export function journalRequestHash(journal: Pick<ValidJournal, 'referenceId' | 'kind' | 'currency' | 'lines'>): string {
  const lines = [...journal.lines].sort(compareLines).map((line) => ({
    account_code: line.accountCode,
    direction: line.direction,
    amount: line.amount,
  }));
  return sha256Hex(
    canonicalJson({
      reference_id: journal.referenceId,
      kind: journal.kind,
      currency: journal.currency,
      lines,
    }),
  );
}

export function compareLines(a: JournalLine, b: JournalLine): number {
  if (a.accountCode !== b.accountCode) return a.accountCode < b.accountCode ? -1 : 1;
  if (a.direction !== b.direction) return a.direction < b.direction ? -1 : 1;
  if (a.amount !== b.amount) return a.amount < b.amount ? -1 : 1;
  return 0;
}
