/** Topics (section 19). */
export const TRANSFER_EVENTS_TOPIC = 'transfer-events';
export const DLQ_TOPIC = 'transfer-events.dlq';

/** Section 19: dead-letter after 5 failed attempts. */
export const MAX_WEBHOOK_ATTEMPTS = 5;

/** One `transfer-events` message as received (independent of the Kafka client). */
export interface IncomingMessage {
  key: string | null;
  value: string | null;
  headers: Record<string, string>;
}

/** A transfer event this service can act on. */
export interface TransferEvent {
  /** `outbox.id` as a decimal string: the dedupe key (ADR-025, ADR-026). */
  eventId: string;
  eventType: string;
  transferId: string;
  payeeAccountId: string;
  /** The original message value, forwarded unchanged to the webhook and the dead-letter topic. */
  raw: string;
}

export type ParsedMessage = { ok: true; event: TransferEvent } | { ok: false; reason: string };

const EVENT_ID = /^[1-9]\d{0,18}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Validates a message against the shape ADR-025 publishes. Anything else is `ok: false`
 * with a reason: it goes straight to the dead-letter topic, because retrying a message
 * that can never be processed would block its partition forever (ADR-026).
 */
export function parseMessage(message: IncomingMessage): ParsedMessage {
  const eventId = message.headers['event-id'];
  if (eventId === undefined || !EVENT_ID.test(eventId))
    return { ok: false, reason: 'missing or malformed event-id header' };
  if (message.value === null) return { ok: false, reason: 'empty message value' };
  let value: unknown;
  try {
    value = JSON.parse(message.value);
  } catch {
    return { ok: false, reason: 'message value is not JSON' };
  }
  if (typeof value !== 'object' || value === null) return { ok: false, reason: 'message value is not an object' };
  const v = value as Record<string, unknown>;
  if (v.event_id !== eventId) return { ok: false, reason: 'event_id in the value does not match the header' };
  if (typeof v.event_type !== 'string' || !v.event_type.startsWith('transfer.')) {
    return { ok: false, reason: 'missing or unknown event_type' };
  }
  if (typeof v.transfer_id !== 'string' || !UUID.test(v.transfer_id))
    return { ok: false, reason: 'malformed transfer_id' };
  if (message.key !== v.transfer_id) return { ok: false, reason: 'message key is not the transfer id' };
  const payee = v.payee as { account_id?: unknown } | undefined;
  if (typeof payee?.account_id !== 'string') return { ok: false, reason: 'missing payee.account_id' };
  return {
    ok: true,
    event: {
      eventId,
      eventType: v.event_type,
      transferId: v.transfer_id,
      payeeAccountId: payee.account_id,
      raw: message.value,
    },
  };
}
