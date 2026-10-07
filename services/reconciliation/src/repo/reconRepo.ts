import type { Pool } from 'pg';
import type { LegOperation } from '../domain/legs';
import type { BreakKey, FoundBreak, ReconcileResult, ReconStore } from '../domain/reconciler';

/** All SQL of the reconciliation service (section 3 convention). */

/** Serializes runs across instances (session-level advisory lock, ADR-027). */
const RUN_LOCK_KEY = 727275;

export type RunTrigger = 'SCHEDULED' | 'ON_DEMAND';

export interface RunRecord {
  id: string;
  from: Date;
  to: Date;
  startedAt: Date;
  finishedAt: Date | null;
  statementLines: number | null;
  journals: number | null;
  breaksOpened: number | null;
  breaksResolved: number | null;
  openBreaks: number | null;
  error: string | null;
}

export interface BreakRecord {
  bankId: string;
  referenceId: string;
  operation: LegOperation;
  type: string;
  bankAmount: bigint | null;
  ledgerAmount: bigint | null;
  status: 'OPEN' | 'RESOLVED';
  firstSeenAt: Date;
  lastSeenAt: Date;
  resolvedAt: Date | null;
}

const keyArrays = (keys: readonly BreakKey[]): [string[], string[], string[]] => [
  keys.map((k) => k.bankId),
  keys.map((k) => k.referenceId),
  keys.map((k) => k.operation),
];

export function createReconStore(pool: Pool): ReconStore {
  return {
    openBreaks: async () => {
      const { rows } = await pool.query<{ bank_id: string; reference_id: string; operation: LegOperation }>(
        "SELECT bank_id, reference_id, operation FROM reconciliation_breaks WHERE status = 'OPEN'",
      );
      return rows.map((r) => ({ bankId: r.bank_id, referenceId: r.reference_id, operation: r.operation }));
    },

    // New or previously RESOLVED keys count as opened; a break still open only moves last_seen_at.
    recordBreaks: async (breaks: FoundBreak[]) => {
      if (breaks.length === 0) return 0;
      const [banks, refs, ops] = keyArrays(breaks);
      const { rows } = await pool.query<{ n: number }>(
        `WITH input AS (
           SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::bigint[], $6::bigint[])
             AS t(bank_id, reference_id, operation, break_type, bank_amount, ledger_amount)
         ),
         prev AS (
           SELECT b.bank_id, b.reference_id, b.operation, b.status
             FROM reconciliation_breaks b JOIN input i USING (bank_id, reference_id, operation)
         ),
         up AS (
           INSERT INTO reconciliation_breaks (bank_id, reference_id, operation, break_type, bank_amount, ledger_amount, status)
           SELECT bank_id, reference_id, operation, break_type, bank_amount, ledger_amount, 'OPEN' FROM input
           ON CONFLICT (bank_id, reference_id, operation) DO UPDATE
             SET break_type = EXCLUDED.break_type, bank_amount = EXCLUDED.bank_amount,
                 ledger_amount = EXCLUDED.ledger_amount, status = 'OPEN', resolved_at = NULL, last_seen_at = now()
           RETURNING bank_id, reference_id, operation
         )
         SELECT count(*)::int AS n FROM up LEFT JOIN prev USING (bank_id, reference_id, operation)
          WHERE prev.status IS NULL OR prev.status = 'RESOLVED'`,
        [
          banks,
          refs,
          ops,
          breaks.map((b) => b.type),
          breaks.map((b) => (b.bankAmount === null ? null : b.bankAmount.toString())),
          breaks.map((b) => (b.ledgerAmount === null ? null : b.ledgerAmount.toString())),
        ],
      );
      return rows[0]?.n ?? 0;
    },

    resolve: async (keys: BreakKey[]) => {
      if (keys.length === 0) return 0;
      const [banks, refs, ops] = keyArrays(keys);
      const { rowCount } = await pool.query(
        `UPDATE reconciliation_breaks b
            SET status = 'RESOLVED', resolved_at = now(), last_seen_at = now()
           FROM unnest($1::text[], $2::text[], $3::text[]) AS k(bank_id, reference_id, operation)
          WHERE b.bank_id = k.bank_id AND b.reference_id = k.reference_id AND b.operation = k.operation
            AND b.status = 'OPEN'`,
        [banks, refs, ops],
      );
      return rowCount ?? 0;
    },

    countOpen: () => countOpenBreaks(pool),
  };
}

/** Runs `fn` holding the cluster-wide run lock, so two runs never interleave. */
export async function withRunLock<T>(pool: Pool, fn: () => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [RUN_LOCK_KEY]);
    try {
      return await fn();
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [RUN_LOCK_KEY]);
    }
  } finally {
    client.release();
  }
}

export async function startRun(pool: Pool, from: Date, to: Date, trigger: RunTrigger): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    'INSERT INTO reconciliation_runs (window_from, window_to, trigger) VALUES ($1, $2, $3) RETURNING id',
    [from, to, trigger],
  );
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('reconciliation run was not recorded');
  return id;
}

export async function finishRun(pool: Pool, id: string, r: ReconcileResult): Promise<void> {
  await pool.query(
    `UPDATE reconciliation_runs
        SET finished_at = now(), statement_lines = $2, journals = $3, breaks_opened = $4,
            breaks_resolved = $5, open_breaks = $6
      WHERE id = $1`,
    [id, r.statementLines, r.journals, r.breaksOpened, r.breaksResolved, r.openBreaks],
  );
}

export async function failRun(pool: Pool, id: string, error: string): Promise<void> {
  await pool.query('UPDATE reconciliation_runs SET finished_at = now(), error = $2 WHERE id = $1', [id, error]);
}

/** Where the scheduled job continues: the `to` of the last successful scheduled run. */
export async function lastScheduledTo(pool: Pool): Promise<Date | null> {
  const { rows } = await pool.query<{ to: Date | null }>(
    `SELECT max(window_to) AS to FROM reconciliation_runs
      WHERE trigger = 'SCHEDULED' AND finished_at IS NOT NULL AND error IS NULL`,
  );
  return rows[0]?.to ?? null;
}

interface RunRow {
  id: string;
  window_from: Date;
  window_to: Date;
  started_at: Date;
  finished_at: Date | null;
  statement_lines: number | null;
  journals: number | null;
  breaks_opened: number | null;
  breaks_resolved: number | null;
  open_breaks: number | null;
  error: string | null;
}

const toRun = (r: RunRow): RunRecord => ({
  id: r.id,
  from: r.window_from,
  to: r.window_to,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
  statementLines: r.statement_lines,
  journals: r.journals,
  breaksOpened: r.breaks_opened,
  breaksResolved: r.breaks_resolved,
  openBreaks: r.open_breaks,
  error: r.error,
});

export async function getRun(pool: Pool, id: string): Promise<RunRecord | null> {
  const { rows } = await pool.query<RunRow>('SELECT * FROM reconciliation_runs WHERE id = $1', [id]);
  const row = rows[0];
  return row === undefined ? null : toRun(row);
}

export async function latestRun(pool: Pool): Promise<RunRecord | null> {
  const { rows } = await pool.query<RunRow>(
    'SELECT * FROM reconciliation_runs WHERE finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 1',
  );
  const row = rows[0];
  return row === undefined ? null : toRun(row);
}

/** `GetReport`: breaks filtered by status and reference ids, newest first. */
export async function listBreaks(
  pool: Pool,
  filter: { status: 'OPEN' | 'RESOLVED' | null; referenceIds: string[]; limit: number },
): Promise<BreakRecord[]> {
  const { rows } = await pool.query<{
    bank_id: string;
    reference_id: string;
    operation: LegOperation;
    break_type: string;
    bank_amount: string | null;
    ledger_amount: string | null;
    status: 'OPEN' | 'RESOLVED';
    first_seen_at: Date;
    last_seen_at: Date;
    resolved_at: Date | null;
  }>(
    `SELECT bank_id, reference_id, operation, break_type, bank_amount::text AS bank_amount,
            ledger_amount::text AS ledger_amount, status, first_seen_at, last_seen_at, resolved_at
       FROM reconciliation_breaks
      WHERE ($1::text IS NULL OR status = $1)
        AND (cardinality($2::text[]) = 0 OR reference_id = ANY($2::text[]))
      ORDER BY first_seen_at DESC, reference_id
      LIMIT $3`,
    [filter.status, filter.referenceIds, filter.limit],
  );
  return rows.map((r) => ({
    bankId: r.bank_id,
    referenceId: r.reference_id,
    operation: r.operation,
    type: r.break_type,
    bankAmount: r.bank_amount === null ? null : BigInt(r.bank_amount),
    ledgerAmount: r.ledger_amount === null ? null : BigInt(r.ledger_amount),
    status: r.status,
    firstSeenAt: r.first_seen_at,
    lastSeenAt: r.last_seen_at,
    resolvedAt: r.resolved_at,
  }));
}

export async function countOpenBreaks(pool: Pool): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM reconciliation_breaks WHERE status = 'OPEN'",
  );
  return rows[0]?.n ?? 0;
}

export async function ping(pool: Pool): Promise<void> {
  await pool.query('SELECT 1');
}
