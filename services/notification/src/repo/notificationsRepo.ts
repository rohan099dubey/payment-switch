import type { Pool } from 'pg';
import type { NotificationStore } from '../domain/processor';

/** All SQL of the notification service (section 3 convention). */
export function createNotificationStore(pool: Pool): NotificationStore {
  return {
    isProcessed: async (eventId) => {
      const { rows } = await pool.query('SELECT 1 FROM processed_events WHERE event_id = $1', [eventId]);
      return rows.length > 0;
    },
    recordAttempt: async (eventId, attempt, ok, error) => {
      await pool.query('INSERT INTO webhook_attempts (event_id, attempt, ok, error) VALUES ($1, $2, $3, $4)', [
        eventId,
        attempt,
        ok,
        error,
      ]);
    },
    // ON CONFLICT DO NOTHING: the primary key decides between consumers racing in a rebalance.
    recordOutcome: async (r) => {
      const { rowCount } = await pool.query(
        `INSERT INTO processed_events (event_id, transfer_id, event_type, outcome, attempts, last_error)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (event_id) DO NOTHING`,
        [r.eventId, r.transferId, r.eventType, r.outcome, r.attempts, r.lastError],
      );
      return rowCount === 1;
    },
  };
}

/** Readiness probe for `/readyz`. */
export async function ping(pool: Pool): Promise<void> {
  await pool.query('SELECT 1');
}
