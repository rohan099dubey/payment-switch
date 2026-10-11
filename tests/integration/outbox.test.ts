/**
 * Phase 2, item 1 (ARCHITECTURE.md section 19, ADR-025): the transactional outbox and its
 * Kafka relay, against the real stack: Postgres, the Orchestrator's relay, and Kafka.
 *
 * - The table is the spec's, with ADR-025's constraints, enforced by the database.
 * - Every terminal transition writes exactly one event, in the same transaction.
 * - The relay publishes it to `transfer-events`, keyed by transfer id, and marks it.
 * - With Kafka stopped, payments still succeed and their events wait; two concurrent
 *   claims never overlap (SKIP LOCKED); a failed send rolls back; nothing is lost.
 */
import { randomUUID } from 'node:crypto';
import type { ChaosConfig } from '@switch/proto-gen/bank/v1';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { publishBatch } from '../../services/orchestrator/src/repo/outboxRepo';
import { BankAdmin } from '../helpers/bankAdmin';
import { inRolledBackTransaction } from '../helpers/db';
import { DEV_CLIENTS, GatewayClient, type HttpResult } from '../helpers/gatewayClient';
import { awaitOutboxPublished } from '../helpers/invariants';
import { readTransferEvents } from '../helpers/kafka';
import { startService, stopService, waitFor } from '../helpers/stack';

const ORCH_DB = process.env.ORCHESTRATOR_DATABASE_URL ?? 'postgres://orch:orch@localhost:5433/orchestrator_db';
const ORCH_HTTP = process.env.ORCHESTRATOR_HTTP_URL ?? 'http://localhost:9101';

const RUN = randomUUID().slice(0, 8);
let counter = 0;
const uniqueId = (prefix: string): string => `p21-${RUN}-${prefix}-${++counter}`;
const client = GatewayClient.for(DEV_CLIENTS.a);
const TERMINAL: ReadonlySet<string> = new Set(['SUCCESS', 'FAILED', 'REVERSED', 'NEEDS_MANUAL_REVIEW']);

let banks: BankAdmin;
let db: Pool;
let startupChaosA: ChaosConfig;
/** Every transfer this file created that must end with a published event. */
const created = new Map<string, string>();

beforeAll(async () => {
  banks = new BankAdmin();
  db = new Pool({ connectionString: ORCH_DB, max: 4 });
  startupChaosA = await banks.getChaos('bank_a');
  await client.accessToken();
});

afterAll(async () => {
  await banks.setChaos('bank_a', startupChaosA);
  banks.close();
  await db.end();
});

// ---------------------------------------------------------------- helpers

async function accounts(payerBalance: bigint): Promise<{ payer: string; payee: string }> {
  const payer = uniqueId('payer');
  const payee = uniqueId('payee');
  await banks.createAccount('bank_a', payer, payerBalance);
  await banks.createAccount('bank_b', payee, 0n);
  return { payer, payee };
}

async function transfer(payer: string, payee: string, amount = 1000): Promise<HttpResult> {
  const res = await client.createTransfer(
    {
      payer: { bank_id: 'bank_a', account_id: payer },
      payee: { bank_id: 'bank_b', account_id: payee },
      amount,
      currency: 'INR',
    },
    uniqueId('key'),
  );
  created.set(res.body.id as string, res.body.state as string);
  return res;
}

interface OutboxRow {
  id: string;
  event_type: string;
  payload: Record<string, unknown>;
  created_at: Date;
  published_at: Date | null;
}

async function outboxRows(transferId: string): Promise<OutboxRow[]> {
  const r = await db.query<OutboxRow>(
    'SELECT id::text AS id, event_type, payload, created_at, published_at FROM outbox WHERE aggregate_id = $1',
    [transferId],
  );
  return r.rows;
}

/** `created_at` of the transfer's terminal `transfer_events` row. */
async function terminalEventAt(transferId: string): Promise<Date> {
  const r = await db.query<{ created_at: Date }>(
    `SELECT created_at FROM transfer_events
      WHERE transfer_id = $1 AND to_state IN ('SUCCESS','FAILED','REVERSED','NEEDS_MANUAL_REVIEW')`,
    [transferId],
  );
  const row = r.rows[0];
  if (row === undefined || r.rows.length !== 1) throw new Error(`${transferId}: ${r.rows.length} terminal events`);
  return row.created_at;
}

async function orchestratorMetric(name: string): Promise<number> {
  const text = await (await fetch(`${ORCH_HTTP}/metrics`)).text();
  const line = text.split('\n').find((l) => l.startsWith(`${name} `));
  return line === undefined ? 0 : Number(line.split(' ')[1]);
}

async function kafkaUp(): Promise<void> {
  await startService('kafka');
  await waitFor(
    'kafka to accept the topic again',
    async () => {
      try {
        await readTransferEvents(new Set(), 1);
        return true;
      } catch {
        return false;
      }
    },
    120_000,
  );
}

// ---------------------------------------------------------------- tests

describe('outbox — schema (section 19, ADR-025)', () => {
  it('has the spec columns: id bigint identity, aggregate_id uuid, event_type text, payload jsonb, two timestamps', async () => {
    const r = await db.query<{ column_name: string; data_type: string; is_nullable: string; is_identity: string }>(
      `SELECT column_name, data_type, is_nullable, is_identity FROM information_schema.columns
        WHERE table_name = 'outbox' ORDER BY ordinal_position`,
    );
    expect(r.rows).toEqual([
      { column_name: 'id', data_type: 'bigint', is_nullable: 'NO', is_identity: 'YES' },
      { column_name: 'aggregate_id', data_type: 'uuid', is_nullable: 'NO', is_identity: 'NO' },
      { column_name: 'event_type', data_type: 'text', is_nullable: 'NO', is_identity: 'NO' },
      { column_name: 'payload', data_type: 'jsonb', is_nullable: 'NO', is_identity: 'NO' },
      { column_name: 'created_at', data_type: 'timestamp with time zone', is_nullable: 'NO', is_identity: 'NO' },
      { column_name: 'published_at', data_type: 'timestamp with time zone', is_nullable: 'YES', is_identity: 'NO' },
    ]);
    const idx = await db.query<{ indexdef: string }>(
      "SELECT indexdef FROM pg_indexes WHERE tablename = 'outbox' AND indexname = 'outbox_unpublished_idx'",
    );
    expect(idx.rows[0]?.indexdef).toContain('WHERE (published_at IS NULL)');
  });

  it('the database rejects a second event for a transfer, and an unknown event type', { timeout: 90_000 }, async () => {
    const { payer, payee } = await accounts(10_000n);
    const id = (await transfer(payer, payee)).body.id as string;
    // A 202 transfer has no event yet, so the "second" one would be its first and would
    // be accepted. Wait until it is terminal, and require its own event.
    await waitFor(
      'the transfer to be terminal',
      async () => TERMINAL.has((await client.getTransfer(id)).body.state as string),
      80_000,
    );
    expect(await outboxRows(id)).toHaveLength(1);

    // Each insert rolls back whatever happens, so a wrong precondition or a missing
    // constraint fails this test without committing a fake event to a shared database.
    const duplicate = await inRolledBackTransaction(db, async (c) => {
      await c.query(`INSERT INTO outbox (aggregate_id, event_type, payload) VALUES ($1, 'transfer.failed', '{}')`, [
        id,
      ]);
    });
    expect(duplicate).toMatchObject({ code: '23505', constraint: 'outbox_one_event_per_transfer' });
    const unknownType = await inRolledBackTransaction(db, async (c) => {
      await c.query(`INSERT INTO outbox (aggregate_id, event_type, payload) VALUES ($1, 'transfer.created', '{}')`, [
        randomUUID(),
      ]);
    });
    expect(unknownType).toMatchObject({ code: '23514' });
    expect(await outboxRows(id)).toHaveLength(1);
  });
});

describe('outbox — every terminal transition writes one event, in the same transaction', () => {
  it.each([
    ['SUCCESS', 'transfer.succeeded', 10_000n, true, null],
    ['FAILED', 'transfer.failed', 10n, true, 'INSUFFICIENT_FUNDS'],
    ['REVERSED', 'transfer.reversed', 10_000n, false, 'PAYEE_ACCOUNT_NOT_FOUND'],
  ] as const)('%s -> one %s event', async (state, eventType, balance, payeeExists, failureCode) => {
    const { payer, payee } = await accounts(balance);
    const res = await transfer(payer, payeeExists ? payee : uniqueId('nobody'), 1000);
    expect(res.body.state).toBe(state);
    const id = res.body.id as string;

    const rows = await outboxRows(id);
    expect(rows).toHaveLength(1);
    const [row] = rows;
    if (row === undefined) throw new Error('no outbox row');
    expect(row.event_type).toBe(eventType);
    expect(row.payload).toMatchObject({
      transfer_id: id,
      state,
      failure_code: failureCode,
      amount: '1000',
      currency: 'INR',
    });
    // now() is the transaction's start time: equal timestamps mean one transaction.
    expect(row.created_at.getTime()).toBe((await terminalEventAt(id)).getTime());
  });

  it('a transfer that is not terminal has no event; it gets one when it finishes', { timeout: 90_000 }, async () => {
    const { payer, payee } = await accounts(10_000n);
    await banks.setChaos('bank_a', { ...startupChaosA, down: true });
    const res = await transfer(payer, payee);
    expect(res.status).toBe(202);
    const id = res.body.id as string;
    expect(await outboxRows(id)).toHaveLength(0);

    await banks.setChaos('bank_a', startupChaosA);
    await waitFor(
      'recovery to finish the transfer',
      async () =>
        (await db.query('SELECT 1 FROM transfers WHERE id = $1 AND state = $2', [id, 'SUCCESS'])).rows.length === 1,
      80_000,
    );
    created.set(id, 'SUCCESS');
    expect((await outboxRows(id)).map((r) => r.event_type)).toEqual(['transfer.succeeded']);
  });
});

describe('outbox — the relay publishes to Kafka', () => {
  it('each event reaches transfer-events keyed by transfer id, with its event id and payload, then is marked', async () => {
    const ids = [...created.keys()];
    expect(ids.length).toBeGreaterThanOrEqual(5);
    await awaitOutboxPublished(db, ids, 30_000);
    const consumed = await readTransferEvents(new Set(ids), 60_000);
    for (const id of ids) {
      const [row] = await outboxRows(id);
      if (row === undefined) throw new Error(`${id}: no outbox row`);
      expect(row.published_at).not.toBeNull();
      const deliveries = consumed.get(id) ?? [];
      expect(deliveries.length).toBeGreaterThanOrEqual(1);
      for (const d of deliveries) {
        expect(d.headers).toEqual({ 'event-id': row.id, 'event-type': row.event_type });
        expect(d.value).toEqual({ event_id: row.id, event_type: row.event_type, ...row.payload });
      }
      // One transfer, one key, one partition.
      expect(new Set(deliveries.map((d) => d.partition)).size).toBe(1);
    }
  });
});

describe('outbox — a Kafka outage stops no payment and loses no event', () => {
  it(
    'payments succeed while Kafka is down; claims never overlap; a failed send rolls back; all is published after',
    { timeout: 240_000 },
    async () => {
      const failuresBefore = await orchestratorMetric('outbox_publish_failures_total');
      await stopService('kafka');
      try {
        const ids: string[] = [];
        for (let i = 0; i < 5; i++) {
          const { payer, payee } = await accounts(10_000n);
          const res = await transfer(payer, payee);
          expect(res.status).toBe(201);
          expect(res.body.state).toBe('SUCCESS');
          ids.push(res.body.id as string);
        }
        for (const id of ids) {
          const rows = await outboxRows(id);
          expect(rows).toHaveLength(1);
          expect(rows[0]?.published_at).toBeNull();
        }
        await waitFor(
          'the relay to report the outage',
          async () => (await orchestratorMetric('outbox_publish_failures_total')) > failuresBefore,
          60_000,
        );
        expect(await orchestratorMetric('outbox_unpublished')).toBeGreaterThanOrEqual(5);

        // While the broker is unreachable the live relay claims nothing (it fails before
        // claiming), so two concurrent claims here see every unpublished row.
        const claimed: string[][] = [[], []];
        const slowFailingSend =
          (lane: 0 | 1) =>
          async (events: { aggregateId: string }[]): Promise<void> => {
            claimed[lane]?.push(...events.map((e) => e.aggregateId));
            await new Promise((resolve) => setTimeout(resolve, 500));
            throw new Error('broker unreachable');
          };
        const results = await Promise.allSettled([
          publishBatch(db, 100, slowFailingSend(0)),
          publishBatch(db, 100, slowFailingSend(1)),
        ]);
        const [a, b] = claimed;
        if (a === undefined || b === undefined) throw new Error('lanes missing');
        expect(a.filter((id) => b.includes(id))).toEqual([]);
        for (const id of ids) expect([...a, ...b]).toContain(id);
        expect(results.filter((r) => r.status === 'rejected').length).toBeGreaterThanOrEqual(1);
        // Both sends failed: both transactions rolled back, nothing was marked.
        for (const id of ids) expect((await outboxRows(id))[0]?.published_at).toBeNull();

        for (const id of ids) created.set(id, 'SUCCESS');
      } finally {
        await kafkaUp();
      }
      await awaitOutboxPublished(db, [...created.keys()], 90_000);
      const consumed = await readTransferEvents(new Set(created.keys()), 90_000);
      expect(consumed.size).toBe(created.size);
      expect(await orchestratorMetric('outbox_unpublished')).toBe(0);
    },
  );
});
