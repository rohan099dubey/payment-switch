import { Pool, type PoolClient, type PoolConfig } from 'pg';
import type { Logger } from './logger';

export type IsolationLevel = 'READ COMMITTED' | 'REPEATABLE READ' | 'SERIALIZABLE';

/**
 * `int8` columns arrive from `pg` as strings; convert money with `BigInt()` at the
 * repo boundary. That default is deliberately left alone here.
 */
export function createPool(url: string, logger?: Logger, overrides: Omit<PoolConfig, 'connectionString'> = {}): Pool {
  const pool = new Pool({ connectionString: url, ...overrides });
  // An idle client losing its connection emits 'error' on the pool. Unhandled, that
  // event crashes the process; the next query will reconnect instead.
  pool.on('error', (err) => {
    logger?.warn({ err }, 'idle postgres client error');
  });
  return pool;
}

export interface TransactionOptions {
  isolation?: IsolationLevel;
  readOnly?: boolean;
}

/**
 * Runs `fn` inside BEGIN/COMMIT on one pooled client, rolling back on any throw.
 * Never hold one of these open across a gRPC call (spec rule 6).
 */
export async function withTransaction<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
  isolation: IsolationLevel = 'READ COMMITTED',
  options: Omit<TransactionOptions, 'isolation'> = {},
): Promise<T> {
  const client = await pool.connect();
  let broken = false;
  try {
    await client.query(`BEGIN ISOLATION LEVEL ${isolation}${options.readOnly ? ' READ ONLY' : ''}`);
    try {
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // The connection is unusable; destroy it rather than return it to the pool.
        broken = true;
      }
      throw err;
    }
  } finally {
    client.release(broken);
  }
}
