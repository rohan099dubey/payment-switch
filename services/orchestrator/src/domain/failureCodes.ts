/** `transfers.failure_code` values (spec section 14, "Failure codes"). */
export const FailureCode = {
  INSUFFICIENT_FUNDS: 'INSUFFICIENT_FUNDS',
  PAYER_ACCOUNT_NOT_FOUND: 'PAYER_ACCOUNT_NOT_FOUND',
  PAYER_ACCOUNT_BLOCKED: 'PAYER_ACCOUNT_BLOCKED',
  DEBIT_NOT_CONFIRMED: 'DEBIT_NOT_CONFIRMED',
  PAYEE_ACCOUNT_NOT_FOUND: 'PAYEE_ACCOUNT_NOT_FOUND',
  PAYEE_ACCOUNT_BLOCKED: 'PAYEE_ACCOUNT_BLOCKED',
  CREDIT_NOT_CONFIRMED: 'CREDIT_NOT_CONFIRMED',
  CURRENCY_MISMATCH: 'CURRENCY_MISMATCH',
  RECOVERY_EXHAUSTED: 'RECOVERY_EXHAUSTED',
  LEDGER_REJECTED: 'LEDGER_REJECTED',
  BANK_INVARIANT_VIOLATION: 'BANK_INVARIANT_VIOLATION',
} as const;

export type FailureCode = (typeof FailureCode)[keyof typeof FailureCode];

/** `x-error-code` values the Orchestrator itself sends on `CreateTransfer` / `GetTransfer`. */
export const OrchestratorErrorCode = {
  INVALID_REQUEST: 'INVALID_REQUEST',
  SAME_ACCOUNT: 'SAME_ACCOUNT',
  UNKNOWN_BANK: 'UNKNOWN_BANK',
  INVALID_AMOUNT: 'INVALID_AMOUNT',
  UNSUPPORTED_CURRENCY: 'UNSUPPORTED_CURRENCY',
  IDEMPOTENCY_KEY_REUSED: 'IDEMPOTENCY_KEY_REUSED',
  TRANSFER_NOT_FOUND: 'TRANSFER_NOT_FOUND',
} as const;

/**
 * Bank `x-error-code` (on a `DEFINITE_FAILURE`) to failure code, per step. A code that is
 * not in the table for that step returns `null`, and the saga treats it as a bug: a
 * definite failure the switch does not understand must not silently pick a failure
 * branch (ADR-018). Examples: `INSUFFICIENT_FUNDS` on a Credit, or a missing trailer.
 *
 * `REFERENCE_VOIDED` is treated exactly like `Resolve` returning `VOIDED` (section 14).
 */
const DEBIT_FAILURES: ReadonlyMap<string, FailureCode> = new Map([
  ['INSUFFICIENT_FUNDS', FailureCode.INSUFFICIENT_FUNDS],
  ['ACCOUNT_NOT_FOUND', FailureCode.PAYER_ACCOUNT_NOT_FOUND],
  ['ACCOUNT_BLOCKED', FailureCode.PAYER_ACCOUNT_BLOCKED],
  ['REFERENCE_VOIDED', FailureCode.DEBIT_NOT_CONFIRMED],
  ['CURRENCY_MISMATCH', FailureCode.CURRENCY_MISMATCH],
]);

const CREDIT_FAILURES: ReadonlyMap<string, FailureCode> = new Map([
  ['ACCOUNT_NOT_FOUND', FailureCode.PAYEE_ACCOUNT_NOT_FOUND],
  ['ACCOUNT_BLOCKED', FailureCode.PAYEE_ACCOUNT_BLOCKED],
  ['REFERENCE_VOIDED', FailureCode.CREDIT_NOT_CONFIRMED],
  ['CURRENCY_MISMATCH', FailureCode.CURRENCY_MISMATCH],
]);

export function debitFailureCode(bankErrorCode: string | undefined): FailureCode | null {
  return bankErrorCode === undefined ? null : (DEBIT_FAILURES.get(bankErrorCode) ?? null);
}

export function creditFailureCode(bankErrorCode: string | undefined): FailureCode | null {
  return bankErrorCode === undefined ? null : (CREDIT_FAILURES.get(bankErrorCode) ?? null);
}
