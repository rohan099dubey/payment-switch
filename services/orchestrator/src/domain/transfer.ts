import type { TransferState } from './states';

export interface Party {
  bankId: string;
  accountId: string;
}

/** One `transfers` row. Money is bigint paise; `pg` hands `amount` over as a string. */
export interface Transfer {
  id: string;
  clientId: string;
  idempotencyKey: string;
  requestHash: string;
  payer: Party;
  payee: Party;
  amount: bigint;
  currency: string;
  note: string | null;
  state: TransferState;
  failureCode: string | null;
  failureMessage: string | null;
  version: number;
  attempts: number;
  nextAttemptAt: Date;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** A validated `CreateTransfer` request, ready to insert as `INITIATED`. */
export interface NewTransfer {
  clientId: string;
  idempotencyKey: string;
  requestHash: string;
  payer: Party;
  payee: Party;
  amount: bigint;
  currency: string;
  note: string | null;
}
