import { describe, expect, it } from 'vitest';
import type { IncomingMessage, TransferEvent } from '../../src/domain/events';
import {
  EventProcessor,
  type DeadLetterMessage,
  type HandleResult,
  type NotificationStore,
  type Outcome,
} from '../../src/domain/processor';
import type { WebhookPort } from '../../src/domain/webhook';

const TRANSFER = '3826712e-725b-44ea-a8cf-5f41a346c6b2';

function message(eventId = '7', overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  const value = JSON.stringify({
    event_id: eventId,
    event_type: 'transfer.succeeded',
    transfer_id: TRANSFER,
    payee: { bank_id: 'bank_b', account_id: 'ACC002' },
    amount: '12500',
  });
  return { key: TRANSFER, value, headers: { 'event-id': eventId, 'event-type': 'transfer.succeeded' }, ...overrides };
}

class FakeStore implements NotificationStore {
  readonly outcomes = new Map<string, { outcome: Outcome; attempts: number; lastError: string | null }>();
  readonly attempts: { eventId: string; attempt: number; ok: boolean }[] = [];
  failNextAttemptWrite = false;

  isProcessed(eventId: string): Promise<boolean> {
    return Promise.resolve(this.outcomes.has(eventId));
  }
  recordAttempt(eventId: string, attempt: number, ok: boolean): Promise<void> {
    if (this.failNextAttemptWrite) {
      this.failNextAttemptWrite = false;
      return Promise.reject(new Error('connection terminated'));
    }
    this.attempts.push({ eventId, attempt, ok });
    return Promise.resolve();
  }
  recordOutcome(r: {
    eventId: string;
    outcome: Outcome;
    attempts: number;
    lastError: string | null;
  }): Promise<boolean> {
    if (this.outcomes.has(r.eventId)) return Promise.resolve(false);
    this.outcomes.set(r.eventId, { outcome: r.outcome, attempts: r.attempts, lastError: r.lastError });
    return Promise.resolve(true);
  }
}

/** Fails the first `failures` calls, then succeeds. */
class ScriptedWebhook implements WebhookPort {
  calls = 0;
  constructor(private failures: number) {}
  deliver(_event: TransferEvent, attempt: number): Promise<void> {
    this.calls++;
    if (this.failures > 0) {
      this.failures--;
      return Promise.reject(new Error(`503 on attempt ${attempt}`));
    }
    return Promise.resolve();
  }
}

interface Harness {
  store: FakeStore;
  webhook: ScriptedWebhook;
  deadLetters: DeadLetterMessage[];
  handled: HandleResult[];
  sleeps: number[];
  processor: EventProcessor;
}

function setup(webhookFailures: number): Harness {
  const store = new FakeStore();
  const webhook = new ScriptedWebhook(webhookFailures);
  const deadLetters: DeadLetterMessage[] = [];
  const handled: HandleResult[] = [];
  const sleeps: number[] = [];
  const processor = new EventProcessor({
    store,
    webhook,
    deadLetters: {
      publish: (m) => {
        deadLetters.push(m);
        return Promise.resolve();
      },
    },
    observer: { handled: (r) => handled.push(r), attempt: () => undefined },
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    maxAttempts: 5,
    retryBaseMs: 200,
  });
  return { store, webhook, deadLetters, handled, sleeps, processor };
}

describe('EventProcessor (section 19, ADR-026)', () => {
  it('delivers on the first attempt and records DELIVERED once', async () => {
    const { store, processor, sleeps, deadLetters } = setup(0);
    expect(await processor.handle(message())).toBe('delivered');
    expect(store.outcomes.get('7')).toEqual({ outcome: 'DELIVERED', attempts: 1, lastError: null });
    expect(store.attempts).toEqual([{ eventId: '7', attempt: 1, ok: true }]);
    expect(sleeps).toEqual([]);
    expect(deadLetters).toEqual([]);
  });

  it('retries with exponential backoff and delivers on the third attempt', async () => {
    const { store, processor, sleeps } = setup(2);
    expect(await processor.handle(message())).toBe('delivered');
    expect(sleeps).toEqual([200, 400]);
    expect(store.attempts.map((a) => a.ok)).toEqual([false, false, true]);
    expect(store.outcomes.get('7')).toMatchObject({ outcome: 'DELIVERED', attempts: 3 });
  });

  it('dead-letters after 5 failed attempts, with the reason, then records DEAD_LETTERED', async () => {
    const { store, processor, sleeps, deadLetters, webhook } = setup(99);
    expect(await processor.handle(message())).toBe('dead_lettered');
    expect(webhook.calls).toBe(5);
    expect(sleeps).toEqual([200, 400, 800, 1600]);
    expect(deadLetters).toHaveLength(1);
    expect(deadLetters[0]).toMatchObject({
      key: TRANSFER,
      value: message().value,
      headers: { 'event-id': '7', 'dlq-reason': 'WEBHOOK_FAILED', attempts: '5', 'last-error': '503 on attempt 5' },
    });
    expect(store.outcomes.get('7')).toEqual({ outcome: 'DEAD_LETTERED', attempts: 5, lastError: '503 on attempt 5' });
  });

  it('a redelivered event is a duplicate: no webhook call, nothing recorded again', async () => {
    const { processor, webhook, handled } = setup(0);
    await processor.handle(message());
    expect(await processor.handle(message())).toBe('duplicate');
    expect(webhook.calls).toBe(1);
    expect(handled).toEqual(['delivered', 'duplicate']);
  });

  it('a consumer that loses the race to record is counted as the duplicate', async () => {
    const { store, processor } = setup(0);
    // Another consumer records the event between this one's dedupe check and its insert.
    const original = store.isProcessed.bind(store);
    store.isProcessed = async (id) => {
      const seen = await original(id);
      store.outcomes.set('7', { outcome: 'DELIVERED', attempts: 1, lastError: null });
      return seen;
    };
    expect(await processor.handle(message())).toBe('duplicate');
  });

  it.each([
    ['no event-id header', message('7', { headers: {} })],
    ['a value that is not JSON', message('7', { value: 'not json' })],
    ['a value whose event_id differs from the header', message('7', { headers: { 'event-id': '8' } })],
    ['a key that is not the transfer id', message('7', { key: 'someone-else' })],
  ])('%s goes straight to the dead-letter topic as INVALID_MESSAGE', async (_name, m) => {
    const { processor, webhook, deadLetters, store } = setup(0);
    expect(await processor.handle(m)).toBe('invalid');
    expect(webhook.calls).toBe(0);
    expect(deadLetters[0]?.headers['dlq-reason']).toBe('INVALID_MESSAGE');
    expect(store.outcomes.size).toBe(0);
  });

  it('a database error propagates (the offset is not committed) and the retry is safe', async () => {
    const { store, processor, webhook } = setup(0);
    store.failNextAttemptWrite = true;
    await expect(processor.handle(message())).rejects.toThrow('connection terminated');
    expect(store.outcomes.size).toBe(0);
    // Redelivered: processed normally, once.
    expect(await processor.handle(message())).toBe('delivered');
    expect(webhook.calls).toBe(2);
    expect(store.outcomes.get('7')).toMatchObject({ outcome: 'DELIVERED' });
  });
});
