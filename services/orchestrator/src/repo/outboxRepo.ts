import { withTransaction } from '@switch/common';
import type { Pool, PoolClient } from 'pg';
import {
  eventPayload,
  eventTypeFor,
  type OutboxEvent,
  type OutboxEventType,
  type TransferEventPayload,
} from '../domain/outboxEvents';
import type { Transfer } from '../domain/transfer';
import type { OutboxStore } from '../outbox/relay';

interface OutboxRow {
  id: string;
  aggregate_id: string;
  event_type: OutboxEventType;
  payload: TransferEventPayload;
}

/**
 * Inserts the terminal event for `transfer` (the row a terminal CAS just returned).
 * Called inside that CAS's transaction (section 19, ADR-025), so the event exists if and
 * only if the state change committed.
 */
export async function appendOutbox(client: PoolClient, transfer: Transfer): Promise<void> {
  const eventType = eventTypeFor(transfer.state);
  if (eventType === null) throw new Error(`appendOutbox: ${transfer.state} is not a terminal state`);
  await client.query(`INSERT INTO outbox (aggregate_id, event_type, payload) VALUES ($1, $2, $3::jsonb)`, [
    transfer.id,
    eventType,
    JSON.stringify(eventPayload(transfer)),
  ]);
}

/**
 * One relay iteration (section 19): in one transaction, claim up to `limit` unpublished
 * rows in id order with `FOR UPDATE SKIP LOCKED`, hand them to `send`, and mark them
 * published. If `send` throws, the transaction rolls back and the rows stay unpublished.
 * Returns how many rows were published.
 */
export async function publishBatch(
  pool: Pool,
  limit: number,
  send: (events: OutboxEvent[]) => Promise<void>,
): Promise<number> {
  return withTransaction(pool, async (client) => {
    const { rows } = await client.query<OutboxRow>(
      `SELECT id::text AS id, aggregate_id, event_type, payload
         FROM outbox
        WHERE published_at IS NULL
        ORDER BY id
        LIMIT $1
          FOR UPDATE SKIP LOCKED`,
      [limit],
    );
    if (rows.length === 0) return 0;
    await send(
      rows.map((row) => ({
        id: row.id,
        aggregateId: row.aggregate_id,
        eventType: row.event_type,
        payload: row.payload,
      })),
    );
    await client.query('UPDATE outbox SET published_at = now() WHERE id = ANY($1::bigint[])', [
      rows.map((row) => row.id),
    ]);
    return rows.length;
  });
}

/** Unpublished rows: the relay's lag, for the `outbox_unpublished` gauge. */
export async function countUnpublished(pool: Pool): Promise<number> {
  const { rows } = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM outbox WHERE published_at IS NULL');
  return rows[0]?.n ?? 0;
}

export function createOutboxStore(pool: Pool): OutboxStore {
  return {
    publishBatch: (limit, send) => publishBatch(pool, limit, send),
    countUnpublished: () => countUnpublished(pool),
  };
}
