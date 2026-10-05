import { canonicalJson, sha256Hex } from '@switch/common';
import type { CreateTransferRequest } from '@switch/proto-gen/orchestrator/v1';
import { OrchestratorErrorCode } from './failureCodes';
import type { NewTransfer, Party } from './transfer';

export const SUPPORTED_CURRENCY = 'INR';

const INTEGER = /^-?\d+$/;

export type ValidationResult =
  | { ok: true; transfer: NewTransfer }
  | { ok: false; errorCode: (typeof OrchestratorErrorCode)[keyof typeof OrchestratorErrorCode]; reason: string };

export interface ValidationLimits {
  knownBank: (bankId: string) => boolean;
  maxAmount: bigint;
}

/**
 * `CreateTransfer` step 1 (spec section 6), checked in the spec's order. Returns
 * `{ok, ...}` and never throws, so it has no transport dependency.
 *
 * Empty ids are `INVALID_REQUEST` (ADR-018): the spec requires them non-empty but names
 * no code for it.
 */
export function validateCreateTransfer(request: CreateTransferRequest, limits: ValidationLimits): ValidationResult {
  if (request.clientId === '' || request.idempotencyKey === '') {
    return invalid('INVALID_REQUEST', 'client_id and idempotency_key are required');
  }
  const payer = request.payer;
  const payee = request.payee;
  if (payer === undefined || payee === undefined || !complete(payer) || !complete(payee)) {
    return invalid('INVALID_REQUEST', 'payer and payee need a bank_id and an account_id');
  }
  if (payer.bankId === payee.bankId && payer.accountId === payee.accountId) {
    return invalid('SAME_ACCOUNT', 'payer and payee are the same account');
  }
  for (const bankId of [payer.bankId, payee.bankId]) {
    if (!limits.knownBank(bankId)) return invalid('UNKNOWN_BANK', `unknown bank ${bankId}`);
  }
  const amount = INTEGER.test(request.amount) ? BigInt(request.amount) : null;
  if (amount === null || amount < 1n || amount > limits.maxAmount) {
    return invalid('INVALID_AMOUNT', `amount must be an integer number of paise in 1..${limits.maxAmount}`);
  }
  if (request.currency !== SUPPORTED_CURRENCY) {
    return invalid('UNSUPPORTED_CURRENCY', `currency must be ${SUPPORTED_CURRENCY}`);
  }

  const note = request.note;
  return {
    ok: true,
    transfer: {
      clientId: request.clientId,
      idempotencyKey: request.idempotencyKey,
      requestHash: transferRequestHash({ payer, payee, amount, currency: request.currency, note }),
      payer: { bankId: payer.bankId, accountId: payer.accountId },
      payee: { bankId: payee.bankId, accountId: payee.accountId },
      amount,
      currency: request.currency,
      // proto3 cannot tell an absent note from an empty one; store absence as NULL.
      note: note === '' ? null : note,
    },
  };
}

/**
 * Step 2: `sha256Hex(canonicalJson({payer, payee, amount, currency, note: note ?? ""}))`.
 * Parties use the proto field names; the amount is a bigint, written as a bare number.
 */
export function transferRequestHash(body: {
  payer: Party;
  payee: Party;
  amount: bigint;
  currency: string;
  note: string | null | undefined;
}): string {
  return sha256Hex(
    canonicalJson({
      payer: { bank_id: body.payer.bankId, account_id: body.payer.accountId },
      payee: { bank_id: body.payee.bankId, account_id: body.payee.accountId },
      amount: body.amount,
      currency: body.currency,
      note: body.note ?? '',
    }),
  );
}

function complete(party: Party): boolean {
  return party.bankId !== '' && party.accountId !== '';
}

function invalid(errorCode: keyof typeof OrchestratorErrorCode, reason: string): ValidationResult {
  return { ok: false, errorCode: OrchestratorErrorCode[errorCode], reason };
}
