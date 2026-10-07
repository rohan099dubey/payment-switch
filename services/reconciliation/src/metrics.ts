import { collectDefaultMetrics, Counter, Gauge, type Registry } from 'prom-client';
import type { RunObserver } from './runner';

export interface ReconciliationMetrics {
  /** `result`: ok, failed. */
  runs: Counter<'result'>;
  /** Breaks seen per run, by `type`. A break still open is counted again each run. */
  breaksSeen: Counter<'type'>;
  /** Open breaks after the latest successful run. */
  openBreaks: Gauge;
}

/** ADR-027. */
export function createReconciliationMetrics(registry: Registry): ReconciliationMetrics {
  collectDefaultMetrics({ register: registry });
  return {
    runs: new Counter({
      name: 'reconciliation_runs_total',
      help: 'Reconciliation runs, by result',
      labelNames: ['result'] as const,
      registers: [registry],
    }),
    breaksSeen: new Counter({
      name: 'reconciliation_breaks_seen_total',
      help: 'Breaks seen by reconciliation runs, by type',
      labelNames: ['type'] as const,
      registers: [registry],
    }),
    openBreaks: new Gauge({
      name: 'reconciliation_open_breaks',
      help: 'Open reconciliation breaks after the latest successful run',
      registers: [registry],
    }),
  };
}

export function runObserver(metrics: ReconciliationMetrics): RunObserver {
  return {
    run: (result, openBreaks) => {
      metrics.runs.inc({ result });
      if (openBreaks !== null) metrics.openBreaks.set(openBreaks);
    },
    breaksFound: (types) => {
      for (const type of types) metrics.breaksSeen.inc({ type });
    },
  };
}
