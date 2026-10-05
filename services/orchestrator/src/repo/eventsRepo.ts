import type { Pool, PoolClient } from 'pg';
import type { TransferState } from '../domain/states';

export interface NewTransferEvent {
  transferId: string;
  fromState: TransferState | null;
  toState: TransferState;
  reason: string;
  detail: Record<string, unknown>;
}

export interface TransferEvent extends NewTransferEvent {
  id: bigint;
  createdAt: Date;
}

interface EventRow {
  id: string;
  transfer_id: string;
  from_state: TransferState | null;
  to_state: TransferState;
  reason: string;
  detail: Record<string, unknown>;
  created_at: Date;
}

/** Appends one `transfer_events` row. Called inside the transaction that changes the state. */
export async function appendEvent(client: PoolClient, event: NewTransferEvent): Promise<void> {
  await client.query(
    `INSERT INTO transfer_events (transfer_id, from_state, to_state, reason, detail)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [event.transferId, event.fromState, event.toState, event.reason, JSON.stringify(event.detail)],
  );
}

/** The audit trail of one transfer, oldest first. */
export async function listEvents(pool: Pool, transferId: string): Promise<TransferEvent[]> {
  const result = await pool.query<EventRow>(
    `SELECT id, transfer_id, from_state, to_state, reason, detail, created_at
       FROM transfer_events WHERE transfer_id = $1 ORDER BY id`,
    [transferId],
  );
  return result.rows.map((row) => ({
    id: BigInt(row.id),
    transferId: row.transfer_id,
    fromState: row.from_state,
    toState: row.to_state,
    reason: row.reason,
    detail: row.detail,
    createdAt: row.created_at,
  }));
}
