/**
 * M6 acceptance, section 16 `failurePaths`: the recovery worker finishes what the inline
 * saga could not, against the real stack. Each scenario ends in a terminal state with
 * exactly-once effects, checked at the bank, in the Ledger and in `transfer_events`.
 *
 * Several tests wait out real backoffs (2, 4, 8 s) and the RESOLVE_AFTER_ATTEMPTS
 * threshold, so they have long timeouts. They stop and start Compose services and a
 * second Orchestrator process, and always restore them.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { sleep } from '@switch/common';
import type { ChaosConfig } from '@switch/proto-gen/bank/v1';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { BankAdmin, type BankId } from '../helpers/bankAdmin';
import { DEV_CLIENTS, GatewayClient, type HttpResult } from '../helpers/gatewayClient';
import { compose, startService, stopService, waitFor } from '../helpers/stack';

const ORCH_DB = process.env.ORCHESTRATOR_DATABASE_URL ?? 'postgres://orch:orch@localhost:5433/orchestrator_db';
const BANK_A_DB = process.env.BANK_A_DATABASE_URL ?? 'postgres://banks:banks@localhost:5435/bank_a';
const LEDGER_DB = process.env.LEDGER_DATABASE_URL ?? 'postgres://ledger:ledger@localhost:5434/ledger_db';
const BANK_A_HTTP = process.env.BANK_A_HTTP_URL ?? 'http://localhost:9111';

const RUN = randomUUID().slice(0, 8);
let counter = 0;
const uniqueId = (prefix: string): string => `m6-${RUN}-${prefix}-${++counter}`;
const client = GatewayClient.for(DEV_CLIENTS.a);

let banks: BankAdmin;
let orchDb: Pool;
let bankADb: Pool;
let ledgerDb: Pool;
const startupChaos: Partial<Record<BankId, ChaosConfig>> = {};

beforeAll(async () => {
  banks = new BankAdmin();
  orchDb = new Pool({ connectionString: ORCH_DB, max: 3 });
  bankADb = new Pool({ connectionString: BANK_A_DB, max: 2 });
  ledgerDb = new Pool({ connectionString: LEDGER_DB, max: 2 });
  startupChaos.bank_a = await banks.getChaos('bank_a');
  startupChaos.bank_b = await banks.getChaos('bank_b');
  await client.accessToken();
});

afterEach(async () => {
  for (const bank of ['bank_a', 'bank_b'] as const) {
    const config = startupChaos[bank];
    if (config !== undefined) await banks.setChaos(bank, config);
  }
});

afterAll(async () => {
  banks.close();
  await orchDb.end();
  await bankADb.end();
  await ledgerDb.end();
});

// ---------------------------------------------------------------- helpers

async function accounts(payerBalance: bigint): Promise<{ payer: string; payee: string }> {
  const payer = uniqueId('payer');
  const payee = uniqueId('payee');
  await banks.createAccount('bank_a', payer, payerBalance);
  await banks.createAccount('bank_b', payee, 0n);
  return { payer, payee };
}

function body(payer: string, payee: string, amount = 1000): Record<string, unknown> {
  return {
    payer: { bank_id: 'bank_a', account_id: payer },
    payee: { bank_id: 'bank_b', account_id: payee },
    amount,
    currency: 'INR',
  };
}

async function chaos(bank: BankId, change: Partial<ChaosConfig>): Promise<void> {
  const base = startupChaos[bank];
  if (base === undefined) throw new Error('startup chaos not captured');
  await banks.setChaos(bank, { ...base, ...change });
}

const idOf = (res: HttpResult): string => res.body.id as string;

/** Polls GET /v1/transfers/{id} until the transfer is no longer PENDING. */
async function awaitFinal(id: string, timeoutMs: number): Promise<HttpResult> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const res = await client.getTransfer(id);
    if (res.status === 200 && res.body.status !== 'PENDING') return res;
    if (Date.now() >= until) throw new Error(`transfer ${id} still ${String(res.body.state)} after ${timeoutMs} ms`);
    await sleep(500);
  }
}

async function bankOps(transferId: string): Promise<Record<string, string>> {
  const r = await bankADb.query<{ operation: string; status: string }>(
    'SELECT operation, status FROM operations WHERE reference_id = $1',
    [transferId],
  );
  return Object.fromEntries(r.rows.map((row) => [row.operation, row.status]));
}

async function journalKinds(transferId: string): Promise<string[]> {
  const r = await ledgerDb.query<{ kind: string }>(
    'SELECT kind FROM journals WHERE reference_id = $1 ORDER BY created_at',
    [transferId],
  );
  return r.rows.map((row) => row.kind);
}

interface EventRow {
  to_state: string;
  reason: string;
  detail: { driver?: string; lease_owner?: string; request_id?: string };
  created_at: Date;
}
async function events(transferId: string): Promise<EventRow[]> {
  const r = await orchDb.query<EventRow>(
    'SELECT to_state, reason, detail, created_at FROM transfer_events WHERE transfer_id = $1 ORDER BY id',
    [transferId],
  );
  return r.rows;
}

/** Waits until no transfer is in flight, so a global counter only sees this test's traffic. */
async function quiesce(): Promise<void> {
  await waitFor(
    'no transfer in flight',
    async () => {
      const r = await orchDb.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM transfers WHERE state NOT IN ('SUCCESS','FAILED','REVERSED','NEEDS_MANUAL_REVIEW')",
      );
      return r.rows[0]?.n === 0;
    },
    90_000,
  );
}

/** One series of `bank_operations_total` on bank_a. */
async function bankACounter(operation: string, result: string): Promise<number> {
  const text = await (await fetch(`${BANK_A_HTTP}/metrics`)).text();
  const line = text
    .split('\n')
    .find(
      (l) =>
        l.startsWith('bank_operations_total{') &&
        l.includes(`operation="${operation}"`) &&
        l.includes(`result="${result}"`),
    );
  return line === undefined ? 0 : Number(line.split(' ').at(-1));
}

// ---------------------------------------------------------------- tests

describe('failurePaths — definite failures still end where they should', () => {
  it('insufficient funds gives FAILED', async () => {
    const { payer, payee } = await accounts(10n);
    const res = await client.createTransfer(body(payer, payee), uniqueId('key'));
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ state: 'FAILED', failure_code: 'INSUFFICIENT_FUNDS' });
  });

  it('a missing payee gives REVERSED with the payer refunded', async () => {
    const payer = uniqueId('payer');
    await banks.createAccount('bank_a', payer, 5000n);
    const res = await client.createTransfer(body(payer, uniqueId('nobody')), uniqueId('key'));
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ state: 'REVERSED', failure_code: 'PAYEE_ACCOUNT_NOT_FOUND' });
    expect(await banks.balance('bank_a', payer)).toBe(5000n);
    expect(await journalKinds(idOf(res))).toEqual(['TRANSFER_DEBIT_LEG', 'TRANSFER_REVERSAL']);
  });
});

describe('failurePaths — recovery', () => {
  it('a payer bank down for a few seconds still reaches SUCCESS once it returns', { timeout: 60_000 }, async () => {
    const { payer, payee } = await accounts(10_000n);
    await chaos('bank_a', { down: true });
    const res = await client.createTransfer(body(payer, payee), uniqueId('key'));
    expect(res.status).toBe(202);
    await sleep(3000);
    await chaos('bank_a', { down: false });

    const final = await awaitFinal(idOf(res), 45_000);
    expect(final.body).toMatchObject({ status: 'SUCCEEDED', state: 'SUCCESS' });
    expect(await bankOps(idOf(res))).toEqual({ DEBIT: 'APPLIED' });
    expect(await banks.balance('bank_a', payer)).toBe(9000n);
    expect(await banks.balance('bank_b', payee)).toBe(1000n);
    const trail = await events(idOf(res));
    expect(trail.some((e) => e.detail.driver === 'recovery')).toBe(true);
  });

  it(
    'the Ledger stopped then restarted leaves transfers pending, then they complete',
    { timeout: 150_000 },
    async () => {
      const created: { id: string; payer: string; payee: string }[] = [];
      await stopService('ledger');
      try {
        for (let i = 0; i < 3; i++) {
          const { payer, payee } = await accounts(10_000n);
          const res = await client.createTransfer(body(payer, payee), uniqueId('key'));
          expect(res.status).toBe(202);
          expect(res.body).toMatchObject({ status: 'PENDING', state: 'DEBIT_SENT' });
          created.push({ id: idOf(res), payer, payee });
        }
        // Pending: the bank debit happened, the ledger leg could not be posted.
        for (const t of created) {
          expect(await bankOps(t.id)).toEqual({ DEBIT: 'APPLIED' });
          expect((await client.getTransfer(t.id)).body.status).toBe('PENDING');
        }
      } finally {
        await startService('ledger');
      }
      for (const t of created) {
        const final = await awaitFinal(t.id, 120_000);
        expect(final.body).toMatchObject({ status: 'SUCCEEDED', state: 'SUCCESS' });
        expect(await bankOps(t.id)).toEqual({ DEBIT: 'APPLIED' });
        expect(await banks.balance('bank_a', t.payer)).toBe(9000n);
        expect(await banks.balance('bank_b', t.payee)).toBe(1000n);
        expect(await journalKinds(t.id)).toEqual(['TRANSFER_DEBIT_LEG', 'TRANSFER_CREDIT_LEG']);
      }
    },
  );

  it(
    'lost_response_rate = 1 still ends in SUCCESS with exactly one debit (Resolve -> APPLIED)',
    { timeout: 120_000 },
    async () => {
      const { payer, payee } = await accounts(10_000n);
      // Every Debit applies at once but its answer is held past the 2 s call timeout.
      await chaos('bank_a', { lostResponseRate: 1, slowMs: 2500 });
      const res = await client.createTransfer(body(payer, payee), uniqueId('key'));
      expect(res.status).toBe(202);

      const final = await awaitFinal(idOf(res), 100_000);
      expect(final.body).toMatchObject({ status: 'SUCCEEDED', state: 'SUCCESS' });
      expect(await bankOps(idOf(res))).toEqual({ DEBIT: 'APPLIED' });
      expect(await banks.balance('bank_a', payer)).toBe(9000n);
      expect(await banks.balance('bank_b', payee)).toBe(1000n);
      expect(await journalKinds(idOf(res))).toEqual(['TRANSFER_DEBIT_LEG', 'TRANSFER_CREDIT_LEG']);
      expect((await events(idOf(res))).map((e) => e.reason)).toContain('DEBIT_CONFIRMED_BY_RESOLVE');
    },
  );

  it('late_apply_rate = 1 never leaves a transfer applied after being voided', { timeout: 240_000 }, async () => {
    await quiesce();
    const { payer, payee } = await accounts(10_000n);
    // Every Debit is held 45 s before the bank applies it: far longer than it takes recovery
    // to reach RESOLVE_AFTER_ATTEMPTS (~35 s), so Resolve's tombstone lands first.
    await chaos('bank_a', { lateApplyRate: 1, slowMs: 45_000 });
    const voidedBefore = await bankACounter('DEBIT', 'REFERENCE_VOIDED');
    const res = await client.createTransfer(body(payer, payee), uniqueId('key'));
    expect(res.status).toBe(202);

    const final = await awaitFinal(idOf(res), 70_000);
    expect(final.body).toMatchObject({ status: 'FAILED', state: 'FAILED', failure_code: 'DEBIT_NOT_CONFIRMED' });
    expect(await bankOps(idOf(res))).toEqual({ DEBIT: 'VOIDED' });

    // Every Debit attempt (3 inline + 3 per recovery advance) eventually arrives late and
    // must hit the tombstone. Wait for all of them, then prove none applied.
    const attempts = 9;
    await waitFor(
      `${attempts} late debits refused with REFERENCE_VOIDED`,
      async () => (await bankACounter('DEBIT', 'REFERENCE_VOIDED')) - voidedBefore >= attempts,
      75_000,
    );
    expect((await bankACounter('DEBIT', 'REFERENCE_VOIDED')) - voidedBefore).toBe(attempts);
    expect(await bankOps(idOf(res))).toEqual({ DEBIT: 'VOIDED' });
    expect(await banks.balance('bank_a', payer)).toBe(10_000n);
    expect(await journalKinds(idOf(res))).toEqual([]);
    expect((await events(idOf(res))).map((e) => e.reason)).toContain('DEBIT_NOT_CONFIRMED');
  });

  it(
    'an Orchestrator killed mid-transfer is recovered by another instance after lease expiry',
    { timeout: 120_000 },
    async () => {
      const { payer, payee } = await accounts(10_000n);
      const second = startSecondOrchestrator();
      try {
        await waitFor(
          'second orchestrator ready',
          async () => (await fetch('http://localhost:9201/readyz')).ok,
          30_000,
        );
        // Slow banks, so the transfer is still mid-saga when the first instance dies.
        await chaos('bank_a', { latencyMinMs: 1500, latencyMaxMs: 1500 });
        await chaos('bank_b', { latencyMinMs: 1500, latencyMaxMs: 1500 });

        const key = uniqueId('key');
        const pending = client.createTransfer(body(payer, payee), key);
        let row: { id: string; state: string; lease_owner: string | null; lease_expires_at: Date | null } | undefined;
        await waitFor(
          'the transfer to be registered',
          async () => {
            const r = await orchDb.query<{
              id: string;
              state: string;
              lease_owner: string | null;
              lease_expires_at: Date | null;
            }>(
              'SELECT id, state, lease_owner, lease_expires_at FROM transfers WHERE client_id = $1 AND idempotency_key = $2',
              [DEV_CLIENTS.a.id, key],
            );
            row = r.rows[0];
            return row?.state === 'DEBIT_SENT';
          },
          10_000,
        );
        await compose('kill', 'orchestrator');
        const killed = await pending;
        expect([503, 504]).toContain(killed.status);
        if (row === undefined || row.lease_expires_at === null) throw new Error('no leased row');
        const leaseExpiry = row.lease_expires_at;

        // The first instance's lease must lapse before anyone else drives the transfer.
        const final = await waitForState(row.id, ['SUCCESS'], 60_000);
        expect(final).toBe('SUCCESS');
        const trail = await events(row.id);
        const recovered = trail.filter((e) => e.detail.driver === 'recovery');
        expect(recovered.length).toBeGreaterThan(0);
        for (const e of recovered) {
          expect(String(e.detail.lease_owner)).toMatch(/^orch-m6-second:recovery:/);
          expect(e.created_at.getTime()).toBeGreaterThanOrEqual(leaseExpiry.getTime());
        }
        expect(await bankOps(row.id)).toEqual({ DEBIT: 'APPLIED' });
        expect(await banks.balance('bank_a', payer)).toBe(9000n);
        expect(await banks.balance('bank_b', payee)).toBe(1000n);
        expect(await journalKinds(row.id)).toEqual(['TRANSFER_DEBIT_LEG', 'TRANSFER_CREDIT_LEG']);
      } finally {
        second.kill();
        await startService('orchestrator');
        await waitFor('gateway ready again', async () => (await fetch('http://localhost:8080/readyz')).ok, 60_000);
      }
    },
  );
});

describe('failurePaths — nothing is left behind', () => {
  it('no transfer from an earlier test run is still in flight', async () => {
    const r = await orchDb.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM transfers
        WHERE state NOT IN ('SUCCESS','FAILED','REVERSED','NEEDS_MANUAL_REVIEW')
          AND created_at < now() - interval '5 minutes'`,
    );
    expect(r.rows[0]?.n).toBe(0);
  });
});

// ---------------------------------------------------------------- second instance

async function waitForState(id: string, states: string[], timeoutMs: number): Promise<string> {
  let state = '';
  await waitFor(
    `transfer ${id} in ${states.join('/')}`,
    async () => {
      const r = await orchDb.query<{ state: string }>('SELECT state FROM transfers WHERE id = $1', [id]);
      state = r.rows[0]?.state ?? '';
      return states.includes(state);
    },
    timeoutMs,
  );
  return state;
}

/** A second Orchestrator process on spare ports, sharing the database and the banks. */
function startSecondOrchestrator(): ChildProcess {
  const main = path.resolve(__dirname, '../../services/orchestrator/dist/main.js');
  return spawn(process.execPath, [main], {
    env: {
      ...process.env,
      GRPC_PORT: '50151',
      HTTP_PORT: '9201',
      DATABASE_URL: ORCH_DB,
      BANK_ENDPOINTS: 'bank_a=localhost:50061,bank_b=localhost:50062',
      LEDGER_ADDR: 'localhost:50052',
      INSTANCE_ID: 'orch-m6-second',
      LOG_LEVEL: 'warn',
    },
    stdio: 'ignore',
  });
}
