import { withTransaction } from '@switch/common';
import type { Pool } from 'pg';

export type AccountType = 'ASSET' | 'LIABILITY';

export interface AccountBalance {
  code: string;
  type: AccountType;
  currency: string;
  debitTotal: bigint;
  creditTotal: bigint;
  /** Normal-side balance: debit - credit for ASSET, credit - debit for LIABILITY. */
  balance: bigint;
}

export interface TrialBalance {
  accounts: AccountBalance[];
  totalDebits: bigint;
  totalCredits: bigint;
  balanced: boolean;
}

interface BalanceRow {
  code: string;
  type: AccountType;
  currency: string;
  debit_total: string;
  credit_total: string;
  balance: string;
}

/**
 * Balances are derived from `entries`, never stored (spec section 7). Phase 2, item 5
 * (ADR-029): the latest balance snapshot holds each account's totals over every entry with
 * `id <= last_entry_id`, so only the entries after it are summed, through the
 * `(account_id, id)` index. Every entry up to `last_entry_id` had committed before the
 * snapshot was taken (`snapshotRepo.ts`), so nothing is missed or counted twice. With no
 * snapshot yet, `last_entry_id` is 0 and this is the plain sum over all entries.
 *
 * SUM(bigint) is numeric in Postgres, so totals are read as text and converted with BigInt().
 * Exported for the integration test that checks the plan reads only the later entries.
 */
export const BALANCES_SQL = `
  WITH latest AS (
         SELECT id, last_entry_id FROM balance_snapshots ORDER BY last_entry_id DESC LIMIT 1
       ),
       snap AS (
         SELECT COALESCE((SELECT id FROM latest), 0) AS id,
                COALESCE((SELECT last_entry_id FROM latest), 0) AS last_entry_id
       )
  SELECT code, type, currency,
         d::text AS debit_total,
         c::text AS credit_total,
         (CASE WHEN type = 'ASSET' THEN d - c ELSE c - d END)::text AS balance
    FROM (
      SELECT a.code, a.type, a.currency,
             COALESCE(l.debit_total, 0) + later.d AS d,
             COALESCE(l.credit_total, 0) + later.c AS c
        FROM accounts a
       CROSS JOIN snap
        LEFT JOIN balance_snapshot_lines l ON l.snapshot_id = snap.id AND l.account_id = a.id
       CROSS JOIN LATERAL (
             SELECT COALESCE(SUM(e.amount) FILTER (WHERE e.direction = 'D'), 0) AS d,
                    COALESCE(SUM(e.amount) FILTER (WHERE e.direction = 'C'), 0) AS c
               FROM entries e
              WHERE e.account_id = a.id AND e.id > snap.last_entry_id
           ) later
       WHERE $1::text IS NULL OR a.code = $1::text
    ) totals
   ORDER BY code`;

/** One account's derived balance, in a REPEATABLE READ READ ONLY transaction. Null if unknown. */
export async function getBalance(pool: Pool, accountCode: string): Promise<AccountBalance | null> {
  const rows = await withTransaction(
    pool,
    async (client) => (await client.query<BalanceRow>(BALANCES_SQL, [accountCode])).rows,
    'REPEATABLE READ',
    { readOnly: true },
  );
  const row = rows[0];
  return row === undefined ? null : toBalance(row);
}

/** Every account plus totals, all read in one REPEATABLE READ READ ONLY transaction. */
export async function getTrialBalance(pool: Pool): Promise<TrialBalance> {
  const rows = await withTransaction(
    pool,
    async (client) => (await client.query<BalanceRow>(BALANCES_SQL, [null])).rows,
    'REPEATABLE READ',
    { readOnly: true },
  );
  const accounts = rows.map(toBalance);
  const totalDebits = accounts.reduce((sum, account) => sum + account.debitTotal, 0n);
  const totalCredits = accounts.reduce((sum, account) => sum + account.creditTotal, 0n);
  return { accounts, totalDebits, totalCredits, balanced: totalDebits === totalCredits };
}

function toBalance(row: BalanceRow): AccountBalance {
  return {
    code: row.code,
    type: row.type,
    currency: row.currency,
    debitTotal: BigInt(row.debit_total),
    creditTotal: BigInt(row.credit_total),
    balance: BigInt(row.balance),
  };
}

/** Readiness probe for `/readyz`: resolves once the database answers a trivial query. */
export async function ping(pool: Pool): Promise<void> {
  await pool.query('SELECT 1');
}
