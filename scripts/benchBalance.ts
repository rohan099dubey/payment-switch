/**
 * Phase 2, item 5 (ADR-029): how long the Ledger takes to answer `GetBalance` and
 * `GetTrialBalance` on the running stack. Sequential calls over gRPC from the host, after a
 * warm-up, so the figures are per-call latency with no queueing.
 *
 *   npm run bench:balance                 # 200 GetBalance('transit') + 50 GetTrialBalance
 *   npm run bench:balance -- --calls 500
 *
 * It also prints how many entries the ledger holds and how many lie after the latest
 * snapshot, because that count is what the read cost depends on.
 */
import { Pool } from 'pg';
import { LedgerReader } from '../tests/helpers/ledgerClient';

const LEDGER_DB = process.env.LEDGER_DATABASE_URL ?? 'postgres://ledger:ledger@localhost:5434/ledger_db';

function argNumber(name: string, fallback: number): number {
  const i = process.argv.indexOf(name);
  const value = i === -1 ? undefined : Number(process.argv[i + 1]);
  return value === undefined || !Number.isInteger(value) || value < 1 ? fallback : value;
}

function quantile(sorted: number[], q: number): number {
  const index = Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1);
  return sorted[Math.max(0, index)] ?? NaN;
}

async function time(label: string, calls: number, fn: () => Promise<unknown>): Promise<void> {
  for (let i = 0; i < 10; i++) await fn(); // warm-up: connections, plans, JIT
  const ms: number[] = [];
  for (let i = 0; i < calls; i++) {
    const start = process.hrtime.bigint();
    await fn();
    ms.push(Number(process.hrtime.bigint() - start) / 1e6);
  }
  ms.sort((a, b) => a - b);
  const f = (v: number): string => `${v.toFixed(2)} ms`;
  process.stdout.write(
    `${label}: ${calls} calls, p50 ${f(quantile(ms, 0.5))}, p95 ${f(quantile(ms, 0.95))}, p99 ${f(quantile(ms, 0.99))}, max ${f(ms[ms.length - 1] ?? NaN)}\n`,
  );
}

async function entryCounts(db: Pool): Promise<string> {
  const total = await db.query<{ n: string; transit: string }>(
    `SELECT count(*)::text AS n,
            count(*) FILTER (WHERE account_id = (SELECT id FROM accounts WHERE code = 'transit'))::text AS transit
       FROM entries`,
  );
  const hasSnapshots = await db.query<{ present: boolean }>(
    `SELECT to_regclass('balance_snapshots') IS NOT NULL AS present`,
  );
  let after = 'no snapshot table';
  if (hasSnapshots.rows[0]?.present === true) {
    const r = await db.query<{ n: string; last: string | null }>(
      `SELECT (SELECT max(last_entry_id) FROM balance_snapshots)::text AS last,
              count(*)::text AS n
         FROM entries WHERE id > coalesce((SELECT max(last_entry_id) FROM balance_snapshots), 0)`,
    );
    after = `${r.rows[0]?.n ?? '?'} after the latest snapshot (last_entry_id ${r.rows[0]?.last ?? 'none'})`;
  }
  return `entries: ${total.rows[0]?.n ?? '?'} (transit ${total.rows[0]?.transit ?? '?'}), ${after}`;
}

async function main(): Promise<void> {
  const balanceCalls = argNumber('--calls', 200);
  const trialCalls = Math.max(1, Math.round(balanceCalls / 4));
  const ledger = new LedgerReader();
  const db = new Pool({ connectionString: LEDGER_DB, max: 1 });
  try {
    process.stdout.write(`${await entryCounts(db)}\n`);
    await time("GetBalance('transit')", balanceCalls, () => ledger.getBalance('transit'));
    await time('GetTrialBalance', trialCalls, () => ledger.getTrialBalance());
    process.stdout.write(`${await entryCounts(db)}\n`);
  } finally {
    ledger.close();
    await db.end();
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
