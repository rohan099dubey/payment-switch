import { withTransaction } from '@switch/common';
import type { Pool } from 'pg';

/** Serializes snapshot writers across Ledger instances (the migration lock is 727274). */
export const SNAPSHOT_LOCK_KEY = 727275;

/** Postgres `lock_not_available`: `lock_timeout` expired. */
const LOCK_NOT_AVAILABLE = '55P03';

export type SnapshotOutcome =
  | { result: 'created'; snapshotId: bigint; lastEntryId: bigint; entriesAdded: bigint }
  | { result: 'up_to_date'; lastEntryId: bigint }
  | { result: 'lock_timeout' };

export interface SnapshotOptions {
  /** How long the writer may wait for, and so delay, journal postings. */
  lockTimeoutMs: number;
}

/**
 * Phase 2, item 5 (ADR-029): appends one balance snapshot covering every entry up to now.
 *
 * Entry ids come from a sequence when the row is inserted, not when it commits, so "every
 * entry with id <= W" is a safe cut only once no transaction that could still commit such
 * an id is open. Step 1 takes `SHARE` on `entries`, which waits for every posting
 * transaction in flight (they hold `ROW EXCLUSIVE` until commit) and blocks new ones only
 * for the instant it takes to read `max(id)`. After it, every id <= W belongs to a committed
 * or rolled-back transaction, and every later insert gets a larger id. `lock_timeout` bounds
 * how long postings can be held up; if it expires, this round is skipped.
 *
 * Step 2 is incremental: the previous snapshot's totals plus the entries in (previous, W].
 * The advisory lock and the `UNIQUE (last_entry_id)` make concurrent writers harmless.
 */
export async function createSnapshot(pool: Pool, options: SnapshotOptions): Promise<SnapshotOutcome> {
  let watermark: bigint;
  try {
    watermark = await withTransaction(pool, async (client) => {
      await client.query("SELECT set_config('lock_timeout', $1, true)", [`${options.lockTimeoutMs}ms`]);
      await client.query('LOCK TABLE entries IN SHARE MODE');
      const r = await client.query<{ w: string }>('SELECT COALESCE(max(id), 0)::text AS w FROM entries');
      return BigInt(r.rows[0]?.w ?? '0');
    });
  } catch (err) {
    if ((err as { code?: unknown }).code === LOCK_NOT_AVAILABLE) return { result: 'lock_timeout' };
    throw err;
  }

  return withTransaction(pool, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock($1)', [SNAPSHOT_LOCK_KEY]);
    // Distinct aliases: an output column named `last_entry_id` (text) would make ORDER BY
    // sort the text, and '982' > '2414' (an empty test database caught that).
    const latest = await client.query<{ id_text: string; last_text: string }>(
      `SELECT id::text AS id_text, last_entry_id::text AS last_text
         FROM balance_snapshots ORDER BY last_entry_id DESC LIMIT 1`,
    );
    const previous = latest.rows[0];
    const previousLast = BigInt(previous?.last_text ?? '0');
    if (previousLast >= watermark) return { result: 'up_to_date', lastEntryId: previousLast };

    const inserted = await client.query<{ id: string }>(
      'INSERT INTO balance_snapshots (last_entry_id) VALUES ($1) RETURNING id::text',
      [watermark.toString()],
    );
    const snapshotId = inserted.rows[0]?.id;
    if (snapshotId === undefined) throw new Error('balance snapshot insert returned no id');

    const lines = await client.query<{ added: string }>(
      `WITH later AS (
              SELECT account_id,
                     COALESCE(SUM(amount) FILTER (WHERE direction = 'D'), 0) AS d,
                     COALESCE(SUM(amount) FILTER (WHERE direction = 'C'), 0) AS c,
                     count(*) AS n
                FROM entries
               WHERE id > $2 AND id <= $3
               GROUP BY account_id
            ),
            ins AS (
              INSERT INTO balance_snapshot_lines (snapshot_id, account_id, debit_total, credit_total)
              SELECT $1, a.id,
                     COALESCE(p.debit_total, 0) + COALESCE(later.d, 0),
                     COALESCE(p.credit_total, 0) + COALESCE(later.c, 0)
                FROM accounts a
                LEFT JOIN balance_snapshot_lines p ON p.snapshot_id = $4 AND p.account_id = a.id
                LEFT JOIN later ON later.account_id = a.id
              RETURNING 1
            )
       SELECT COALESCE((SELECT sum(n) FROM later), 0)::text AS added, (SELECT count(*) FROM ins) AS lines`,
      [snapshotId, previousLast.toString(), watermark.toString(), previous?.id_text ?? '0'],
    );
    return {
      result: 'created',
      snapshotId: BigInt(snapshotId),
      lastEntryId: watermark,
      entriesAdded: BigInt(lines.rows[0]?.added ?? '0'),
    };
  });
}
