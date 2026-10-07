import { TransferState } from './states';
import type { Transfer } from './transfer';

/** Kafka topic for transfer events (section 19). */
export const TRANSFER_EVENTS_TOPIC = 'transfer-events';

/** The relay's batch size: the spec's `LIMIT 100`. */
export const OUTBOX_BATCH = 100;

export const OutboxEventType = {
  SUCCEEDED: 'transfer.succeeded',
  FAILED: 'transfer.failed',
  REVERSED: 'transfer.reversed',
  NEEDS_MANUAL_REVIEW: 'transfer.needs_manual_review',
} as const;

export type OutboxEventType = (typeof OutboxEventType)[keyof typeof OutboxEventType];

/**
 * The event a terminal state emits; `null` for a non-terminal one. Every terminal state
 * emits, including `NEEDS_MANUAL_REVIEW` (ADR-025).
 */
export function eventTypeFor(state: TransferState): OutboxEventType | null {
  switch (state) {
    case TransferState.SUCCESS:
      return OutboxEventType.SUCCEEDED;
    case TransferState.FAILED:
      return OutboxEventType.FAILED;
    case TransferState.REVERSED:
      return OutboxEventType.REVERSED;
    case TransferState.NEEDS_MANUAL_REVIEW:
      return OutboxEventType.NEEDS_MANUAL_REVIEW;
    default:
      return null;
  }
}

/**
 * What the outbox row stores, built from the row the terminal CAS returned. `amount` is a
 * string of paise: a JSON number would be a float in most consumers (ADR-025). `note` is
 * client free text and is left out.
 */
export interface TransferEventPayload {
  transfer_id: string;
  client_id: string;
  state: TransferState;
  failure_code: string | null;
  amount: string;
  currency: string;
  payer: { bank_id: string; account_id: string };
  payee: { bank_id: string; account_id: string };
  occurred_at: string;
}

export function eventPayload(t: Transfer): TransferEventPayload {
  return {
    transfer_id: t.id,
    client_id: t.clientId,
    state: t.state,
    failure_code: t.failureCode,
    amount: t.amount.toString(),
    currency: t.currency,
    payer: { bank_id: t.payer.bankId, account_id: t.payer.accountId },
    payee: { bank_id: t.payee.bankId, account_id: t.payee.accountId },
    occurred_at: t.updatedAt.toISOString(),
  };
}

/** One unpublished outbox row, as the relay reads it. */
export interface OutboxEvent {
  /** `outbox.id` as a decimal string: the event id consumers deduplicate by. */
  id: string;
  aggregateId: string;
  eventType: OutboxEventType;
  payload: TransferEventPayload;
}

/** A Kafka message, independent of the client library. */
export interface EventMessage {
  key: string;
  value: string;
  headers: Record<string, string>;
}

/** Keyed by transfer id; the event id travels in a header and in the value (ADR-025). */
export function toMessage(event: OutboxEvent): EventMessage {
  return {
    key: event.aggregateId,
    value: JSON.stringify({ event_id: event.id, event_type: event.eventType, ...event.payload }),
    headers: { 'event-id': event.id, 'event-type': event.eventType },
  };
}
