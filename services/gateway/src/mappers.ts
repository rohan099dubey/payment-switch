import { status as Status } from '@grpc/grpc-js';
import { errorCodeOf, isGrpcError } from '@switch/common';
import { TransferState, type Transfer } from '@switch/proto-gen/orchestrator/v1';
import { ApiError } from './plugins/errorHandler';

/** The public summary of `state` (section 5). */
export type PublicStatus = 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'REVERSED' | 'UNDER_REVIEW';

export type StateName =
  | 'INITIATED'
  | 'DEBIT_SENT'
  | 'DEBITED'
  | 'CREDIT_SENT'
  | 'CREDITED'
  | 'SUCCESS'
  | 'FAILED'
  | 'REVERSING'
  | 'REVERSED'
  | 'NEEDS_MANUAL_REVIEW';

const STATE_NAMES: ReadonlyMap<TransferState, StateName> = new Map([
  [TransferState.TRANSFER_STATE_INITIATED, 'INITIATED'],
  [TransferState.TRANSFER_STATE_DEBIT_SENT, 'DEBIT_SENT'],
  [TransferState.TRANSFER_STATE_DEBITED, 'DEBITED'],
  [TransferState.TRANSFER_STATE_CREDIT_SENT, 'CREDIT_SENT'],
  [TransferState.TRANSFER_STATE_CREDITED, 'CREDITED'],
  [TransferState.TRANSFER_STATE_SUCCESS, 'SUCCESS'],
  [TransferState.TRANSFER_STATE_FAILED, 'FAILED'],
  [TransferState.TRANSFER_STATE_REVERSING, 'REVERSING'],
  [TransferState.TRANSFER_STATE_REVERSED, 'REVERSED'],
  [TransferState.TRANSFER_STATE_NEEDS_MANUAL_REVIEW, 'NEEDS_MANUAL_REVIEW'],
]);

/** @throws Error for `UNSPECIFIED` or an unknown value: the Orchestrator broke its contract. */
export function stateName(state: TransferState): StateName {
  const name = STATE_NAMES.get(state);
  if (name === undefined) throw new Error(`unknown transfer state ${String(state)}`);
  return name;
}

export function publicStatus(state: StateName): PublicStatus {
  switch (state) {
    case 'SUCCESS':
      return 'SUCCEEDED';
    case 'FAILED':
      return 'FAILED';
    case 'REVERSED':
      return 'REVERSED';
    case 'NEEDS_MANUAL_REVIEW':
      return 'UNDER_REVIEW';
    default:
      return 'PENDING';
  }
}

/**
 * The status code table from section 5:
 *
 * | state                                | first | replay |
 * | SUCCESS                              | 201   | 200    |
 * | FAILED, REVERSED                     | 422   | 422    |
 * | non-terminal, NEEDS_MANUAL_REVIEW    | 202   | 202    |
 */
export function createStatusCode(state: StateName, replayed: boolean): 200 | 201 | 202 | 422 {
  switch (state) {
    case 'SUCCESS':
      return replayed ? 200 : 201;
    case 'FAILED':
    case 'REVERSED':
      return 422;
    default:
      return 202;
  }
}

export interface PartyResource {
  bank_id: string;
  account_id: string;
}

export interface TransferResource {
  id: string;
  status: PublicStatus;
  state: StateName;
  payer: PartyResource;
  payee: PartyResource;
  amount: number;
  currency: string;
  note: string | null;
  failure_code: string | null;
  failure_message: string | null;
  created_at: string | null;
  updated_at: string | null;
}

/** gRPC `Transfer` to the public JSON resource. Amounts fit a JSON number (<= MAX_TRANSFER_AMOUNT). */
export function toTransferResource(t: Transfer): TransferResource {
  const amount = Number(t.amount);
  if (!Number.isSafeInteger(amount))
    throw new Error(`transfer ${t.transferId} amount ${t.amount} is not a safe integer`);
  const state = stateName(t.state);
  return {
    id: t.transferId,
    status: publicStatus(state),
    state,
    payer: { bank_id: t.payer?.bankId ?? '', account_id: t.payer?.accountId ?? '' },
    payee: { bank_id: t.payee?.bankId ?? '', account_id: t.payee?.accountId ?? '' },
    amount,
    currency: t.currency,
    note: t.note === '' ? null : t.note,
    failure_code: t.failureCode === '' ? null : t.failureCode,
    failure_message: t.failureMessage === '' ? null : t.failureMessage,
    created_at: t.createdAt?.toISOString() ?? null,
    updated_at: t.updatedAt?.toISOString() ?? null,
  };
}

const UPPER_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

/**
 * gRPC error from the Orchestrator to an HTTP error (section 5 table). `operation` matters
 * because `NOT_FOUND` is only meaningful from `GetTransfer`. Client-error messages are the
 * Orchestrator's (they describe the request); server errors get a generic message.
 */
export function mapGrpcError(err: unknown, operation: 'create' | 'get'): ApiError {
  if (!isGrpcError(err)) return new ApiError(500, 'INTERNAL', 'internal error');
  const trailer = errorCodeOf(err);
  const details = (err as { details?: unknown }).details;
  const message = typeof details === 'string' && details !== '' ? details : 'request rejected';

  switch (err.code) {
    case Status.INVALID_ARGUMENT:
      return new ApiError(
        400,
        trailer !== undefined && UPPER_CODE.test(trailer) ? trailer : 'VALIDATION_ERROR',
        message,
      );
    case Status.ALREADY_EXISTS:
      if (trailer === 'IDEMPOTENCY_KEY_REUSED') return new ApiError(409, 'IDEMPOTENCY_KEY_REUSED', message);
      break;
    case Status.NOT_FOUND:
      if (operation === 'get') return new ApiError(404, 'TRANSFER_NOT_FOUND', 'transfer not found');
      break;
    case Status.UNAVAILABLE:
      return new ApiError(
        503,
        'UPSTREAM_UNAVAILABLE',
        'the transfer service is unavailable; retry with the same Idempotency-Key',
      );
    case Status.DEADLINE_EXCEEDED:
      return new ApiError(
        504,
        'UPSTREAM_TIMEOUT',
        'the transfer service timed out; retry with the same Idempotency-Key',
      );
    default:
      break;
  }
  return new ApiError(500, 'INTERNAL', 'internal error');
}
