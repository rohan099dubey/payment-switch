import type { Pool, PoolClient } from 'pg';

export type AccountStatus = 'ACTIVE' | 'BLOCKED';

export interface Account {
  accountId: string;
  holderName: string;
  balance: bigint;
  currency: string;
  status: AccountStatus;
}

export interface NewAccount {
  accountId: string;
  holderName: string;
  openingBalance: bigint;
  currency: string;
  status: AccountStatus;
}

interface AccountRow {
  account_id: string;
  holder_name: string;
  balance: string;
  currency: string;
  status: AccountStatus;
}

const ACCOUNT_COLUMNS = 'account_id, holder_name, balance::text AS balance, currency, status';

/** Null when the account id is already taken. */
export async function createAccount(pool: Pool, account: NewAccount): Promise<Account | null> {
  const { rows } = await pool.query<AccountRow>(
    `INSERT INTO accounts (account_id, holder_name, balance, currency, status)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (account_id) DO NOTHING
     RETURNING ${ACCOUNT_COLUMNS}`,
    [account.accountId, account.holderName, account.openingBalance.toString(), account.currency, account.status],
  );
  const row = rows[0];
  return row === undefined ? null : toAccount(row);
}

export async function getAccount(db: Pool | PoolClient, accountId: string): Promise<Account | null> {
  const { rows } = await db.query<AccountRow>(`SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE account_id = $1`, [
    accountId,
  ]);
  const row = rows[0];
  return row === undefined ? null : toAccount(row);
}

function toAccount(row: AccountRow): Account {
  return {
    accountId: row.account_id,
    holderName: row.holder_name,
    balance: BigInt(row.balance),
    currency: row.currency,
    status: row.status,
  };
}

/** Readiness probe for `/readyz`: resolves once the database answers a trivial query. */
export async function ping(pool: Pool): Promise<void> {
  await pool.query('SELECT 1');
}
