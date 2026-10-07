import { withTransaction } from '@switch/common';
import type { Pool, PoolClient } from 'pg';
import { getAccount } from './accountsRepo';

export type OperationKind = 'DEBIT' | 'CREDIT' | 'REVERSE_DEBIT';
export type OperationStatus = 'APPLIED' | 'VOIDED';

/** Business rejections and conflicts, each mapped to an `x-error-code` by the handlers. */
export type RejectionCode =
  | 'INSUFFICIENT_FUNDS'
  | 'ACCOUNT_BLOCKED'
  | 'ACCOUNT_NOT_FOUND'
  | 'CURRENCY_MISMATCH'
  | 'REFERENCE_VOIDED'
  | 'REFERENCE_CONFLICT'
  | 'NOTHING_TO_REVERSE';

export interface AppliedOperation {
  bankTxnId: string;
  appliedAt: Date;
  /** Balance after this call. On a replay, the account's balance at replay time: the spec schema does not store the original. */
  balanceAfter: bigint;
  replayed: boolean;
}

export type MoneyOutcome =
  { status: 'applied'; operation: AppliedOperation } | { status: 'rejected'; code: RejectionCode };

export interface MoneyRequest {
  referenceId: string;
  accountId: string;
  amount: bigint;
  currency: string;
}

export interface OperationLookup {
  status: OperationStatus | 'NOT_FOUND';
  accountId: string | null;
  amount: bigint | null;
}

interface OperationRow {
  status: OperationStatus;
  account_id: string | null;
  amount: string | null;
  bank_txn_id: string;
  created_at: Date;
}

const OPERATION_COLUMNS = 'status, account_id, amount::text AS amount, bank_txn_id, created_at';

/** Thrown inside a transaction purely to roll it back (spec: "roll back the whole transaction"). */
class Rejection extends Error {
  constructor(readonly code: RejectionCode) {
    super(code);
  }
}

/**
 * Debit or Credit (spec section 8), one READ COMMITTED transaction:
 * 1. Insert the operation row; a concurrent same-key insert blocks until the first commits.
 * 2. On conflict: VOIDED -> REFERENCE_VOIDED; same account and amount -> replay;
 *    otherwise REFERENCE_CONFLICT.
 * 3. One conditional UPDATE does the check and the change atomically, so two debits can
 *    never both spend the same funds. If it matches no row, work out why and roll back
 *    everything, including the operation row: business rejections are not recorded.
 */
export async function applyMoneyOperation(
  pool: Pool,
  kind: 'DEBIT' | 'CREDIT',
  request: MoneyRequest,
): Promise<MoneyOutcome> {
  return runRejectable(() =>
    withTransaction(pool, async (client) => {
      const inserted = await client.query<{ bank_txn_id: string; created_at: Date }>(
        `INSERT INTO operations (reference_id, operation, status, account_id, amount)
         VALUES ($1, $2, 'APPLIED', $3, $4)
         ON CONFLICT DO NOTHING
         RETURNING bank_txn_id, created_at`,
        [request.referenceId, kind, request.accountId, request.amount.toString()],
      );
      const row = inserted.rows[0];

      if (row === undefined) {
        const existing = await readOperation(client, request.referenceId, kind);
        if (existing.status === 'VOIDED') return rejected('REFERENCE_VOIDED');
        if (existing.account_id !== request.accountId || existing.amount !== request.amount.toString()) {
          return rejected('REFERENCE_CONFLICT');
        }
        return applied(existing, await currentBalance(client, request.accountId), true);
      }

      const sql =
        kind === 'DEBIT'
          ? `UPDATE accounts SET balance = balance - $2
              WHERE account_id = $1 AND status = 'ACTIVE' AND currency = $3 AND balance >= $2
              RETURNING balance::text AS balance`
          : `UPDATE accounts SET balance = balance + $2
              WHERE account_id = $1 AND status = 'ACTIVE' AND currency = $3
              RETURNING balance::text AS balance`;
      const updated = await client.query<{ balance: string }>(sql, [
        request.accountId,
        request.amount.toString(),
        request.currency,
      ]);
      const balance = updated.rows[0]?.balance;
      if (balance === undefined) throw new Rejection(await diagnose(client, request));

      return applied(row, BigInt(balance), false);
    }),
  );
}

/**
 * ReverseDebit (spec section 8): refunds an APPLIED debit. Works even if the account is
 * now BLOCKED, because a refund must always succeed. Idempotent by its own row.
 */
export async function reverseDebit(pool: Pool, referenceId: string): Promise<MoneyOutcome> {
  return runRejectable(() =>
    withTransaction(pool, async (client) => {
      const debit = await client.query<OperationRow>(
        `SELECT ${OPERATION_COLUMNS} FROM operations WHERE reference_id = $1 AND operation = 'DEBIT'`,
        [referenceId],
      );
      const original = debit.rows[0];
      if (original?.status !== 'APPLIED' || original.account_id === null || original.amount === null) {
        return rejected('NOTHING_TO_REVERSE');
      }

      const inserted = await client.query<{ bank_txn_id: string; created_at: Date }>(
        `INSERT INTO operations (reference_id, operation, status, account_id, amount)
         VALUES ($1, 'REVERSE_DEBIT', 'APPLIED', $2, $3)
         ON CONFLICT DO NOTHING
         RETURNING bank_txn_id, created_at`,
        [referenceId, original.account_id, original.amount],
      );
      const row = inserted.rows[0];
      if (row === undefined) {
        const existing = await readOperation(client, referenceId, 'REVERSE_DEBIT');
        return applied(existing, await currentBalance(client, original.account_id), true);
      }

      const updated = await client.query<{ balance: string }>(
        `UPDATE accounts SET balance = balance + $2 WHERE account_id = $1 RETURNING balance::text AS balance`,
        [original.account_id, original.amount],
      );
      const balance = updated.rows[0]?.balance;
      if (balance === undefined) throw new Error(`account ${original.account_id} of an applied debit is missing`);
      return applied(row, BigInt(balance), false);
    }),
  );
}

/**
 * Resolve (spec section 8): settles an unknown outcome for good. Inserts a VOIDED
 * tombstone; if the real operation committed first the insert conflicts and the row says
 * APPLIED. If the tombstone lands first, a late Debit or Credit hits it and fails with
 * REFERENCE_VOIDED. The primary key arbitrates the race, and the answer never changes.
 */
export async function resolveOperation(
  pool: Pool,
  referenceId: string,
  kind: 'DEBIT' | 'CREDIT',
): Promise<OperationStatus> {
  return withTransaction(pool, async (client) => {
    await client.query(
      `INSERT INTO operations (reference_id, operation, status) VALUES ($1, $2, 'VOIDED')
       ON CONFLICT DO NOTHING`,
      [referenceId, kind],
    );
    return (await readOperation(client, referenceId, kind)).status;
  });
}

/** Read-only lookup for tests and reconciliation. */
export async function getOperation(pool: Pool, referenceId: string, kind: OperationKind): Promise<OperationLookup> {
  const { rows } = await pool.query<OperationRow>(
    `SELECT ${OPERATION_COLUMNS} FROM operations WHERE reference_id = $1 AND operation = $2`,
    [referenceId, kind],
  );
  const row = rows[0];
  if (row === undefined) return { status: 'NOT_FOUND', accountId: null, amount: null };
  return { status: row.status, accountId: row.account_id, amount: row.amount === null ? null : BigInt(row.amount) };
}

async function readOperation(client: PoolClient, referenceId: string, kind: OperationKind): Promise<OperationRow> {
  const { rows } = await client.query<OperationRow>(
    `SELECT ${OPERATION_COLUMNS} FROM operations WHERE reference_id = $1 AND operation = $2`,
    [referenceId, kind],
  );
  const row = rows[0];
  // Operations are never deleted, so a row that caused a conflict cannot disappear.
  if (row === undefined) throw new Error(`operation ${kind} ${referenceId} conflicted but cannot be read`);
  return row;
}

async function currentBalance(client: PoolClient, accountId: string): Promise<bigint> {
  const account = await getAccount(client, accountId);
  if (account === null) throw new Error(`account ${accountId} of an applied operation is missing`);
  return account.balance;
}

/** The conditional UPDATE matched nothing: say why, in the spec's order of precedence. */
async function diagnose(client: PoolClient, request: MoneyRequest): Promise<RejectionCode> {
  const account = await getAccount(client, request.accountId);
  if (account === null) return 'ACCOUNT_NOT_FOUND';
  if (account.status === 'BLOCKED') return 'ACCOUNT_BLOCKED';
  if (account.currency !== request.currency) return 'CURRENCY_MISMATCH';
  return 'INSUFFICIENT_FUNDS';
}

async function runRejectable(fn: () => Promise<MoneyOutcome>): Promise<MoneyOutcome> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof Rejection) return rejected(err.code);
    throw err;
  }
}

function applied(
  row: { bank_txn_id: string; created_at: Date },
  balanceAfter: bigint,
  replayed: boolean,
): MoneyOutcome {
  return {
    status: 'applied',
    operation: { bankTxnId: row.bank_txn_id, appliedAt: row.created_at, balanceAfter, replayed },
  };
}

function rejected(code: RejectionCode): MoneyOutcome {
  return { status: 'rejected', code };
}

export interface StatementLine {
  referenceId: string;
  operation: OperationKind;
  accountId: string;
  amount: bigint;
  appliedAt: Date;
}

export interface StatementPage {
  lines: StatementLine[];
  /** `[created_at as Postgres text, reference_id, operation]` of the last line; null on the last page. */
  nextKey: [string, string, string] | null;
}

/**
 * GetStatement (ADR-027): the APPLIED operations created in `[from, to)`, in
 * `(created_at, reference_id, operation)` order, at most `limit`, after `after`. A VOIDED
 * tombstone moved no money and is not a statement line.
 */
export async function getStatement(
  pool: Pool,
  from: Date,
  to: Date,
  limit: number,
  after: readonly [string, string, string] | null,
): Promise<StatementPage> {
  const { rows } = await pool.query<{
    reference_id: string;
    operation: OperationKind;
    account_id: string;
    amount: string;
    created_at: Date;
    created_at_text: string;
  }>(
    `SELECT reference_id, operation, account_id, amount::text AS amount, created_at, created_at::text AS created_at_text
       FROM operations
      WHERE status = 'APPLIED' AND created_at >= $1 AND created_at < $2
        AND ($3::timestamptz IS NULL OR (created_at, reference_id, operation) > ($3::timestamptz, $4, $5))
      ORDER BY created_at, reference_id, operation
      LIMIT $6`,
    [from, to, after?.[0] ?? null, after?.[1] ?? null, after?.[2] ?? null, limit],
  );
  const last = rows.at(-1);
  return {
    lines: rows.map((row) => ({
      referenceId: row.reference_id,
      operation: row.operation,
      accountId: row.account_id,
      amount: BigInt(row.amount),
      appliedAt: row.created_at,
    })),
    nextKey:
      last !== undefined && rows.length === limit ? [last.created_at_text, last.reference_id, last.operation] : null,
  };
}
