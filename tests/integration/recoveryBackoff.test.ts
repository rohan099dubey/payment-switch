/**
 * ADR-031: an unexpected error during a recovery drive yields with backoff.
 *
 * Reproduces the dev-stack incident of 2026-10-08 (transfer 4bad8053): a transfer in
 * CREDITED whose outbox row already exists, so every terminal write fails with a
 * duplicate key on `outbox_one_event_per_transfer`. Before ADR-031 recovery released the
 * lease and retried on every poll, with `attempts` stuck at 0.
 *
 * Isolation: this file plants a conflicting outbox row, which must never reach a real
 * database. It creates its own scratch database on the orchestrator's Postgres server,
 * applies the real migrations, and drops it afterwards. The live recovery worker never
 * sees it, and `orchestrator_db` is never written. Run it on a throwaway Compose
 * project (ADR-023), not on the shared development stack.
 */
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { backoffMs, createLogger, runMigrations } from '@switch/common';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SagaPolicy } from '../../services/orchestrator/src/domain/policy';
import { SagaEngine, type BankPort, type LedgerPort } from '../../services/orchestrator/src/domain/saga';
import { TransferState } from '../../services/orchestrator/src/domain/states';
import type { Transfer } from '../../services/orchestrator/src/domain/transfer';
import {
  casTransition,
  createRecoveryStore,
  createTransferStore,
  getTransfer,
  insertTransfer,
} from '../../services/orchestrator/src/repo/transfersRepo';
import { RecoveryWorker, type RecoveryResult } from '../../services/orchestrator/src/recovery/worker';

const ORCH_DB = process.env.ORCHESTRATOR_DATABASE_URL ?? 'postgres://orch:orch@localhost:5433/orchestrator_db';
const SCRATCH_DB = `orch_backoff_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
const MIGRATIONS = path.resolve(__dirname, '../../services/orchestrator/migrations');
const LEASE_MS = 15_000;
const MAX_RECOVERY_ATTEMPTS = 20;
const S = TransferState;
const logger = createLogger('recovery-backoff-test', { level: 'silent' });

let admin: Pool;
let pool: Pool;

function scratchUrl(): string {
  const url = new URL(ORCH_DB);
  url.pathname = `/${SCRATCH_DB}`;
  return url.toString();
}

beforeAll(async () => {
  admin = new Pool({ connectionString: ORCH_DB, max: 1 });
  await admin.query(`CREATE DATABASE ${SCRATCH_DB}`);
  pool = new Pool({ connectionString: scratchUrl(), max: 10 });
  await runMigrations(pool, MIGRATIONS, logger);
});

afterAll(async () => {
  await pool.end();
  await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
  await admin.end();
});

/** The section 6 backoff without jitter, so the scheduled delay can be asserted exactly. */
const recoveryBackoffMs = (attempts: number): number => backoffMs(attempts, () => 0);

const policy: SagaPolicy = {
  bankCallTimeoutMs: 2000,
  ledgerCallTimeoutMs: 2000,
  bankAttempts: 3,
  ledgerAttempts: 3,
  retryBaseMs: 100,
  retryMaxMs: 800,
  minAttemptMs: 100,
  inlineBudgetMs: 8000,
  leaseMs: LEASE_MS,
  recoveryBackoffMs,
};

// CREDITED -> SUCCESS calls nobody. Any downstream call here is a bug in the test or the saga.
const notCalled = (name: string) => (): Promise<never> => Promise.reject(new Error(`${name} must not be called`));
const bank: BankPort = {
  debit: notCalled('Debit'),
  credit: notCalled('Credit'),
  reverseDebit: notCalled('ReverseDebit'),
  resolve: notCalled('Resolve'),
};
const ledger: LedgerPort = { postLeg: notCalled('PostJournal') };

function newWorker(): RecoveryWorker {
  return new RecoveryWorker({
    store: createRecoveryStore(pool),
    saga: new SagaEngine({
      store: createTransferStore(pool),
      bank,
      ledger,
      policy,
      clock: { now: () => Date.now() },
      logger,
      observer: { downstreamCall: () => undefined, stepDuration: () => undefined, terminal: () => undefined },
    }),
    config: {
      pollMs: 1000,
      batch: 20,
      concurrency: 5,
      leaseMs: LEASE_MS,
      resolveAfterAttempts: 3,
      maxRecoveryAttempts: MAX_RECOVERY_ATTEMPTS,
    },
    instanceId: 'recovery-backoff-test',
    logger,
    observer: { run: () => undefined, inFlight: () => undefined },
  });
}

/** A transfer walked to CREDITED through the real CAS (one event per step), lease free, due now. */
async function creditedTransfer(): Promise<Transfer> {
  const owner = `setup:${randomUUID()}`;
  const outcome = await insertTransfer(
    pool,
    {
      clientId: 'recovery-backoff',
      idempotencyKey: randomUUID(),
      requestHash: 'h'.repeat(64),
      payer: { bankId: 'bank_a', accountId: 'A1' },
      payee: { bankId: 'bank_b', accountId: 'B1' },
      amount: 12_500n,
      currency: 'INR',
      note: null,
    },
    owner,
    LEASE_MS,
  );
  if (outcome.status !== 'created') throw new Error('expected a new transfer');
  let t = outcome.transfer;
  for (const to of [S.DEBIT_SENT, S.DEBITED, S.CREDIT_SENT, S.CREDITED]) {
    const next = await casTransition(pool, {
      transferId: t.id,
      fromState: t.state,
      fromVersion: t.version,
      toState: to,
      leaseOwner: owner,
      leaseMs: LEASE_MS,
      terminal: false,
      failureCode: null,
      failureMessage: null,
      reason: 'TEST_SETUP',
      detail: {},
    });
    if (next === null) throw new Error(`setup CAS to ${to} failed`);
    t = next;
  }
  // As a crash would leave it: lease expired, due for recovery.
  await pool.query('UPDATE transfers SET lease_owner = NULL, lease_expires_at = NULL WHERE id = $1', [t.id]);
  return t;
}

/** The test artefact from the incident: an outbox row for a transfer that is not terminal yet. */
async function plantOutboxRow(transferId: string): Promise<void> {
  await pool.query(
    `INSERT INTO outbox (aggregate_id, event_type, payload, published_at) VALUES ($1, 'transfer.failed', '{}', now())`,
    [transferId],
  );
}

interface Row {
  state: string;
  version: number;
  attempts: number;
  lease_owner: string | null;
  failure_code: string | null;
  /** next_attempt_at - updated_at: exactly the backoff `yieldTransfer` scheduled. */
  scheduled_ms: number;
  due: boolean;
}

async function row(id: string): Promise<Row> {
  const result = await pool.query<Row>(
    `SELECT state, version, attempts, lease_owner, failure_code,
            round(extract(epoch FROM next_attempt_at - updated_at) * 1000)::int AS scheduled_ms,
            next_attempt_at <= now() AS due
       FROM transfers WHERE id = $1`,
    [id],
  );
  const r = result.rows[0];
  if (r === undefined) throw new Error(`no transfer ${id}`);
  return r;
}

const count = async (sql: string, id: string): Promise<number> =>
  (await pool.query<{ n: number }>(sql, [id])).rows[0]?.n ?? -1;
const eventCount = (id: string): Promise<number> =>
  count('SELECT count(*)::int AS n FROM transfer_events WHERE transfer_id = $1', id);
const outboxCount = (id: string): Promise<number> =>
  count('SELECT count(*)::int AS n FROM outbox WHERE aggregate_id = $1', id);

/** Time passing, as far as the claim query is concerned. Only ever on the scratch database. */
async function makeDue(id: string): Promise<void> {
  await pool.query('UPDATE transfers SET next_attempt_at = now() WHERE id = $1', [id]);
}

describe('recovery backs off when a transition keeps failing (ADR-031)', () => {
  it('a conflicting outbox row: each attempt yields with the section 6 backoff, never a hot loop', async () => {
    const t = await creditedTransfer();
    await plantOutboxRow(t.id);
    const events = await eventCount(t.id);
    const worker = newWorker();

    // First attempt: the SUCCESS write fails on the outbox constraint, and the saga yields.
    expect(await worker.runOnce()).toEqual<RecoveryResult[]>(['yielded']);
    expect(await row(t.id)).toMatchObject({
      state: S.CREDITED,
      version: t.version,
      attempts: 1,
      lease_owner: null,
      scheduled_ms: recoveryBackoffMs(1),
      due: false,
    });

    // The next polls find nothing due: this was the hot loop.
    for (let poll = 0; poll < 3; poll++) expect(await worker.runOnce()).toEqual([]);
    expect((await row(t.id)).attempts).toBe(1);

    // Every later attempt yields again with the next, longer backoff (capped at 60 s).
    for (let attempt = 2; attempt <= MAX_RECOVERY_ATTEMPTS; attempt++) {
      await makeDue(t.id);
      expect(await worker.runOnce()).toEqual<RecoveryResult[]>(['yielded']);
      expect(await row(t.id)).toMatchObject({
        state: S.CREDITED,
        attempts: attempt,
        lease_owner: null,
        scheduled_ms: recoveryBackoffMs(attempt),
      });
    }
    expect(recoveryBackoffMs(MAX_RECOVERY_ATTEMPTS)).toBe(60_000);

    // At MAX_RECOVERY_ATTEMPTS recovery escalates, but NEEDS_MANUAL_REVIEW writes an outbox
    // event too (ADR-025), so the same row refuses it: the escalation backs off as well.
    await makeDue(t.id);
    expect(await worker.runOnce()).toEqual<RecoveryResult[]>(['yielded']);
    expect(await row(t.id)).toMatchObject({
      state: S.CREDITED,
      version: t.version,
      attempts: MAX_RECOVERY_ATTEMPTS + 1,
      lease_owner: null,
      failure_code: null,
      scheduled_ms: 60_000,
    });

    // Nothing was written but the yields: no event, no second outbox row, the planted row intact.
    expect(await eventCount(t.id)).toBe(events);
    expect(await outboxCount(t.id)).toBe(1);
    const planted = await pool.query<{ event_type: string; payload: unknown }>(
      'SELECT event_type, payload FROM outbox WHERE aggregate_id = $1',
      [t.id],
    );
    expect(planted.rows).toEqual([{ event_type: 'transfer.failed', payload: {} }]);
  });

  it('when the write stops failing, the next attempt finishes it: SUCCESS, one event, one outbox row', async () => {
    const t = await creditedTransfer();
    await plantOutboxRow(t.id);
    const worker = newWorker();
    expect(await worker.runOnce()).toEqual<RecoveryResult[]>(['yielded']);
    expect(await worker.runOnce()).toEqual([]);
    expect((await row(t.id)).attempts).toBe(1);

    // The conflict is removed (here, on the scratch database only).
    await pool.query('DELETE FROM outbox WHERE aggregate_id = $1', [t.id]);
    await makeDue(t.id);
    expect(await worker.runOnce()).toEqual<RecoveryResult[]>(['advanced']);

    const done = await getTransfer(pool, t.id);
    expect(done).toMatchObject({ state: S.SUCCESS, attempts: 0, leaseOwner: null, version: t.version + 1 });
    const last = await pool.query<{ from_state: string; to_state: string; reason: string }>(
      'SELECT from_state, to_state, reason FROM transfer_events WHERE transfer_id = $1 ORDER BY id DESC LIMIT 1',
      [t.id],
    );
    expect(last.rows).toEqual([{ from_state: S.CREDITED, to_state: S.SUCCESS, reason: 'TRANSFER_COMPLETED' }]);
    const outbox = await pool.query<{ event_type: string }>('SELECT event_type FROM outbox WHERE aggregate_id = $1', [
      t.id,
    ]);
    expect(outbox.rows).toEqual([{ event_type: 'transfer.succeeded' }]);
  });
});
