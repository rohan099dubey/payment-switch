/**
 * M5 acceptance: idempotency (section 12) and unknown outcomes, through the public API
 * against the real stack. Concurrency is real: requests go over separate HTTP
 * connections, the race is arbitrated by the `transfers` unique index, and every
 * "exactly once" claim is checked at the bank, in `orchestrator_db` and in the
 * Orchestrator's own call counters.
 *
 * Chaos is set per test on the banks and always restored. Integration files run one at a
 * time, so the counters and the chaos PRNG see only this file's traffic.
 */
import { randomUUID } from 'node:crypto';
import { sleep } from '@switch/common';
import type { ChaosConfig } from '@switch/proto-gen/bank/v1';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mulberry32 } from '../../services/mockBank/src/chaos/prng';
import { BankAdmin, type BankId } from '../helpers/bankAdmin';
import { DEV_CLIENTS, GatewayClient, type HttpResult } from '../helpers/gatewayClient';

const ORCH_DB = process.env.ORCHESTRATOR_DATABASE_URL ?? 'postgres://orch:orch@localhost:5433/orchestrator_db';
const BANK_A_DB = process.env.BANK_A_DATABASE_URL ?? 'postgres://banks:banks@localhost:5435/bank_a';
const ORCH_HTTP = process.env.ORCHESTRATOR_HTTP_URL ?? 'http://localhost:9101';
/** Section 14 defaults, as configured in docker-compose.yml. */
const REPLAY_WAIT_MS = 2000;
const INLINE_BANK_ATTEMPTS = 3;

const RUN = randomUUID().slice(0, 8);
let counter = 0;
const uniqueId = (prefix: string): string => `m5-${RUN}-${prefix}-${++counter}`;

const client = GatewayClient.for(DEV_CLIENTS.a);
const otherClient = GatewayClient.for(DEV_CLIENTS.b);
let banks: BankAdmin;
let orchDb: Pool;
let bankADb: Pool;
const startupChaos: Partial<Record<BankId, ChaosConfig>> = {};

beforeAll(async () => {
  banks = new BankAdmin();
  orchDb = new Pool({ connectionString: ORCH_DB, max: 4 });
  bankADb = new Pool({ connectionString: BANK_A_DB, max: 2 });
  startupChaos.bank_a = await banks.getChaos('bank_a');
  startupChaos.bank_b = await banks.getChaos('bank_b');
  await client.accessToken();
  await otherClient.accessToken();
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
});

// ---------------------------------------------------------------- helpers

async function accounts(payerBalance: bigint): Promise<{ payer: string; payee: string }> {
  const payer = uniqueId('payer');
  const payee = uniqueId('payee');
  await banks.createAccount('bank_a', payer, payerBalance);
  await banks.createAccount('bank_b', payee, 0n);
  return { payer, payee };
}

function body(payer: string, payee: string, amount = 1000, note?: string): Record<string, unknown> {
  return {
    payer: { bank_id: 'bank_a', account_id: payer },
    payee: { bank_id: 'bank_b', account_id: payee },
    amount,
    currency: 'INR',
    ...(note === undefined ? {} : { note }),
  };
}

async function chaos(bank: BankId, change: Partial<ChaosConfig>): Promise<void> {
  const base = startupChaos[bank];
  if (base === undefined) throw new Error('startup chaos not captured');
  await banks.setChaos(bank, { ...base, ...change });
}

/** Sum of one series of `downstream_calls_total` on the Orchestrator. */
async function downstreamCalls(operation: string, outcome: string): Promise<number> {
  const text = await (await fetch(`${ORCH_HTTP}/metrics`)).text();
  const prefix = `downstream_calls_total{target="${operation === 'PostJournal' ? 'ledger' : 'bank'}",operation="${operation}",outcome="${outcome}"} `;
  const line = text.split('\n').find((l) => l.startsWith(prefix));
  return line === undefined ? 0 : Number(line.slice(prefix.length));
}

async function transfersForKey(clientId: string, key: string): Promise<number> {
  const r = await orchDb.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM transfers WHERE client_id = $1 AND idempotency_key = $2',
    [clientId, key],
  );
  return r.rows[0]?.n ?? -1;
}

async function debitRows(transferId: string): Promise<number> {
  const r = await bankADb.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM operations WHERE reference_id = $1 AND operation = 'DEBIT' AND status = 'APPLIED'",
    [transferId],
  );
  return r.rows[0]?.n ?? -1;
}

interface EventRow {
  to_state: string;
  detail: { request_id?: string };
}
async function events(transferId: string): Promise<EventRow[]> {
  const r = await orchDb.query<EventRow>(
    'SELECT to_state, detail FROM transfer_events WHERE transfer_id = $1 ORDER BY id',
    [transferId],
  );
  return r.rows;
}

const idOf = (res: HttpResult): string => res.body.id as string;
const isReplay = (res: HttpResult): boolean => res.headers.get('idempotent-replay') === 'true';

async function timed<T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const started = Date.now();
  const value = await fn();
  return { value, ms: Date.now() - started };
}

// ---------------------------------------------------------------- tests

describe('fingerprint (section 12 rule 2)', () => {
  it('a replay returns the same id with Idempotent-Replay: true', async () => {
    const { payer, payee } = await accounts(10_000n);
    const key = uniqueId('key');
    const first = await client.createTransfer(body(payer, payee), key);
    const again = await client.createTransfer(body(payer, payee), key);
    expect([first.status, again.status]).toEqual([201, 200]);
    expect(isReplay(first)).toBe(false);
    expect(isReplay(again)).toBe(true);
    expect(idOf(again)).toBe(idOf(first));
  });

  it.each([
    ['amount', (p: string, q: string) => body(p, q, 1001)],
    ['note', (p: string, q: string) => body(p, q, 1000, 'different')],
    ['payee account', (p: string) => body(p, uniqueId('other-payee'))],
  ])(
    'a different %s with the same key is 409 IDEMPOTENCY_KEY_REUSED and never touches the transfer',
    async (_name, changed) => {
      const { payer, payee } = await accounts(10_000n);
      const key = uniqueId('key');
      const first = await client.createTransfer(body(payer, payee), key);
      const eventsBefore = (await events(idOf(first))).length;

      const reused = await client.createTransfer(changed(payer, payee), key);
      expect(reused.status).toBe(409);
      expect(reused.body).toMatchObject({ error: { code: 'IDEMPOTENCY_KEY_REUSED' } });
      expect(await events(idOf(first))).toHaveLength(eventsBefore);
      expect(await banks.balance('bank_a', payer)).toBe(9_000n);
    },
  );

  it('an absent note and an empty note are the same fingerprint (note ?? "")', async () => {
    const { payer, payee } = await accounts(10_000n);
    const key = uniqueId('key');
    await client.createTransfer(body(payer, payee), key);
    const again = await client.createTransfer(body(payer, payee, 1000, ''), key);
    expect(again.status).toBe(200);
    expect(isReplay(again)).toBe(true);
  });

  it('two clients using the same key string do not collide (rule 1)', async () => {
    const { payer, payee } = await accounts(10_000n);
    const key = uniqueId('shared-key');
    const a = await client.createTransfer(body(payer, payee), key);
    const b = await otherClient.createTransfer(body(payer, payee, 2000), key);
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(idOf(a)).not.toBe(idOf(b));
    expect(await banks.balance('bank_a', payer)).toBe(7_000n);
  });
});

describe('concurrent duplicates (section 12 rule 4)', () => {
  it('50 concurrent identical requests: exactly one transfer, one saga, one bank debit', async () => {
    const { payer, payee } = await accounts(100_000n);
    const key = uniqueId('key');
    // Warm separate connections first so the 50 requests really arrive together.
    await Promise.all(
      Array.from({ length: 50 }, () => fetch(`${process.env.GATEWAY_URL ?? 'http://localhost:8080'}/healthz`)),
    );
    const debitsBefore = await downstreamCalls('Debit', 'ok');

    const results = await Promise.all(
      Array.from({ length: 50 }, () => client.createTransfer(body(payer, payee, 2500), key)),
    );

    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 200)).toHaveLength(49);
    expect(results.filter((r) => !isReplay(r))).toHaveLength(1);
    const ids = new Set(results.map(idOf));
    expect(ids.size).toBe(1);
    const [id] = [...ids];
    if (id === undefined) throw new Error('no transfer id');

    expect(await transfersForKey(DEV_CLIENTS.a.id, key)).toBe(1);
    expect(await debitRows(id)).toBe(1);
    expect(await banks.balance('bank_a', payer)).toBe(97_500n);
    expect(await banks.balance('bank_b', payee)).toBe(2_500n);
    // One saga: the Orchestrator made exactly one successful Debit call for all 50 requests.
    expect((await downstreamCalls('Debit', 'ok')) - debitsBefore).toBe(1);
    // One drive: a single, linear event trail.
    expect((await events(id)).map((e) => e.to_state)).toEqual([
      'INITIATED',
      'DEBIT_SENT',
      'DEBITED',
      'CREDIT_SENT',
      'CREDITED',
      'SUCCESS',
    ]);
  });

  it('10 concurrent requests with one key but different amounts: one transfer, nine 409s', async () => {
    const { payer, payee } = await accounts(100_000n);
    const key = uniqueId('key');
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => client.createTransfer(body(payer, payee, 1000 + i), key)),
    );
    const created = results.filter((r) => r.status === 201);
    expect(created).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(9);
    const winner = created[0];
    if (winner === undefined) throw new Error('no winner');
    expect(await transfersForKey(DEV_CLIENTS.a.id, key)).toBe(1);
    expect(await banks.balance('bank_a', payer)).toBe(100_000n - BigInt(winner.body.amount as number));
  });
});

describe('a replay while the first request is still running (rules 3 and 4)', () => {
  it('waits for the original and returns its terminal state as soon as it lands', async () => {
    const { payer, payee } = await accounts(10_000n);
    const key = uniqueId('key');
    // ~400 ms per bank call: the original takes ~0.8 s, well under REPLAY_WAIT_MS.
    await chaos('bank_a', { latencyMinMs: 400, latencyMaxMs: 400 });
    await chaos('bank_b', { latencyMinMs: 400, latencyMaxMs: 400 });

    const original = client.createTransfer(body(payer, payee), key);
    await sleep(150);
    const replay = await timed(() => client.createTransfer(body(payer, payee), key));
    const first = await original;

    expect(first.status).toBe(201);
    expect(replay.value.status).toBe(200);
    expect(isReplay(replay.value)).toBe(true);
    expect(replay.value.body).toMatchObject({ id: idOf(first), status: 'SUCCEEDED' });
    // It returned when the transfer finished, not after the full wait.
    expect(replay.ms).toBeLessThan(REPLAY_WAIT_MS - 300);
    expect(await debitRows(idOf(first))).toBe(1);
  });

  it('gives up after REPLAY_WAIT_MS with 202 PENDING; a later replay sees SUCCEEDED (202 -> 200)', async () => {
    const { payer, payee } = await accounts(10_000n);
    const key = uniqueId('key');
    // ~1.5 s per bank call (under the 2 s call timeout): the original takes ~3 s.
    await chaos('bank_a', { latencyMinMs: 1500, latencyMaxMs: 1500 });
    await chaos('bank_b', { latencyMinMs: 1500, latencyMaxMs: 1500 });

    const original = client.createTransfer(body(payer, payee), key);
    await sleep(150);
    const replay = await timed(() => client.createTransfer(body(payer, payee), key));
    const first = await original;

    expect(replay.value.status).toBe(202);
    expect(isReplay(replay.value)).toBe(true);
    expect(replay.value.headers.get('location')).toBe(`/v1/transfers/${idOf(first)}`);
    expect(replay.value.body).toMatchObject({ id: idOf(first), status: 'PENDING' });
    expect(replay.ms).toBeGreaterThanOrEqual(REPLAY_WAIT_MS - 50);
    expect(replay.ms).toBeLessThan(REPLAY_WAIT_MS + 1000);

    expect(first.status).toBe(201);
    const later = await client.createTransfer(body(payer, payee), key);
    expect(later.status).toBe(200);
    expect(later.body).toMatchObject({ id: idOf(first), status: 'SUCCEEDED' });
    expect(await debitRows(idOf(first))).toBe(1);
  });
});

describe('a replay never drives the saga', () => {
  it('a yielded transfer is not advanced by a replay, even once the bank is back', async () => {
    const { payer, payee } = await accounts(10_000n);
    const key = uniqueId('key');
    await chaos('bank_a', { down: true });
    const first = await client.createTransfer(body(payer, payee), key, { 'x-request-id': uniqueId('req-original') });
    expect(first.status).toBe(202);
    expect(first.body).toMatchObject({ state: 'DEBIT_SENT' });

    await chaos('bank_a', { down: false });
    const replayRequestId = uniqueId('req-replay');
    const replay = await client.createTransfer(body(payer, payee), key, { 'x-request-id': replayRequestId });
    expect(replay.status).toBe(202);
    expect(isReplay(replay)).toBe(true);
    expect(idOf(replay)).toBe(idOf(first));

    // Every state change records the request that drove it; none came from the replay.
    const trail = await events(idOf(first));
    expect(trail.length).toBeGreaterThan(0);
    expect(trail.filter((e) => e.detail.request_id === replayRequestId)).toEqual([]);
  });
});

describe('unknown outcomes: inline retries and yield', () => {
  /** First seed whose first two draws are reject, then pass, at reject_rate 0.5. */
  function rejectThenPassSeed(): number {
    for (let seed = 1; seed < 10_000; seed++) {
      const draw = mulberry32(seed);
      if (draw() < 0.5 && draw() >= 0.5) return seed;
    }
    throw new Error('no seed found');
  }

  it('a rejected (UNAVAILABLE) debit is retried inline with the same request and the transfer succeeds once', async () => {
    const { payer, payee } = await accounts(10_000n);
    await chaos('bank_a', { rejectRate: 0.5, seed: rejectThenPassSeed() });
    const unknownBefore = await downstreamCalls('Debit', 'unknown');
    const okBefore = await downstreamCalls('Debit', 'ok');

    const res = await client.createTransfer(body(payer, payee), uniqueId('key'));

    expect(res.status).toBe(201);
    expect((await downstreamCalls('Debit', 'unknown')) - unknownBefore).toBe(1);
    expect((await downstreamCalls('Debit', 'ok')) - okBefore).toBe(1);
    expect(await debitRows(idOf(res))).toBe(1);
    expect(await banks.balance('bank_a', payer)).toBe(9_000n);
  });

  it('a definite failure is never retried: one Debit call, FAILED', async () => {
    const { payer, payee } = await accounts(10n);
    const definiteBefore = await downstreamCalls('Debit', 'definite');
    const unknownBefore = await downstreamCalls('Debit', 'unknown');
    const res = await client.createTransfer(body(payer, payee), uniqueId('key'));
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ failure_code: 'INSUFFICIENT_FUNDS' });
    expect((await downstreamCalls('Debit', 'definite')) - definiteBefore).toBe(1);
    expect((await downstreamCalls('Debit', 'unknown')) - unknownBefore).toBe(0);
  });

  it('after INLINE_BANK_RETRIES the saga yields: state kept, attempts + 1, next_attempt_at = now + backoff(1), lease released', async () => {
    const { payer, payee } = await accounts(10_000n);
    await chaos('bank_a', { down: true });
    const unknownBefore = await downstreamCalls('Debit', 'unknown');
    const ledgerBefore = await downstreamCalls('PostJournal', 'ok');

    const res = await client.createTransfer(body(payer, payee), uniqueId('key'));

    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ status: 'PENDING', state: 'DEBIT_SENT', failure_code: null });
    expect((await downstreamCalls('Debit', 'unknown')) - unknownBefore).toBe(INLINE_BANK_ATTEMPTS);
    expect((await downstreamCalls('PostJournal', 'ok')) - ledgerBefore).toBe(0);

    const { rows } = await orchDb.query<{
      state: string;
      attempts: number;
      lease_owner: string | null;
      lease_expires_at: Date | null;
      delay_ms: string;
    }>(
      `SELECT state, attempts, lease_owner, lease_expires_at,
              (extract(epoch FROM next_attempt_at - updated_at) * 1000)::text AS delay_ms
         FROM transfers WHERE id = $1`,
      [idOf(res)],
    );
    const row = rows[0];
    expect(row).toMatchObject({ state: 'DEBIT_SENT', attempts: 1, lease_owner: null, lease_expires_at: null });
    // backoff(1) = 2000 ms plus up to 20 % jitter.
    expect(Number(row?.delay_ms)).toBeGreaterThanOrEqual(2000);
    expect(Number(row?.delay_ms)).toBeLessThanOrEqual(2400);
    expect(await banks.balance('bank_a', payer)).toBe(10_000n);
  });
});
