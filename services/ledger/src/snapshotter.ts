import type { Logger } from '@switch/common';
import type { SnapshotOutcome } from './repo/snapshotRepo';

export interface SnapshotterDeps {
  createSnapshot: () => Promise<SnapshotOutcome>;
  logger: Logger;
  /** Counts each round by result: created, up_to_date, lock_timeout or failed. */
  observe: (result: SnapshotOutcome['result'] | 'failed') => void;
  /** `SNAPSHOT_INTERVAL_MS`: the pause between the end of one round and the next. */
  intervalMs: number;
}

/**
 * Phase 2, item 5 (ADR-029): appends a balance snapshot every `intervalMs` in every Ledger
 * instance. Rounds never overlap within a process, and the repository makes rounds in
 * different instances harmless. A failed round is logged and retried on the next tick: a
 * missing snapshot only makes reads slower, never wrong.
 */
export class Snapshotter {
  private timer: NodeJS.Timeout | undefined;
  private current: Promise<void> = Promise.resolve();
  private stopped = false;

  constructor(private readonly deps: SnapshotterDeps) {}

  start(): void {
    this.schedule();
  }

  /** One round, now. Also used by `start`'s timer. */
  async runOnce(): Promise<void> {
    try {
      const outcome = await this.deps.createSnapshot();
      this.deps.observe(outcome.result);
      if (outcome.result === 'created') {
        this.deps.logger.info(
          {
            snapshot_id: outcome.snapshotId.toString(),
            last_entry_id: outcome.lastEntryId.toString(),
            entries_added: outcome.entriesAdded.toString(),
          },
          'balance snapshot created',
        );
      } else if (outcome.result === 'lock_timeout') {
        this.deps.logger.warn('balance snapshot skipped: postings held the entries lock past the timeout');
      }
    } catch (err) {
      this.deps.observe('failed');
      this.deps.logger.warn({ err }, 'balance snapshot failed');
    }
  }

  /** Stops scheduling and waits for a round in progress. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    await this.current;
  }

  private schedule(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.current = this.runOnce().then(() => {
        this.schedule();
      });
    }, this.deps.intervalMs);
  }
}
