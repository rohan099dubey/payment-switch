import { parseMessage, type IncomingMessage } from './events';
import type { WebhookPort } from './webhook';

export type Outcome = 'DELIVERED' | 'DEAD_LETTERED';
export type HandleResult = 'delivered' | 'dead_lettered' | 'duplicate' | 'invalid';

/** What the processor needs from `repo/notificationsRepo.ts`. Errors propagate. */
export interface NotificationStore {
  isProcessed: (eventId: string) => Promise<boolean>;
  recordAttempt: (eventId: string, attempt: number, ok: boolean, error: string | null) => Promise<void>;
  /** Inserts the final outcome; `false` when the event id was already recorded. */
  recordOutcome: (record: {
    eventId: string;
    transferId: string;
    eventType: string;
    outcome: Outcome;
    attempts: number;
    lastError: string | null;
  }) => Promise<boolean>;
}

export interface DeadLetterMessage {
  key: string | null;
  value: string;
  headers: Record<string, string>;
}

/** Resolves only once the broker acknowledged the dead letter (`acks=all`). */
export interface DeadLetterPort {
  publish: (message: DeadLetterMessage) => Promise<void>;
}

export interface ProcessorObserver {
  handled: (result: HandleResult) => void;
  attempt: (ok: boolean) => void;
}

export interface ProcessorDeps {
  store: NotificationStore;
  webhook: WebhookPort;
  deadLetters: DeadLetterPort;
  observer: ProcessorObserver;
  sleep: (ms: number) => Promise<void>;
  /** Section 19: 5. */
  maxAttempts: number;
  /** Backoff before attempt n+1 is `retryBaseMs * 2^(n-1)`. */
  retryBaseMs: number;
}

/**
 * One `transfer-events` message (section 19, ADR-026): dedupe by event id, call the
 * webhook with exponential backoff, dead-letter after `maxAttempts` failures, record
 * the outcome. Every step can be repeated: if anything throws (the database, the broker),
 * the offset is not committed, the message comes back, and the dedupe table decides.
 */
export class EventProcessor {
  constructor(private readonly deps: ProcessorDeps) {}

  async handle(message: IncomingMessage): Promise<HandleResult> {
    const { store, webhook, deadLetters, observer, maxAttempts, retryBaseMs } = this.deps;
    const parsed = parseMessage(message);
    if (!parsed.ok) {
      await deadLetters.publish({
        key: message.key,
        value: message.value ?? '',
        headers: { ...message.headers, 'dlq-reason': 'INVALID_MESSAGE', 'dlq-detail': parsed.reason },
      });
      observer.handled('invalid');
      return 'invalid';
    }
    const event = parsed.event;
    if (await store.isProcessed(event.eventId)) {
      observer.handled('duplicate');
      return 'duplicate';
    }

    let lastError = '';
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let error: string | null = null;
      try {
        await webhook.deliver(event, attempt);
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      }
      await store.recordAttempt(event.eventId, attempt, error === null, error);
      observer.attempt(error === null);
      if (error === null) return this.finish(event, 'DELIVERED', attempt, null);
      lastError = error;
      if (attempt < maxAttempts) await this.deps.sleep(retryBaseMs * 2 ** (attempt - 1));
    }

    await deadLetters.publish({
      key: event.transferId,
      value: event.raw,
      headers: {
        'event-id': event.eventId,
        'event-type': event.eventType,
        'dlq-reason': 'WEBHOOK_FAILED',
        attempts: String(maxAttempts),
        'last-error': lastError,
      },
    });
    return this.finish(event, 'DEAD_LETTERED', maxAttempts, lastError);
  }

  private async finish(
    event: { eventId: string; transferId: string; eventType: string },
    outcome: Outcome,
    attempts: number,
    lastError: string | null,
  ): Promise<HandleResult> {
    const inserted = await this.deps.store.recordOutcome({ ...event, outcome, attempts, lastError });
    // Another consumer recorded it first (a rebalance): this delivery was the duplicate.
    const result: HandleResult = !inserted ? 'duplicate' : outcome === 'DELIVERED' ? 'delivered' : 'dead_lettered';
    this.deps.observer.handled(result);
    return result;
  }
}
