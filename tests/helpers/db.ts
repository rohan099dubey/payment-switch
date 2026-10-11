/**
 * Raw-SQL negative tests ("the database rejects X") run against the shared dev stack. If
 * the guard they test were ever missing, or the test's precondition did not hold, a write
 * outside a transaction would commit a bad row that nothing may delete (append-only
 * tables, an outbox event that blocks a real one). So every write a test expects to be
 * rejected goes through `inRolledBackTransaction`: it can fail the test, never the data.
 */
import type { Pool, PoolClient } from 'pg';

/**
 * Runs `fn` in a transaction that is always rolled back, and returns the error it threw
 * (`undefined` if it threw none). One statement per call: after an error Postgres aborts
 * the transaction, so a second statement in the same one would test nothing.
 */
export async function inRolledBackTransaction(
  pool: Pool,
  fn: (c: PoolClient) => Promise<void>,
): Promise<Error | undefined> {
  const c = await pool.connect();
  let outcome: Error | undefined;
  try {
    await c.query('BEGIN');
    await fn(c);
  } catch (err) {
    outcome = err instanceof Error ? err : new Error(String(err));
  }
  try {
    await c.query('ROLLBACK');
  } catch (err) {
    // Destroying the connection ends the transaction server side without a commit.
    c.release(true);
    throw err;
  }
  c.release();
  return outcome;
}
