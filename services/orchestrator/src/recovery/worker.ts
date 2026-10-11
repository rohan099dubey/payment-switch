import { randomUUID } from 'node:crypto';
import type { Logger } from '@switch/common';
import type { SagaEngine } from '../domain/saga';
import { isTerminal, TransferState } from '../domain/states';
import type { Transfer } from '../domain/transfer';

/** `recovery_runs_total{result}` values (section 17). */
export type RecoveryResult = 'advanced' | 'yielded' | 'resolved_applied' | 'resolved_voided' | 'exhausted';

export type RecoveryAction = 'exhaust' | 'resolve' | 'advance';

export interface RecoveryConfig {
  pollMs: number;
  batch: number;
  concurrency: number;
  leaseMs: number;
  resolveAfterAttempts: number;
  maxRecoveryAttempts: number;
}

/** The persistence the worker needs beyond the saga's own store. */
export interface RecoveryStore {
  claimDue: (leaseOwner: string, leaseMs: number, limit: number) => Promise<Transfer[]>;
  renewLease: (id: string, leaseOwner: string, leaseMs: number) => Promise<Transfer | null>;
  countInFlight: () => Promise<Map<TransferState, number>>;
}

export interface RecoveryObserver {
  run: (result: RecoveryResult) => void;
  inFlight: (counts: Map<TransferState, number>) => void;
}

export interface RecoveryDeps {
  store: RecoveryStore;
  saga: SagaEngine;
  config: RecoveryConfig;
  instanceId: string;
  logger: Logger;
  observer: RecoveryObserver;
}

/**
 * What recovery does with a claimed transfer (section 6, recovery worker steps 2 and 3).
 * Exhaustion is checked first, in every state. Only `*_SENT` is ever settled with
 * `Resolve`: `REVERSING` is never resolved by voiding, it is retried until it works.
 */
export function recoveryAction(t: Transfer, config: RecoveryConfig): RecoveryAction {
  if (t.attempts >= config.maxRecoveryAttempts) return 'exhaust';
  const sent = t.state === TransferState.DEBIT_SENT || t.state === TransferState.CREDIT_SENT;
  if (sent && t.attempts >= config.resolveAfterAttempts) return 'resolve';
  return 'advance';
}

/**
 * The recovery loop that runs in every Orchestrator instance. Every `RECOVERY_POLL_MS`
 * it claims up to `RECOVERY_BATCH` due transfers whose lease is free or expired (section
 * 13 claim query, `FOR UPDATE SKIP LOCKED`), drives up to `RECOVERY_CONCURRENCY` at a
 * time, and refreshes `transfers_in_flight`. Correctness never depends on it running
 * alone: the claim skips locked rows, and every write is a CAS on the lease.
 */
export class RecoveryWorker {
  private running: Promise<void> | undefined;
  private stopping = false;
  private wake: (() => void) | undefined;

  constructor(private readonly deps: RecoveryDeps) {}

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

  private isStopping(): boolean {
    return this.stopping;
  }

  private async loop(): Promise<void> {
    // A method, not the field: the flag flips across awaits, which flow analysis cannot see.
    while (!this.isStopping()) {
      try {
        await this.runOnce();
      } catch (err) {
        this.deps.logger.error({ err }, 'recovery loop iteration failed');
      }
      if (this.isStopping()) break;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, this.deps.config.pollMs);
        this.wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      this.wake = undefined;
    }
  }

  /** One iteration: claim, drive, refresh the gauge. Returns each transfer's result. */
  async runOnce(): Promise<RecoveryResult[]> {
    const { store, config, observer, logger } = this.deps;
    // One lease token per claim, with this instance's id in it (section 13).
    const leaseOwner = `${this.deps.instanceId}:recovery:${randomUUID()}`;
    const claimed = await store.claimDue(leaseOwner, config.leaseMs, config.batch);
    if (claimed.length > 0) logger.info({ claimed: claimed.length }, 'recovery claimed transfers');

    const results: RecoveryResult[] = [];
    let next = 0;
    const lanes = Array.from({ length: Math.min(config.concurrency, claimed.length) }, async () => {
      while (next < claimed.length) {
        const t = claimed[next++];
        if (t === undefined) break;
        const result = await this.recoverOne(t, leaseOwner);
        if (result !== null) {
          results.push(result);
          observer.run(result);
        }
      }
    });
    await Promise.all(lanes);

    observer.inFlight(await store.countInFlight());
    return results;
  }

  /**
   * Drives one claimed transfer. Null: skipped (lease lapsed) or failed unexpectedly. An
   * unexpected error inside the drive is already a yield with backoff (`SagaEngine`,
   * ADR-031), so it is reported as `yielded`.
   */
  private async recoverOne(claimed: Transfer, leaseOwner: string): Promise<RecoveryResult | null> {
    const { store, saga, config } = this.deps;
    const logger = this.deps.logger.child({ transfer_id: claimed.id });
    try {
      // A late item in the batch may have waited past its lease: drive it only if still ours.
      const t = await store.renewLease(claimed.id, leaseOwner, config.leaseMs);
      if (t === null) {
        logger.info('lease lapsed before recovery reached it; skipped');
        return null;
      }
      const ctx = { mode: 'recovery' as const, leaseOwner };
      const action = recoveryAction(t, config);
      logger.info({ state: t.state, attempts: t.attempts, action }, 'recovering transfer');

      switch (action) {
        case 'exhaust': {
          const after = await saga.exhaust(t, ctx);
          // Not escalated: lost to another driver, or the write failed and the saga yielded.
          return after.state === TransferState.NEEDS_MANUAL_REVIEW ? 'exhausted' : 'yielded';
        }
        case 'resolve': {
          const settled = await saga.settle(t, ctx);
          if (settled.resolution === 'APPLIED') return 'resolved_applied';
          if (settled.resolution === 'VOIDED') return 'resolved_voided';
          return progressed(t, settled.transfer) ? 'advanced' : 'yielded';
        }
        case 'advance':
          return progressed(t, await saga.advance(t, ctx)) ? 'advanced' : 'yielded';
      }
    } catch (err) {
      // Even the saga's yield failed, or renewing the lease did: the database is likely
      // unreachable. The lease is kept on purpose: it expires after LEASE_MS, and that is
      // the backoff. Releasing it would let the next poll retry at once (ADR-031).
      logger.error({ err }, 'recovery of transfer failed; its lease will expire');
      return null;
    }
  }
}

/** `advanced` when the transfer reached a terminal state or changed state; else it yielded. */
function progressed(before: Transfer, after: Transfer): boolean {
  return isTerminal(after.state) || after.state !== before.state;
}
