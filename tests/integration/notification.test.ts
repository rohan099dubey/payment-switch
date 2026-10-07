/**
 * Phase 2, item 2 (ARCHITECTURE.md section 19, ADR-026): the notification service against
 * the real stack. Transfers go through the Gateway; their outbox events reach Kafka
 * (ADR-025); the service consumes them, calls the simulated webhook, and records each
 * event's outcome exactly once in `notification_db`.
 */
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BankAdmin } from '../helpers/bankAdmin';
import { DEV_CLIENTS, GatewayClient } from '../helpers/gatewayClient';
import { DLQ_TOPIC, produceRaw, readTopic, TRANSFER_EVENTS_TOPIC } from '../helpers/kafka';
import { startService, stopService, waitFor, waitReady } from '../helpers/stack';

const ORCH_DB = process.env.ORCHESTRATOR_DATABASE_URL ?? 'postgres://orch:orch@localhost:5433/orchestrator_db';
const NOTIFY_DB =
  process.env.NOTIFICATION_DATABASE_URL ?? 'postgres://notification:notification@localhost:5436/notification_db';
const NOTIFY_HTTP = process.env.NOTIFICATION_HTTP_URL ?? 'http://localhost:9103';

const RUN = randomUUID().slice(0, 8);
let counter = 0;
const uniqueId = (prefix: string): string => `${prefix}${RUN}-${++counter}`;
const client = GatewayClient.for(DEV_CLIENTS.a);

let banks: BankAdmin;
let orchDb: Pool;
let notifyDb: Pool;

beforeAll(async () => {
  banks = new BankAdmin();
  orchDb = new Pool({ connectionString: ORCH_DB, max: 2 });
  notifyDb = new Pool({ connectionString: NOTIFY_DB, max: 2 });
  await client.accessToken();
});

afterAll(async () => {
  banks.close();
  await orchDb.end();
  await notifyDb.end();
});

// ---------------------------------------------------------------- helpers

/** A successful transfer to a payee whose account id starts with `payeePrefix`; returns its id. */
async function transferTo(payeePrefix: string): Promise<string> {
  const payer = uniqueId('n-payer-');
  const payee = uniqueId(payeePrefix);
  await banks.createAccount('bank_a', payer, 10_000n);
  await banks.createAccount('bank_b', payee, 0n);
  const res = await client.createTransfer(
    {
      payer: { bank_id: 'bank_a', account_id: payer },
      payee: { bank_id: 'bank_b', account_id: payee },
      amount: 1000,
      currency: 'INR',
    },
    uniqueId('n-key-'),
  );
  expect(res.body.state).toBe('SUCCESS');
  return res.body.id as string;
}

async function outboxEvent(
  transferId: string,
): Promise<{ id: string; eventType: string; payload: Record<string, unknown> }> {
  const r = await orchDb.query<{ id: string; event_type: string; payload: Record<string, unknown> }>(
    'SELECT id::text AS id, event_type, payload FROM outbox WHERE aggregate_id = $1',
    [transferId],
  );
  const row = r.rows[0];
  if (row === undefined) throw new Error(`${transferId}: no outbox event`);
  return { id: row.id, eventType: row.event_type, payload: row.payload };
}

interface Processed {
  outcome: string;
  attempts: number;
  last_error: string | null;
}

async function awaitProcessed(eventId: string, timeoutMs = 60_000): Promise<Processed> {
  let found: Processed | undefined;
  await waitFor(
    `event ${eventId} to be processed`,
    async () => {
      const r = await notifyDb.query<Processed>(
        'SELECT outcome, attempts, last_error FROM processed_events WHERE event_id = $1',
        [eventId],
      );
      found = r.rows[0];
      return found !== undefined;
    },
    timeoutMs,
  );
  if (found === undefined) throw new Error('unreachable');
  return found;
}

/** Gaps in ms between consecutive webhook attempts of one event. */
async function attemptGaps(eventId: string): Promise<{ count: number; gaps: number[]; oks: boolean[] }> {
  const r = await notifyDb.query<{ ok: boolean; attempted_at: Date }>(
    'SELECT ok, attempted_at FROM webhook_attempts WHERE event_id = $1 ORDER BY attempt',
    [eventId],
  );
  const times = r.rows.map((row) => row.attempted_at.getTime());
  return {
    count: r.rows.length,
    gaps: times.slice(1).map((t, i) => t - (times[i] ?? t)),
    oks: r.rows.map((row) => row.ok),
  };
}

async function metric(outcome: string): Promise<number> {
  const text = await (await fetch(`${NOTIFY_HTTP}/metrics`)).text();
  const line = text.split('\n').find((l) => l.startsWith(`notifications_total{outcome="${outcome}"}`));
  return line === undefined ? 0 : Number(line.split(' ')[1]);
}

// ---------------------------------------------------------------- tests

describe('notification — each event reaches its outcome exactly once (section 19, ADR-026)', () => {
  it('an ordinary transfer is delivered on the first attempt', async () => {
    const id = await transferTo('n-payee-');
    const event = await outboxEvent(id);
    expect(await awaitProcessed(event.id)).toEqual({ outcome: 'DELIVERED', attempts: 1, last_error: null });
    expect((await attemptGaps(event.id)).oks).toEqual([true]);
  });

  it('a flaky merchant is retried with exponential backoff and delivered on attempt 3', async () => {
    const event = await outboxEvent(await transferTo('whflaky-'));
    expect(await awaitProcessed(event.id)).toEqual({ outcome: 'DELIVERED', attempts: 3, last_error: null });
    const { oks, gaps } = await attemptGaps(event.id);
    expect(oks).toEqual([false, false, true]);
    // 200 ms, then 400 ms (WEBHOOK_RETRY_BASE_MS = 200); the clock is Postgres's, so allow 10 ms.
    expect(gaps[0]).toBeGreaterThanOrEqual(190);
    expect(gaps[1]).toBeGreaterThanOrEqual(390);
  });

  it(
    'a merchant that always fails gets 5 attempts, then the event goes to transfer-events.dlq',
    { timeout: 60_000 },
    async () => {
      const id = await transferTo('whfail-');
      const event = await outboxEvent(id);
      const processed = await awaitProcessed(event.id);
      expect(processed).toMatchObject({ outcome: 'DEAD_LETTERED', attempts: 5 });
      expect(processed.last_error).toContain('500');
      const { oks, gaps } = await attemptGaps(event.id);
      expect(oks).toEqual([false, false, false, false, false]);
      for (const [i, min] of [190, 390, 790, 1590].entries()) expect(gaps[i]).toBeGreaterThanOrEqual(min);

      const [dead] = (await readTopic(DLQ_TOPIC, new Set([id]))).get(id) ?? [];
      expect(dead?.headers).toMatchObject({
        'event-id': event.id,
        'event-type': 'transfer.succeeded',
        'dlq-reason': 'WEBHOOK_FAILED',
        attempts: '5',
      });
      expect(dead?.value).toMatchObject({ event_id: event.id, transfer_id: id });
    },
  );

  it('a redelivered copy of an event is a duplicate: no second webhook call, no second record', async () => {
    const id = await transferTo('n-payee-');
    const event = await outboxEvent(id);
    await awaitProcessed(event.id);
    const before = await metric('duplicate');

    await produceRaw(TRANSFER_EVENTS_TOPIC, [
      {
        key: id,
        value: JSON.stringify({ event_id: event.id, event_type: event.eventType, ...event.payload }),
        headers: { 'event-id': event.id, 'event-type': event.eventType },
      },
    ]);
    await waitFor('the copy to be seen', async () => (await metric('duplicate')) > before, 30_000);
    expect((await attemptGaps(event.id)).count).toBe(1);
    const rows = await notifyDb.query('SELECT 1 FROM processed_events WHERE event_id = $1', [event.id]);
    expect(rows.rows).toHaveLength(1);
  });

  it('a malformed message goes straight to the dead-letter topic as INVALID_MESSAGE', { timeout: 90_000 }, async () => {
    const key = randomUUID();
    const before = await metric('invalid');
    await produceRaw(TRANSFER_EVENTS_TOPIC, [{ key, value: 'not an event', headers: {} }]);
    const [dead] = (await readTopic(DLQ_TOPIC, new Set([key]), 60_000)).get(key) ?? [];
    expect(dead?.headers['dlq-reason']).toBe('INVALID_MESSAGE');
    expect(dead?.raw).toBe('not an event');
    expect(await metric('invalid')).toBe(before + 1);
  });

  it('events published while the service is down are all processed once it is back', { timeout: 180_000 }, async () => {
    await stopService('notification');
    const ids: string[] = [];
    try {
      for (let i = 0; i < 3; i++) ids.push(await transferTo('n-payee-'));
    } finally {
      await startService('notification');
      await waitReady(`${NOTIFY_HTTP}/readyz`, 120_000);
    }
    for (const id of ids) {
      const event = await outboxEvent(id);
      expect(await awaitProcessed(event.id, 90_000)).toMatchObject({ outcome: 'DELIVERED', attempts: 1 });
      expect((await attemptGaps(event.id)).count).toBe(1);
    }
  });
});
