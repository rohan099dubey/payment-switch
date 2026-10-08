/**
 * Phase 2, item 5 (ADR-029): balance snapshots. Runs against the live stack's Ledger and
 * `ledger_db`, and calls the snapshot writer directly, as a second Ledger instance would.
 *
 * Safety: a wrong snapshot committed to a shared database would corrupt every later read,
 * and snapshots cannot be deleted. The negative tests below therefore fire the deferred
 * checks with `SET CONSTRAINTS ALL IMMEDIATE` inside a transaction that always rolls back.
 * Only the real writer commits snapshots.
 */
import { randomUUID } from 'node:crypto';
import { callUnary, makeClient } from '@switch/common';
import { EntryDirection, LedgerServiceClient, type PostJournalRequest } from '@switch/proto-gen/ledger/v1';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BALANCES_SQL } from '../../services/ledger/src/repo/balanceRepo';
import { createSnapshot, type SnapshotOutcome } from '../../services/ledger/src/repo/snapshotRepo';
import { checkI11, mapLimit } from '../helpers/invariants';
import { LedgerReader } from '../helpers/ledgerClient';

const LEDGER_ADDR = process.env.LEDGER_GRPC_ADDR ?? 'localhost:50052';
const LEDGER_DB = process.env.LEDGER_DATABASE_URL ?? 'postgres://ledger:ledger@localhost:5434/ledger_db';
const TIMEOUT_MS = 10_000;
const D = EntryDirection.ENTRY_DIRECTION_DEBIT;
const C = EntryDirection.ENTRY_DIRECTION_CREDIT;
const RUN = randomUUID();

let client: LedgerServiceClient;
let reader: LedgerReader;
let db: Pool;

beforeAll(() => {
  client = makeClient(LedgerServiceClient, LEDGER_ADDR);
  reader = new LedgerReader();
  db = new Pool({ connectionString: LEDGER_DB, max: 8 });
});

afterAll(async () => {
  client.close();
  reader.close();
  await db.end();
});

/** A balanced test journal that reconciliation ignores (not a transfer-leg kind). */
function testJournal(n: number, debit: string, credit: string, amount: bigint): PostJournalRequest {
  return {
    idempotencyKey: `snapshot-test:${RUN}:${n}`,
    referenceId: `snapshot-test:${RUN}`,
    kind: 'TEST_SNAPSHOT',
    description: 'ADR-029 integration test',
    currency: 'INR',
    lines: [
      { accountCode: debit, direction: D, amount: amount.toString() },
      { accountCode: credit, direction: C, amount: amount.toString() },
    ],
  };
}

const post = (request: PostJournalRequest): Promise<unknown> =>
  callUnary(client.postJournal.bind(client), request, { timeoutMs: TIMEOUT_MS });

/** A snapshot that is created now, or already covers every committed entry. */
async function snapshotNow(): Promise<SnapshotOutcome> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const outcome = await createSnapshot(db, { lockTimeoutMs: 1000 });
    if (outcome.result !== 'lock_timeout') return outcome;
  }
  throw new Error('no snapshot after 10 lock timeouts');
}

/** Runs `fn` in a transaction that is always rolled back; returns its error, if any. */
async function inRolledBackTransaction(fn: (c: PoolClient) => Promise<void>): Promise<Error | undefined> {
  const c = await db.connect();
  try {
    await c.query('BEGIN');
    await fn(c);
    return undefined;
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
}

describe('balance snapshots (section 19 item 5, ADR-029)', () => {
  it('snapshots taken while journals are posted concurrently match their entries exactly (I11)', async () => {
    // 600 journals, 64 at a time, between three accounts.
    const pairs: [string, string][] = [
      ['receivable:bank_a', 'transit'],
      ['transit', 'receivable:bank_a'],
      ['payable:bank_b', 'transit'],
    ];
    const journals = Array.from({ length: 600 }, (_, n) => {
      const [debit, credit] = pairs[n % pairs.length] ?? ['transit', 'transit'];
      return testJournal(n, debit, credit, BigInt(100 + (n % 97)));
    });

    const state = { posting: true };
    const outcomes: SnapshotOutcome[] = [];
    const snapshots = (async () => {
      while (state.posting) {
        // Back to back: the more rounds land while postings are in flight, the likelier a
        // missed in-flight entry would be (a mutant without the lock fails here too).
        outcomes.push(await createSnapshot(db, { lockTimeoutMs: 1000 }));
      }
    })();
    try {
      await mapLimit(journals, 64, post);
    } finally {
      state.posting = false;
      await snapshots;
    }
    outcomes.push(await snapshotNow());

    const added = outcomes.flatMap((o) => (o.result === 'created' ? [o.entriesAdded] : []));
    expect(added.length).toBeGreaterThanOrEqual(3);
    expect(added.some((n) => n > 0n)).toBe(true);

    const i11 = await checkI11({ ledger: reader, ledgerDb: db });
    expect(i11.problems).toEqual([]);
    expect(i11.ok).toBe(true);
  }, 120_000);

  it('GetBalance reads only the entries after the latest snapshot', async () => {
    await snapshotNow();
    for (let n = 0; n < 6; n++) await post(testJournal(10_000 + n, 'transit', 'payable:bank_a', 500n));

    // Count and plan in one REPEATABLE READ transaction, so both see the same entries.
    const c = await db.connect();
    try {
      await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const counts = await c.query<{ after: string; total: string }>(
        `SELECT count(*) FILTER (WHERE e.id > (SELECT max(last_entry_id) FROM balance_snapshots))::text AS after,
                count(*)::text AS total
           FROM entries e WHERE e.account_id = (SELECT id FROM accounts WHERE code = 'transit')`,
      );
      const plan = await c.query<{ 'QUERY PLAN': PlanRoot[] }>(`EXPLAIN (ANALYZE, FORMAT JSON) ${BALANCES_SQL}`, [
        'transit',
      ]);
      await c.query('COMMIT');
      const after = Number(counts.rows[0]?.after);
      const total = Number(counts.rows[0]?.total);
      const read = entriesRead(plan.rows[0]?.['QUERY PLAN'][0]?.Plan);
      expect(after).toBeGreaterThanOrEqual(6);
      expect(total).toBeGreaterThan(after);
      // Exactly the later entries: none of those the snapshot already covers.
      expect(read).toBe(after);
    } finally {
      c.release();
    }

    // And the answer is right: the RPC equals the raw sum over every entry.
    const raw = await db.query<{ balance: string }>(
      `SELECT (COALESCE(SUM(amount) FILTER (WHERE direction = 'C'), 0)
             - COALESCE(SUM(amount) FILTER (WHERE direction = 'D'), 0))::text AS balance
         FROM entries WHERE account_id = (SELECT id FROM accounts WHERE code = 'transit')`,
    );
    const viaRpc = await reader.getBalance('transit');
    const rawAfter = await db.query<{ balance: string }>(
      `SELECT (COALESCE(SUM(amount) FILTER (WHERE direction = 'C'), 0)
             - COALESCE(SUM(amount) FILTER (WHERE direction = 'D'), 0))::text AS balance
         FROM entries WHERE account_id = (SELECT id FROM accounts WHERE code = 'transit')`,
    );
    // Other stack traffic may post in between; compare only when the raw sum held still.
    if (raw.rows[0]?.balance === rawAfter.rows[0]?.balance) {
      expect(viaRpc).toBe(BigInt(raw.rows[0]?.balance ?? 'NaN'));
    }
  });

  it('snapshot rows are append-only: UPDATE, DELETE and TRUNCATE all fail', async () => {
    await snapshotNow();
    for (const sql of [
      'UPDATE balance_snapshots SET created_at = now() WHERE id = (SELECT max(id) FROM balance_snapshots)',
      'DELETE FROM balance_snapshots WHERE id = (SELECT max(id) FROM balance_snapshots)',
      'UPDATE balance_snapshot_lines SET debit_total = debit_total + 1 WHERE snapshot_id = (SELECT max(id) FROM balance_snapshots)',
      'DELETE FROM balance_snapshot_lines WHERE snapshot_id = (SELECT max(id) FROM balance_snapshots)',
      'TRUNCATE balance_snapshot_lines',
      'TRUNCATE balance_snapshots CASCADE',
    ]) {
      const err = await inRolledBackTransaction(async (c) => {
        await c.query(sql);
      });
      expect(err?.message, sql).toMatch(/append-only/);
    }
  });

  it('the database rejects a snapshot that does not balance, misses an account, or has no lines', async () => {
    // A last_entry_id no real snapshot will reach for a long time; every case rolls back.
    const fakeLast = '9000000000000000';
    const cases: { name: string; lines: (snapshotId: string) => string | null; error: RegExp }[] = [
      {
        name: 'unbalanced',
        lines: (id) =>
          `INSERT INTO balance_snapshot_lines (snapshot_id, account_id, debit_total, credit_total)
           SELECT ${id}, a.id, CASE WHEN a.code = 'transit' THEN 1 ELSE 0 END, 0 FROM accounts a`,
        error: /unbalanced/,
      },
      {
        name: 'missing an account',
        lines: (id) =>
          `INSERT INTO balance_snapshot_lines (snapshot_id, account_id, debit_total, credit_total)
           SELECT ${id}, a.id, 0, 0 FROM accounts a WHERE a.code <> 'transit'`,
        error: /lines for/,
      },
      { name: 'no lines', lines: () => null, error: /lines for/ },
    ];
    for (const k of cases) {
      const err = await inRolledBackTransaction(async (c) => {
        const r = await c.query<{ id: string }>(
          'INSERT INTO balance_snapshots (last_entry_id) VALUES ($1) RETURNING id::text',
          [fakeLast],
        );
        const sql = k.lines(r.rows[0]?.id ?? '0');
        if (sql !== null) await c.query(sql);
        await c.query('SET CONSTRAINTS ALL IMMEDIATE'); // what COMMIT would check
      });
      expect(err?.message, k.name).toMatch(k.error);
    }
    const leaked = await db.query('SELECT 1 FROM balance_snapshots WHERE last_entry_id = $1', [fakeLast]);
    expect(leaked.rowCount).toBe(0);
  });

  it('a snapshot never covers an uncommitted entry: it gives up after its lock timeout instead', async () => {
    const holder = await db.connect();
    try {
      // A posting transaction in flight: its entries have ids but are not committed.
      await holder.query('BEGIN');
      const j = await holder.query<{ id: string }>(
        `INSERT INTO journals (idempotency_key, request_hash, reference_id, kind, currency)
         VALUES ($1, 'test', $2, 'TEST_SNAPSHOT', 'INR') RETURNING id`,
        [`snapshot-test:${RUN}:in-flight`, `snapshot-test:${RUN}`],
      );
      await holder.query(
        `INSERT INTO entries (journal_id, account_id, direction, amount)
         SELECT $1, id, d, 700 FROM (VALUES ('transit', 'D'), ('payable:bank_b', 'C')) v(code, d)
           JOIN accounts USING (code)`,
        [j.rows[0]?.id],
      );

      const started = Date.now();
      const outcome = await createSnapshot(db, { lockTimeoutMs: 300 });
      const waited = Date.now() - started;
      expect(outcome.result).toBe('lock_timeout');
      expect(waited).toBeGreaterThanOrEqual(250);
      expect(waited).toBeLessThan(3000);
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
    // With the posting gone, the next round succeeds.
    expect(['created', 'up_to_date']).toContain((await snapshotNow()).result);
  });
});

interface PlanNode {
  'Node Type': string;
  'Relation Name'?: string;
  'Actual Rows'?: number;
  'Actual Loops'?: number;
  Plans?: PlanNode[];
}
interface PlanRoot {
  Plan: PlanNode;
}

/** Rows the plan read from `entries`, over every scan node and loop. */
function entriesRead(node: PlanNode | undefined): number {
  if (node === undefined) return 0;
  const own = node['Relation Name'] === 'entries' ? (node['Actual Rows'] ?? 0) * (node['Actual Loops'] ?? 1) : 0;
  return own + (node.Plans ?? []).reduce((sum, child) => sum + entriesRead(child), 0);
}
