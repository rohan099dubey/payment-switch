import type { Logger } from '@switch/common';
import type { Pool } from 'pg';
import type { Reconciler } from './domain/reconciler';
import {
  failRun,
  finishRun,
  getRun,
  lastScheduledTo,
  startRun,
  withRunLock,
  type RunRecord,
  type RunTrigger,
} from './repo/reconRepo';

export interface RunObserver {
  run: (result: 'ok' | 'failed', openBreaks: number | null) => void;
  breaksFound: (types: string[]) => void;
}

/**
 * One reconciliation run, scheduled or on demand (ADR-027): under the cluster-wide run lock,
 * recorded in `reconciliation_runs` with its outcome (or its error).
 */
export class ReconciliationRunner {
  constructor(
    private readonly pool: Pool,
    private readonly reconciler: Reconciler,
    private readonly logger: Logger,
    private readonly observer: RunObserver,
  ) {}

  async run(from: Date, to: Date, trigger: RunTrigger): Promise<RunRecord> {
    return withRunLock(this.pool, async () => {
      const id = await startRun(this.pool, from, to, trigger);
      try {
        const result = await this.reconciler.reconcile(from, to);
        await finishRun(this.pool, id, result);
        this.observer.run('ok', result.openBreaks);
        this.observer.breaksFound(result.found.map((b) => b.type));
        this.logger.info(
          {
            run_id: id,
            trigger,
            from: from.toISOString(),
            to: to.toISOString(),
            statement_lines: result.statementLines,
            journals: result.journals,
            breaks_opened: result.breaksOpened,
            breaks_resolved: result.breaksResolved,
            open_breaks: result.openBreaks,
          },
          'reconciliation run finished',
        );
      } catch (err) {
        await failRun(this.pool, id, err instanceof Error ? err.message : String(err));
        this.observer.run('failed', null);
        this.logger.warn({ err, run_id: id, trigger }, 'reconciliation run failed');
      }
      const record = await getRun(this.pool, id);
      if (record === null) throw new Error(`run ${id} disappeared`);
      return record;
    });
  }
}

export interface SchedulerConfig {
  intervalMs: number;
  settleMs: number;
  /** Where the very first scheduled run starts (ADR-027). */
  initialFrom: Date;
}

/**
 * The section 19 job: every `intervalMs`, reconcile from where the last scheduled run
 * stopped up to `now - settleMs`. No gaps, no double coverage; a failed run is retried
 * over the same window next time.
 */
export class Scheduler {
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<unknown> = Promise.resolve();
  private stopped = false;

  constructor(
    private readonly pool: Pool,
    private readonly runner: ReconciliationRunner,
    private readonly config: SchedulerConfig,
    private readonly logger: Logger,
  ) {}

  start(): void {
    this.stopped = false;
    this.schedule(this.config.intervalMs);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.running;
  }

  /** One scheduled tick; returns the run, or null when the window is still empty. */
  async tick(now = new Date()): Promise<RunRecord | null> {
    const from = (await lastScheduledTo(this.pool)) ?? this.config.initialFrom;
    const to = new Date(now.getTime() - this.config.settleMs);
    if (to <= from) return null;
    return this.runner.run(from, to, 'SCHEDULED');
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.running = this.tick()
        .catch((err: unknown) => {
          this.logger.error({ err }, 'scheduled reconciliation tick failed');
        })
        .finally(() => {
          this.schedule(this.config.intervalMs);
        });
    }, delayMs);
  }
}
