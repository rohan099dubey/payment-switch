import type { Logger } from '@switch/common';
import { toMessage, type EventMessage, type OutboxEvent } from '../domain/outboxEvents';

/** What the relay needs from `repo/outboxRepo.ts`. */
export interface OutboxStore {
  /**
   * In one transaction: claim up to `limit` unpublished rows (`FOR UPDATE SKIP LOCKED`),
   * `send` them, mark them published. A throwing `send` rolls back. Returns the count.
   */
  publishBatch: (limit: number, send: (events: OutboxEvent[]) => Promise<void>) => Promise<number>;
  countUnpublished: () => Promise<number>;
}

/** The broker side, so the relay has no Kafka dependency and tests can use a fake. */
export interface EventPublisher {
  /** Connects and makes sure the topic exists. Idempotent; called before every batch. */
  ensureReady: () => Promise<void>;
  /** Resolves only once the broker acknowledged every message (`acks=all`). */
  publish: (messages: EventMessage[]) => Promise<void>;
}

export interface RelayObserver {
  published: (count: number) => void;
  failed: () => void;
  unpublished: (count: number) => void;
}

export interface RelayConfig {
  /** `OUTBOX_POLL_MS`: the sleep when the last batch was not full. */
  pollMs: number;
  /** The spec's `LIMIT 100`. */
  batch: number;
  /** Ceiling of the exponential backoff after failures. */
  maxBackoffMs: number;
}

export interface RelayDeps {
  store: OutboxStore;
  publisher: EventPublisher;
  config: RelayConfig;
  logger: Logger;
  observer: RelayObserver;
}

/**
 * The outbox relay (section 19, ADR-025). Runs in every Orchestrator instance: `SKIP
 * LOCKED` keeps instances from claiming the same rows. Delivery is at-least-once: a crash
 * between the broker's acknowledgement and the commit republishes that batch, and
 * consumers deduplicate by event id. A broker outage only delays events: they wait in the
 * outbox, and the relay backs off.
 */
export class OutboxRelay {
  private running: Promise<void> | undefined;
  private stopping = false;
  private wake: (() => void) | undefined;
  private failures = 0;

  constructor(private readonly deps: RelayDeps) {}

  start(): void {
    if (this.running !== undefined) return;
    this.stopping = false;
    this.running = this.loop();
  }

  /** Stops claiming, then waits up to `graceMs` for the batch in progress. */
  async stop(graceMs: number): Promise<void> {
    this.stopping = true;
    this.wake?.();
    if (this.running === undefined) return;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      this.running,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, graceMs);
      }),
    ]);
    clearTimeout(timer);
  }

  /** One batch: make sure the broker is ready, then claim, publish and mark. Throws on failure. */
  async runOnce(): Promise<number> {
    const { store, publisher, config, observer } = this.deps;
    await publisher.ensureReady();
    const published = await store.publishBatch(config.batch, (events) => publisher.publish(events.map(toMessage)));
    if (published > 0) observer.published(published);
    return published;
  }

  /** The sleep before the next iteration: none while draining, exponential after failures. */
  nextDelayMs(published: number | null): number {
    const { pollMs, batch, maxBackoffMs } = this.deps.config;
    if (published === null) return Math.min(pollMs * 2 ** this.failures, maxBackoffMs);
    return published >= batch ? 0 : pollMs;
  }

  private isStopping(): boolean {
    return this.stopping;
  }

  private async loop(): Promise<void> {
    const { store, observer, logger } = this.deps;
    while (!this.isStopping()) {
      let published: number | null;
      try {
        published = await this.runOnce();
        if (this.failures > 0) logger.info({ after_failures: this.failures }, 'outbox relay recovered');
        this.failures = 0;
      } catch (err) {
        published = null;
        this.failures++;
        observer.failed();
        logger.warn({ err, failures: this.failures }, 'outbox relay could not publish; events stay in the outbox');
      }
      try {
        observer.unpublished(await store.countUnpublished());
      } catch (err) {
        logger.warn({ err }, 'could not count unpublished outbox rows');
      }
      if (this.isStopping()) break;
      const delay = this.nextDelayMs(published);
      if (delay === 0) continue;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, delay);
        this.wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      this.wake = undefined;
    }
  }
}
