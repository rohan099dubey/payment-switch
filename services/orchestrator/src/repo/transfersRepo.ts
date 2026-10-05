import { withTransaction } from '@switch/common';
import type { Pool, PoolClient } from 'pg';
import { NON_TERMINAL_STATES, TransferState, isTransferState } from '../domain/states';
import type { NewTransfer, Transfer } from '../domain/transfer';
import type { SagaStore } from '../domain/saga';
import type { CasRequest } from '../domain/transitions';
import { appendEvent } from './eventsRepo';

/** A pool or a client already inside a transaction. */
export type Queryable = Pool | PoolClient;

interface TransferRow {
  id: string;
  client_id: string;
  idempotency_key: string;
  request_hash: string;
  payer_bank_id: string;
  payer_account_id: string;
  payee_bank_id: string;
  payee_account_id: string;
  amount: string;
  currency: string;
  note: string | null;
  state: string;
  failure_code: string | null;
  failure_message: string | null;
  version: number;
  attempts: number;
  next_attempt_at: Date;
  lease_owner: string | null;
  lease_expires_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export type InsertOutcome = { status: 'created'; transfer: Transfer } | { status: 'duplicate'; existing: Transfer };

/** SQL for `now()` plus a millisecond count parameter, the section 13 interval idiom. */
const nowPlusMs = (param: string): string => `now() + (${param}::text || ' milliseconds')::interval`;

/**
 * Spec section 6, `CreateTransfer` steps 3 and 4. One transaction: `INSERT ... ON CONFLICT
 * (client_id, idempotency_key) DO NOTHING RETURNING *` as `INITIATED` with the lease
 * already owned by `leaseOwner`, plus the `NULL -> INITIATED` event. A conflict reads the
 * existing row instead; a concurrent duplicate blocks on the unique index until the
 * first insert commits, so it always sees the committed row.
 */
export async function insertTransfer(
  pool: Pool,
  input: NewTransfer,
  leaseOwner: string,
  leaseMs: number,
  detail: Record<string, unknown> = {},
): Promise<InsertOutcome> {
  return withTransaction(pool, async (client) => {
    const inserted = await client.query<TransferRow>(
      `INSERT INTO transfers (client_id, idempotency_key, request_hash, payer_bank_id, payer_account_id,
                              payee_bank_id, payee_account_id, amount, currency, note, state,
                              lease_owner, lease_expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'INITIATED', $11, ${nowPlusMs('$12')})
       ON CONFLICT (client_id, idempotency_key) DO NOTHING
       RETURNING *`,
      [
        input.clientId,
        input.idempotencyKey,
        input.requestHash,
        input.payer.bankId,
        input.payer.accountId,
        input.payee.bankId,
        input.payee.accountId,
        input.amount.toString(),
        input.currency,
        input.note,
        leaseOwner,
        leaseMs,
      ],
    );
    const row = inserted.rows[0];
    if (row !== undefined) {
      const transfer = toTransfer(row);
      await appendEvent(client, {
        transferId: transfer.id,
        fromState: null,
        toState: TransferState.INITIATED,
        reason: 'TRANSFER_CREATED',
        detail,
      });
      return { status: 'created', transfer };
    }

    const existing = await findByIdempotencyKey(client, input.clientId, input.idempotencyKey);
    // Transfers are never deleted, so a conflicting row cannot disappear.
    if (existing === null) throw new Error('transfer conflicted on its idempotency key but cannot be read');
    return { status: 'duplicate', existing };
  });
}

export async function findByIdempotencyKey(
  db: Queryable,
  clientId: string,
  idempotencyKey: string,
): Promise<Transfer | null> {
  const result = await db.query<TransferRow>('SELECT * FROM transfers WHERE client_id = $1 AND idempotency_key = $2', [
    clientId,
    idempotencyKey,
  ]);
  const row = result.rows[0];
  return row === undefined ? null : toTransfer(row);
}

export async function getTransfer(db: Queryable, id: string): Promise<Transfer | null> {
  const result = await db.query<TransferRow>('SELECT * FROM transfers WHERE id = $1', [id]);
  const row = result.rows[0];
  return row === undefined ? null : toTransfer(row);
}

/** `GetTransfer`: a client can only see its own transfers; anyone else's is simply absent. */
export async function getTransferForClient(db: Queryable, id: string, clientId: string): Promise<Transfer | null> {
  const result = await db.query<TransferRow>('SELECT * FROM transfers WHERE id = $1 AND client_id = $2', [
    id,
    clientId,
  ]);
  const row = result.rows[0];
  return row === undefined ? null : toTransfer(row);
}

/**
 * The compare-and-set from spec section 13, in one transaction with its event. Stricter
 * than the section 13 statement in one way (ADR-018): it also matches `state`, as the
 * section 6 module table says, so a caller holding a stale in-memory state can never
 * write. A terminal state clears the lease. Zero rows: returns null and writes nothing.
 */
export async function casTransition(pool: Pool, req: CasRequest): Promise<Transfer | null> {
  return withTransaction(pool, async (client) => {
    const updated = await client.query<TransferRow>(
      `UPDATE transfers
          SET state = $3, version = version + 1, attempts = 0,
              failure_code = COALESCE($4, failure_code), failure_message = COALESCE($5, failure_message),
              lease_owner = CASE WHEN $8::boolean THEN NULL ELSE lease_owner END,
              lease_expires_at = CASE WHEN $8::boolean THEN NULL ELSE ${nowPlusMs('$6')} END,
              updated_at = now()
        WHERE id = $1 AND version = $2 AND lease_owner = $7 AND state = $9
       RETURNING *`,
      [
        req.transferId,
        req.fromVersion,
        req.toState,
        req.failureCode,
        req.failureMessage,
        req.leaseMs,
        req.leaseOwner,
        req.terminal,
        req.fromState,
      ],
    );
    const row = updated.rows[0];
    if (row === undefined) return null;
    await appendEvent(client, {
      transferId: req.transferId,
      fromState: req.fromState,
      toState: req.toState,
      reason: req.reason,
      detail: req.detail,
    });
    return toTransfer(row);
  });
}

/**
 * `yield` (section 6): schedule recovery and release the lease. Not a state change, so no
 * event and no version bump; guarded by version and lease owner so a stale driver
 * cannot reschedule a transfer it no longer owns.
 */
export async function yieldTransfer(
  db: Queryable,
  req: { transferId: string; version: number; leaseOwner: string; backoffMs: number },
): Promise<Transfer | null> {
  const result = await db.query<TransferRow>(
    `UPDATE transfers
        SET attempts = attempts + 1,
            next_attempt_at = ${nowPlusMs('$4')},
            lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
      WHERE id = $1 AND version = $2 AND lease_owner = $3
     RETURNING *`,
    [req.transferId, req.version, req.leaseOwner, req.backoffMs],
  );
  const row = result.rows[0];
  return row === undefined ? null : toTransfer(row);
}

/** Takes the lease on one non-terminal transfer if it is free or expired. */
export async function acquireLease(
  db: Queryable,
  id: string,
  leaseOwner: string,
  leaseMs: number,
): Promise<Transfer | null> {
  const result = await db.query<TransferRow>(
    `UPDATE transfers
        SET lease_owner = $2, lease_expires_at = ${nowPlusMs('$3')}
      WHERE id = $1 AND state = ANY($4::text[])
        AND (lease_expires_at IS NULL OR lease_expires_at < now())
     RETURNING *`,
    [id, leaseOwner, leaseMs, NON_TERMINAL_STATES],
  );
  const row = result.rows[0];
  return row === undefined ? null : toTransfer(row);
}

/** Gives the lease back early (e.g. a drive aborted by an unexpected error). True if it was held. */
export async function releaseLease(db: Queryable, id: string, leaseOwner: string): Promise<boolean> {
  const result = await db.query(
    'UPDATE transfers SET lease_owner = NULL, lease_expires_at = NULL WHERE id = $1 AND lease_owner = $2',
    [id, leaseOwner],
  );
  return result.rowCount === 1;
}

/** The recovery claim query, verbatim from spec section 13. Used by the M6 worker. */
export async function claimDue(db: Queryable, leaseOwner: string, leaseMs: number, limit: number): Promise<Transfer[]> {
  const result = await db.query<TransferRow>(
    `UPDATE transfers
        SET lease_owner = $1,
            lease_expires_at = now() + ($2 || ' milliseconds')::interval
      WHERE id IN (
        SELECT id FROM transfers
         WHERE state IN ('INITIATED','DEBIT_SENT','DEBITED','CREDIT_SENT','CREDITED','REVERSING')
           AND next_attempt_at <= now()
           AND (lease_expires_at IS NULL OR lease_expires_at < now())
         ORDER BY next_attempt_at
         LIMIT $3
         FOR UPDATE SKIP LOCKED)
     RETURNING *`,
    [leaseOwner, leaseMs, limit],
  );
  return result.rows.map(toTransfer);
}

/** The saga's persistence port, backed by this repo. */
export function createTransferStore(pool: Pool): SagaStore {
  return {
    casTransition: (req) => casTransition(pool, req),
    yieldTransfer: (req) => yieldTransfer(pool, req),
    getTransfer: (id) => getTransfer(pool, id),
  };
}

function toTransfer(row: TransferRow): Transfer {
  if (!isTransferState(row.state)) throw new Error(`transfer ${row.id} has unknown state ${row.state}`);
  return {
    id: row.id,
    clientId: row.client_id,
    idempotencyKey: row.idempotency_key,
    requestHash: row.request_hash,
    payer: { bankId: row.payer_bank_id, accountId: row.payer_account_id },
    payee: { bankId: row.payee_bank_id, accountId: row.payee_account_id },
    amount: BigInt(row.amount),
    currency: row.currency,
    note: row.note,
    state: row.state,
    failureCode: row.failure_code,
    failureMessage: row.failure_message,
    version: row.version,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
