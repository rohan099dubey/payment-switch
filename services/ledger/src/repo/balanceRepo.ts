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
 * Balances are derived from `entries`, never stored (spec section 7). SUM(bigint) is
 * numeric in Postgres, so it is read as text and converted with BigInt().
 */
const BALANCES_SQL = `
  SELECT code, type, currency,
         d::text AS debit_total,
         c::text AS credit_total,
         (CASE WHEN type = 'ASSET' THEN d - c ELSE c - d END)::text AS balance
    FROM (
      SELECT a.code, a.type, a.currency,
             COALESCE(SUM(e.amount) FILTER (WHERE e.direction = 'D'), 0) AS d,
             COALESCE(SUM(e.amount) FILTER (WHERE e.direction = 'C'), 0) AS c
        FROM accounts a
        LEFT JOIN entries e ON e.account_id = a.id
       WHERE $1::text IS NULL OR a.code = $1::text
       GROUP BY a.id
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
