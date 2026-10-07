/**
 * `npm run invariants`: checks I1–I6 (section 16) and I8 (the outbox, ADR-025) against the
 * live stack, for every transfer the Orchestrator knows, or only those created since
 * `--since <ISO time>`. I8 expects a quiet stack: every outbox event published. I9 (ADR-026)
 * expects the notification service to have recorded an outcome for each published event.
 * I10 (ADR-027) checks the reconciliation breaks already recorded for those transfers.
 *
 * There is no baseline here, so I2–I4 are evaluated per transfer: the bank operations and
 * journals carrying the in-scope transfer ids must add up (`checkScoped`). That is exact
 * even though the databases also hold traffic that never went through the Orchestrator
 * (the Ledger and Mock Bank integration tests call those services directly).
 *
 * Exit code 0 when every invariant holds, 1 otherwise.
 */
import { Pool } from 'pg';
import { BankAdmin } from '../tests/helpers/bankAdmin';
import {
  checkI1,
  checkI5,
  checkI6,
  checkI8,
  checkI9,
  checkI10,
  loadNotificationFacts,
  loadOpenBreakRefs,
  loadOutboxFacts,
  outboxCutoff,
  checkScoped,
  collectEvidence,
  formatResults,
  loadTransfers,
  type InvariantDeps,
} from '../tests/helpers/invariants';
import { LedgerReader } from '../tests/helpers/ledgerClient';

const ORCH_DB = process.env.ORCHESTRATOR_DATABASE_URL ?? 'postgres://orch:orch@localhost:5433/orchestrator_db';
const LEDGER_DB = process.env.LEDGER_DATABASE_URL ?? 'postgres://ledger:ledger@localhost:5434/ledger_db';
const RECON_DB =
  process.env.RECONCILIATION_DATABASE_URL ??
  'postgres://reconciliation:reconciliation@localhost:5437/reconciliation_db';
const NOTIFY_DB =
  process.env.NOTIFICATION_DATABASE_URL ?? 'postgres://notification:notification@localhost:5436/notification_db';
const BANK_DBS = {
  bank_a: process.env.BANK_A_DATABASE_URL ?? 'postgres://banks:banks@localhost:5435/bank_a',
  bank_b: process.env.BANK_B_DATABASE_URL ?? 'postgres://banks:banks@localhost:5435/bank_b',
};

function parseSince(argv: string[]): Date | undefined {
  const i = argv.indexOf('--since');
  if (i === -1) return undefined;
  const value = argv[i + 1];
  const date = value === undefined ? new Date(NaN) : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`--since needs an ISO timestamp, got ${String(value)}`);
  return date;
}

async function main(): Promise<number> {
  const since = parseSince(process.argv.slice(2));
  const deps: InvariantDeps = {
    banks: new BankAdmin(),
    ledger: new LedgerReader(),
    orchDb: new Pool({ connectionString: ORCH_DB, max: 2 }),
    ledgerDb: new Pool({ connectionString: LEDGER_DB, max: 2 }),
    concurrency: 32,
  };
  try {
    const transfers = await loadTransfers(deps.orchDb, since === undefined ? {} : { since });
    process.stdout.write(
      `checking ${transfers.length} transfers${since === undefined ? '' : ` created since ${since.toISOString()}`}\n`,
    );
    const evidence = await collectEvidence(deps, transfers);
    const [i2, i3, i4] = checkScoped(evidence);

    // I2 also requires that no balance anywhere is negative.
    const negatives: string[] = [];
    for (const [bank, url] of Object.entries(BANK_DBS)) {
      const pool = new Pool({ connectionString: url, max: 1 });
      try {
        const r = await pool.query<{ account_id: string; balance: string }>(
          'SELECT account_id, balance::text FROM accounts WHERE balance < 0',
        );
        negatives.push(...r.rows.map((row) => `${bank}/${row.account_id} is negative: ${row.balance}`));
      } finally {
        await pool.end();
      }
    }
    if (i2 !== undefined && negatives.length > 0) {
      i2.problems.push(...negatives);
      i2.problemCount += negatives.length;
      i2.ok = false;
    }

    // I8 (ADR-025): a quiet stack has every outbox event published.
    const i8 = checkI8(
      await loadOutboxFacts(
        deps.orchDb,
        transfers.map((t) => t.id),
      ),
      await outboxCutoff(deps.orchDb),
      true,
    );
    // I9 (ADR-026): every published event has exactly one outcome in notification_db.
    const notifyDb = new Pool({ connectionString: NOTIFY_DB, max: 1 });
    let i9;
    try {
      i9 = checkI9(
        await loadNotificationFacts(
          deps.orchDb,
          notifyDb,
          transfers.map((t) => t.id),
        ),
      );
    } finally {
      await notifyDb.end();
    }
    // I10 (ADR-027): no OPEN reconciliation break names an in-scope transfer. Read-only: it
    // checks the breaks the scheduled (or an on-demand) run already recorded.
    const reconDb = new Pool({ connectionString: RECON_DB, max: 1 });
    let i10;
    try {
      i10 = checkI10(transfers, await loadOpenBreakRefs(reconDb));
    } finally {
      await reconDb.end();
    }
    const results = [await checkI1(deps), i2, i3, i4, checkI5(evidence), checkI6(transfers), i8, i9, i10].filter(
      (r) => r !== undefined,
    );
    process.stdout.write(`${formatResults(results)}\n`);
    const ok = results.every((r) => r.ok);
    process.stdout.write(ok ? 'all invariants hold\n' : 'INVARIANTS VIOLATED\n');
    return ok ? 0 : 1;
  } finally {
    deps.banks.close();
    deps.ledger.close();
    await deps.orchDb.end();
    await deps.ledgerDb.end();
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    process.stderr.write(
      `invariant check failed to run: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
    );
    process.exitCode = 2;
  },
);
