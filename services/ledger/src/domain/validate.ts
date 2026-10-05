import { EntryDirection, type PostJournalRequest } from '@switch/proto-gen/ledger/v1';

export type Direction = 'D' | 'C';

export interface JournalLine {
  accountCode: string;
  direction: Direction;
  amount: bigint;
}

/** A `PostJournal` request that has passed every rule in spec section 7, step 1. */
export interface ValidJournal {
  idempotencyKey: string;
  referenceId: string;
  kind: string;
  description: string;
  currency: string;
  lines: JournalLine[];
}

export type ValidationResult = { ok: true; journal: ValidJournal } | { ok: false; reason: string };

export const LEDGER_CURRENCY = 'INR';
export const MIN_LINES = 2;
export const MAX_LINES = 10;
export const MAX_IDEMPOTENCY_KEY_LENGTH = 200;

const INT64_MAX = 9_223_372_036_854_775_807n;
const INTEGER = /^-?\d+$/;

/**
 * Validates a `PostJournal` request: 2 to 10 lines, every amount > 0, direction set,
 * debits equal credits, currency INR, idempotency key 1 to 200 characters, reference
 * id and kind non-empty. Pure: no I/O, so it is unit-tested without a database.
 */
export function validatePostJournal(request: PostJournalRequest): ValidationResult {
  // "Characters" means Unicode code points, not UTF-16 code units.
  const keyLength = Array.from(request.idempotencyKey).length;
  if (keyLength < 1 || keyLength > MAX_IDEMPOTENCY_KEY_LENGTH) {
    return fail(`idempotency_key must be 1 to ${MAX_IDEMPOTENCY_KEY_LENGTH} characters, got ${keyLength}`);
  }
  if (request.referenceId === '') return fail('reference_id is required');
  if (request.kind === '') return fail('kind is required');
  if (request.currency !== LEDGER_CURRENCY) {
    return fail(`currency must be ${LEDGER_CURRENCY}, got '${request.currency}'`);
  }
  if (request.lines.length < MIN_LINES || request.lines.length > MAX_LINES) {
    return fail(`a journal needs ${MIN_LINES} to ${MAX_LINES} lines, got ${request.lines.length}`);
  }

  const lines: JournalLine[] = [];
  let debits = 0n;
  let credits = 0n;
  for (const [index, line] of request.lines.entries()) {
    if (line.accountCode === '') return fail(`line ${index}: account_code is required`);

    let direction: Direction;
    if (line.direction === EntryDirection.ENTRY_DIRECTION_DEBIT) direction = 'D';
    else if (line.direction === EntryDirection.ENTRY_DIRECTION_CREDIT) direction = 'C';
    else return fail(`line ${index}: direction must be DEBIT or CREDIT`);

    if (!INTEGER.test(line.amount)) return fail(`line ${index}: amount is not an integer`);
    const amount = BigInt(line.amount);
    if (amount <= 0n) return fail(`line ${index}: amount must be greater than 0`);
    if (amount > INT64_MAX) return fail(`line ${index}: amount exceeds int64`);

    if (direction === 'D') debits += amount;
    else credits += amount;
    lines.push({ accountCode: line.accountCode, direction, amount });
  }

  if (debits !== credits) {
    return fail(`journal is unbalanced: debits ${debits} credits ${credits}`);
  }

  return {
    ok: true,
    journal: {
      idempotencyKey: request.idempotencyKey,
      referenceId: request.referenceId,
      kind: request.kind,
      description: request.description,
      currency: request.currency,
      lines,
    },
  };
}

function fail(reason: string): ValidationResult {
  return { ok: false, reason };
}
