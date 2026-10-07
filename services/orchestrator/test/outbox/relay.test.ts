import { describe, expect, it } from 'vitest';
import { eventPayload, OutboxEventType, type EventMessage, type OutboxEvent } from '../../src/domain/outboxEvents';
import { TransferState } from '../../src/domain/states';
import { OutboxRelay, type EventPublisher, type OutboxStore, type RelayObserver } from '../../src/outbox/relay';
import { makeTransfer, silentLogger } from '../domain/fakes';

/**
 * The real `publishBatch` semantics: claim unpublished rows in id order, `send`, then mark.
 * A throwing `send` marks nothing (the transaction rolls back). `crashAfterSend` models
 * a process that dies after the broker acknowledged but before the commit.
 */
class FakeOutboxStore implements OutboxStore {
  readonly published = new Set<string>();
  crashAfterSend = 0;

  constructor(readonly events: OutboxEvent[]) {}

  async publishBatch(limit: number, send: (events: OutboxEvent[]) => Promise<void>): Promise<number> {
    const claimed = this.events.filter((e) => !this.published.has(e.id)).slice(0, limit);
    if (claimed.length === 0) return 0;
    await send(claimed);
    if (this.crashAfterSend > 0) {
      this.crashAfterSend--;
      throw new Error('process died before COMMIT');
    }
    for (const e of claimed) this.published.add(e.id);
    return claimed.length;
  }

  countUnpublished(): Promise<number> {
    return Promise.resolve(this.events.length - this.published.size);
  }
}

class FakePublisher implements EventPublisher {
  readonly sent: EventMessage[] = [];
  readyFailures = 0;
  publishFailures = 0;
  readyCalls = 0;

  ensureReady(): Promise<void> {
    this.readyCalls++;
    if (this.readyFailures > 0) {
      this.readyFailures--;
      return Promise.reject(new Error('broker unreachable'));
    }
    return Promise.resolve();
  }

  publish(messages: EventMessage[]): Promise<void> {
    if (this.publishFailures > 0) {
      this.publishFailures--;
      return Promise.reject(new Error('NOT_ENOUGH_REPLICAS'));
    }
    this.sent.push(...messages);
    return Promise.resolve();
  }
}

class RecordingRelayObserver implements RelayObserver {
  publishedCount = 0;
  failures = 0;
  lastUnpublished = -1;
  published(count: number): void {
    this.publishedCount += count;
  }
  failed(): void {
    this.failures++;
  }
  unpublished(count: number): void {
    this.lastUnpublished = count;
  }
}

function events(n: number): OutboxEvent[] {
  return Array.from({ length: n }, (_, i) => {
    const t = makeTransfer({
      id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
      state: TransferState.SUCCESS,
    });
    return { id: String(i + 1), aggregateId: t.id, eventType: OutboxEventType.SUCCEEDED, payload: eventPayload(t) };
  });
}

interface Harness {
  store: FakeOutboxStore;
  publisher: FakePublisher;
  observer: RecordingRelayObserver;
  relay: OutboxRelay;
}

function setup(n: number, config: Partial<{ pollMs: number; batch: number; maxBackoffMs: number }> = {}): Harness {
  const store = new FakeOutboxStore(events(n));
  const publisher = new FakePublisher();
  const observer = new RecordingRelayObserver();
  const relay = new OutboxRelay({
    store,
    publisher,
    config: { pollMs: 5, batch: 100, maxBackoffMs: 40, ...config },
    logger: silentLogger,
    observer,
  });
  return { store, publisher, observer, relay };
}

async function until(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

describe('OutboxRelay.runOnce (section 19)', () => {
  it('publishes the oldest unpublished events in id order, keyed by transfer id, then marks them', async () => {
    const { store, publisher, observer, relay } = setup(3);
    expect(await relay.runOnce()).toBe(3);
    expect(publisher.sent.map((m) => m.headers['event-id'])).toEqual(['1', '2', '3']);
    expect(publisher.sent.map((m) => m.key)).toEqual(store.events.map((e) => e.aggregateId));
    expect(store.published.size).toBe(3);
    expect(observer.publishedCount).toBe(3);
  });

  it('takes at most one batch (the spec LIMIT 100) per iteration', async () => {
    const { store, relay } = setup(250);
    expect(await relay.runOnce()).toBe(100);
    expect(await relay.runOnce()).toBe(100);
    expect(await relay.runOnce()).toBe(50);
    expect(await relay.runOnce()).toBe(0);
    expect(store.published.size).toBe(250);
  });

  it('a broker that is not ready claims nothing', async () => {
    const { store, publisher, relay } = setup(3);
    publisher.readyFailures = 1;
    await expect(relay.runOnce()).rejects.toThrow('broker unreachable');
    expect(publisher.sent).toHaveLength(0);
    expect(store.published.size).toBe(0);
  });

  it('a failed send leaves every event unpublished (the transaction rolls back)', async () => {
    const { store, publisher, observer, relay } = setup(3);
    publisher.publishFailures = 1;
    await expect(relay.runOnce()).rejects.toThrow('NOT_ENOUGH_REPLICAS');
    expect(store.published.size).toBe(0);
    expect(observer.publishedCount).toBe(0);
    expect(await relay.runOnce()).toBe(3);
  });

  it('at-least-once: a crash after the ack republishes the batch with the same event ids', async () => {
    const { store, publisher, relay } = setup(2);
    store.crashAfterSend = 1;
    await expect(relay.runOnce()).rejects.toThrow('before COMMIT');
    expect(await relay.runOnce()).toBe(2);
    const ids = publisher.sent.map((m) => m.headers['event-id']);
    expect(ids).toEqual(['1', '2', '1', '2']);
    // A consumer deduplicating by event id sees each event once.
    expect(new Set(ids).size).toBe(2);
  });
});

describe('OutboxRelay pacing', () => {
  it('drains without sleeping while batches are full, otherwise waits OUTBOX_POLL_MS', () => {
    const { relay } = setup(0, { pollMs: 500, batch: 100 });
    expect(relay.nextDelayMs(100)).toBe(0);
    expect(relay.nextDelayMs(99)).toBe(500);
    expect(relay.nextDelayMs(0)).toBe(500);
  });

  it('backs off exponentially after failures, up to the ceiling, and resets after a success', async () => {
    const { publisher, observer, relay, store } = setup(5, { pollMs: 2, maxBackoffMs: 16 });
    publisher.readyFailures = 6;
    relay.start();
    await until(() => store.published.size === 5);
    await relay.stop(1000);
    expect(observer.failures).toBe(6);
    expect(observer.lastUnpublished).toBe(0);
    expect(relay.nextDelayMs(null)).toBe(2); // failures reset to 0 after the success: 2 * 2^0
  });

  it('stop() ends the loop: nothing is published afterwards', async () => {
    const { store, publisher, relay } = setup(1, { pollMs: 2 });
    relay.start();
    await until(() => store.published.size === 1);
    await relay.stop(1000);
    const sent = publisher.sent.length;
    store.events.push(...events(2).map((e) => ({ ...e, id: `x${e.id}` })));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(publisher.sent.length).toBe(sent);
  });
});
