import { withTransaction } from '@switch/common';
import { DatabaseError, type Pool, type PoolClient } from 'pg';
import type { Direction, JournalLine, ValidJournal } from '../domain/validate';

export interface StoredJournal {
  id: string;
  idempotencyKey: string;
  referenceId: string;
  kind: string;
  description: string | null;
  currency: string;
  createdAt: Date;
  lines: JournalLine[];
}

export type PostJournalOutcome =
  | { status: 'created'; journal: StoredJournal }
  | { status: 'replayed'; journal: StoredJournal }
  | { status: 'key_reused' }
  | { status: 'unknown_accounts'; codes: string[] }
  | { status: 'rejected_by_database'; sqlstate: string; message: string };

/**
 * SQLSTATEs that mean "the database's own invariants refused this journal" (ADR-017):
 * `P0001` is `RAISE EXCEPTION` from the append-only and balance triggers, `23514` a
 * `CHECK` constraint. Both are deterministic, so retrying the same request can never
 * succeed. Only reachable if application validation has a bug.
 */
const INVARIANT_SQLSTATES: ReadonlySet<string> = new Set(['P0001', '23514']);

/** The database rejection carried by `err`, or null if `err` is anything else (ADR-017). */
export function databaseRejectionOf(err: unknown): { sqlstate: string; message: string } | null {
  if (!(err instanceof DatabaseError) || err.code === undefined || !INVARIANT_SQLSTATES.has(err.code)) return null;
  return { sqlstate: err.code, message: err.message };
}

export const LIST_JOURNALS_LIMIT = 50;

interface JournalRow {
  id: string;
  idempotency_key: string;
  request_hash: string;
  reference_id: string;
  kind: string;
  description: string | null;
  currency: string;
  created_at: Date;
}

interface LineRow {
  journal_id: string;
  code: string;
  direction: Direction;
  amount: string;
}

const JOURNAL_COLUMNS = 'id, idempotency_key, request_hash, reference_id, kind, description, currency, created_at';

/** Thrown inside the transaction purely to roll it back; converted to an outcome below. */
class UnknownAccountsError extends Error {
  constructor(readonly codes: string[]) {
    super(`unknown account codes: ${codes.join(', ')}`);
  }
}

/**
 * Spec section 7, step 3, at READ COMMITTED with no explicit locking. A concurrent call
 * with the same key blocks on the unique index until the first commits, then takes the
 * replay branch. The deferred `entries_balanced` trigger re-checks the balance at COMMIT.
 */
export async function postJournal(pool: Pool, journal: ValidJournal, requestHash: string): Promise<PostJournalOutcome> {
  try {
    return await withTransaction(pool, async (client) => {
      const inserted = await client.query<{ id: string; created_at: Date }>(
        `INSERT INTO journals (idempotency_key, request_hash, reference_id, kind, description, currency)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING id, created_at`,
        [
          journal.idempotencyKey,
          requestHash,
          journal.referenceId,
          journal.kind,
          journal.description === '' ? null : journal.description,
          journal.currency,
        ],
      );

      const row = inserted.rows[0];
      if (row === undefined) {
        const existing = await client.query<JournalRow>(
          `SELECT ${JOURNAL_COLUMNS} FROM journals WHERE idempotency_key = $1`,
          [journal.idempotencyKey],
        );
        const found = existing.rows[0];
        if (found === undefined) {
          // Journals are never deleted, so a conflicting row cannot disappear.
          throw new Error(`journal with key ${journal.idempotencyKey} conflicted but cannot be read`);
        }
        if (found.request_hash !== requestHash) return { status: 'key_reused' };
        const lines = await loadLines(client, [found.id]);
        return { status: 'replayed', journal: toStored(found, lines.get(found.id) ?? []) };
      }

      const codes = [...new Set(journal.lines.map((line) => line.accountCode))];
      const accounts = await client.query<{ id: string; code: string }>(
        'SELECT id, code FROM accounts WHERE code = ANY($1::text[])',
        [codes],
      );
      const idByCode = new Map(accounts.rows.map((account) => [account.code, account.id]));
      const missing = codes.filter((code) => !idByCode.has(code));
      if (missing.length > 0) throw new UnknownAccountsError(missing);

      // One multi-row INSERT; WITH ORDINALITY keeps entry ids in request line order.
      await client.query(
        `INSERT INTO entries (journal_id, account_id, direction, amount)
         SELECT $1, t.account_id, t.direction, t.amount
           FROM unnest($2::bigint[], $3::text[], $4::bigint[]) WITH ORDINALITY AS t(account_id, direction, amount, ord)
          ORDER BY t.ord`,
        [
          row.id,
          journal.lines.map((line) => idByCode.get(line.accountCode)),
          journal.lines.map((line) => line.direction),
          journal.lines.map((line) => line.amount.toString()),
        ],
      );

      return {
        status: 'created',
        journal: {
          id: row.id,
          idempotencyKey: journal.idempotencyKey,
          referenceId: journal.referenceId,
          kind: journal.kind,
          description: journal.description === '' ? null : journal.description,
          currency: journal.currency,
          createdAt: row.created_at,
          lines: journal.lines,
        },
      };
    });
  } catch (err) {
    if (err instanceof UnknownAccountsError) return { status: 'unknown_accounts', codes: err.codes };
    const rejection = databaseRejectionOf(err);
    if (rejection !== null) return { status: 'rejected_by_database', ...rejection };
    throw err;
  }
}

export async function getJournal(pool: Pool, id: string): Promise<StoredJournal | null> {
  const client = await pool.connect();
  try {
    const result = await client.query<JournalRow>(`SELECT ${JOURNAL_COLUMNS} FROM journals WHERE id = $1`, [id]);
    const row = result.rows[0];
    if (row === undefined) return null;
    const lines = await loadLines(client, [row.id]);
    return toStored(row, lines.get(row.id) ?? []);
  } finally {
    client.release();
  }
}

/** At most 50 journals for a reference id, oldest first (spec section 7). */
export async function listJournalsByReference(pool: Pool, referenceId: string): Promise<StoredJournal[]> {
  const client = await pool.connect();
  try {
    const result = await client.query<JournalRow>(
      `SELECT ${JOURNAL_COLUMNS} FROM journals
        WHERE reference_id = $1
        ORDER BY created_at, id
        LIMIT $2`,
      [referenceId, LIST_JOURNALS_LIMIT],
    );
    // Journals and their entries commit atomically and are append-only, so a second
    // statement sees every entry of every journal the first one returned.
    const lines = await loadLines(
      client,
      result.rows.map((row) => row.id),
    );
    return result.rows.map((row) => toStored(row, lines.get(row.id) ?? []));
  } finally {
    client.release();
  }
}

async function loadLines(client: PoolClient, journalIds: string[]): Promise<Map<string, JournalLine[]>> {
  const byJournal = new Map<string, JournalLine[]>();
  if (journalIds.length === 0) return byJournal;
  const result = await client.query<LineRow>(
    `SELECT e.journal_id, a.code, e.direction, e.amount::text AS amount
       FROM entries e
       JOIN accounts a ON a.id = e.account_id
      WHERE e.journal_id = ANY($1::uuid[])
      ORDER BY e.id`,
    [journalIds],
  );
  for (const row of result.rows) {
    const lines = byJournal.get(row.journal_id) ?? [];
    lines.push({ accountCode: row.code, direction: row.direction, amount: BigInt(row.amount) });
    byJournal.set(row.journal_id, lines);
  }
  return byJournal;
}

function toStored(row: JournalRow, lines: JournalLine[]): StoredJournal {
  return {
    id: row.id,
    idempotencyKey: row.idempotency_key,
    referenceId: row.reference_id,
    kind: row.kind,
    description: row.description,
    currency: row.currency,
    createdAt: row.created_at,
    lines,
  };
}

export interface JournalPage {
  journals: StoredJournal[];
  /** Sort key of the last journal, `[created_at as Postgres text, id]`; null on the last page. */
  nextKey: [string, string] | null;
}

/**
 * Journals created in `[from, to)`, in `(created_at, id)` order, at most `limit`, after the
 * key `after` (ADR-027). The key's timestamp is Postgres text, so microseconds survive.
 */
export async function listJournalsByTime(
  pool: Pool,
  from: Date,
  to: Date,
  limit: number,
  after: readonly [string, string] | null,
): Promise<JournalPage> {
  const client = await pool.connect();
  try {
    const result = await client.query<JournalRow & { created_at_text: string }>(
      `SELECT ${JOURNAL_COLUMNS}, created_at::text AS created_at_text
         FROM journals
        WHERE created_at >= $1 AND created_at < $2
          AND ($3::timestamptz IS NULL OR (created_at, id) > ($3::timestamptz, $4::uuid))
        ORDER BY created_at, id
        LIMIT $5`,
      [from, to, after?.[0] ?? null, after?.[1] ?? null, limit],
    );
    const lines = await loadLines(
      client,
      result.rows.map((row) => row.id),
    );
    const last = result.rows.at(-1);
    return {
      journals: result.rows.map((row) => toStored(row, lines.get(row.id) ?? [])),
      nextKey: last !== undefined && result.rows.length === limit ? [last.created_at_text, last.id] : null,
    };
  } finally {
    client.release();
  }
}
