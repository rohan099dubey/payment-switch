import { collectDefaultMetrics, Counter, Gauge, Histogram, type Registry } from 'prom-client';
import type { SagaObserver } from './domain/saga';
import { TransferState } from './domain/states';
import type { RecoveryObserver } from './recovery/worker';

export interface OrchestratorMetrics {
  transfersTotal: Counter<'final_state'>;
  transferDuration: Histogram<'final_state'>;
  /** `step`: debit, credit, reverse, ledger. */
  sagaStepDuration: Histogram<'step'>;
  /** `target`: bank, ledger. `outcome`: ok, definite, unknown, bug. One per attempt. */
  downstreamCalls: Counter<'target' | 'operation' | 'outcome'>;
  /** The alert metric for scenario 14. `reason` is the failure code. */
  manualReview: Counter<'reason'>;
  /** `result`: advanced, yielded, resolved_applied, resolved_voided, exhausted. */
  recoveryRuns: Counter<'result'>;
  /** Non-terminal transfers by state, refreshed every recovery loop. */
  transfersInFlight: Gauge<'state'>;
}

/** Orchestrator metrics from spec section 17. */
export function createOrchestratorMetrics(registry: Registry): OrchestratorMetrics {
  collectDefaultMetrics({ register: registry });
  return {
    transfersTotal: new Counter({
      name: 'transfers_total',
      help: 'Transfers that reached a terminal state, by final state',
      labelNames: ['final_state'] as const,
      registers: [registry],
    }),
    transferDuration: new Histogram({
      name: 'transfer_duration_seconds',
      help: 'Time from creation to a terminal state, by final state',
      labelNames: ['final_state'] as const,
      buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 300],
      registers: [registry],
    }),
    sagaStepDuration: new Histogram({
      name: 'saga_step_duration_seconds',
      help: 'Duration of one saga step including inline retries, by step',
      labelNames: ['step'] as const,
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 4, 8],
      registers: [registry],
    }),
    downstreamCalls: new Counter({
      name: 'downstream_calls_total',
      help: 'Calls to banks and the Ledger, one per attempt, by target, operation and classified outcome',
      labelNames: ['target', 'operation', 'outcome'] as const,
      registers: [registry],
    }),
    manualReview: new Counter({
      name: 'manual_review_total',
      help: 'Transfers moved to NEEDS_MANUAL_REVIEW, by reason',
      labelNames: ['reason'] as const,
      registers: [registry],
    }),
    recoveryRuns: new Counter({
      name: 'recovery_runs_total',
      help: 'Transfers driven by the recovery worker, by result',
      labelNames: ['result'] as const,
      registers: [registry],
    }),
    transfersInFlight: new Gauge({
      name: 'transfers_in_flight',
      help: 'Non-terminal transfers by state, refreshed every recovery loop',
      labelNames: ['state'] as const,
      registers: [registry],
    }),
  };
}

export function sagaObserver(metrics: OrchestratorMetrics): SagaObserver {
  return {
    downstreamCall: (target, operation, outcome) => {
      metrics.downstreamCalls.inc({ target, operation, outcome });
    },
    stepDuration: (step, seconds) => {
      metrics.sagaStepDuration.observe({ step }, seconds);
    },
    terminal: (transfer, seconds) => {
      metrics.transfersTotal.inc({ final_state: transfer.state });
      metrics.transferDuration.observe({ final_state: transfer.state }, seconds);
      if (transfer.state === TransferState.NEEDS_MANUAL_REVIEW) {
        metrics.manualReview.inc({ reason: transfer.failureCode ?? 'UNKNOWN' });
      }
    },
  };
}

export function recoveryObserver(metrics: OrchestratorMetrics): RecoveryObserver {
  return {
    run: (result) => {
      metrics.recoveryRuns.inc({ result });
    },
    inFlight: (counts) => {
      for (const [state, n] of counts) metrics.transfersInFlight.set({ state }, n);
    },
  };
}
