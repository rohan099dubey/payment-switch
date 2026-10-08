import { collectDefaultMetrics, Counter, type Registry } from 'prom-client';

export interface LedgerMetrics {
  journalsPosted: Counter<'kind' | 'replayed'>;
  /** Phase 2, item 5 (ADR-029). */
  balanceSnapshots: Counter<'result'>;
}

/** Ledger-specific metrics (spec section 17). `instrument()` adds the gRPC ones. */
export function createLedgerMetrics(registry: Registry): LedgerMetrics {
  collectDefaultMetrics({ register: registry });
  return {
    journalsPosted: new Counter({
      name: 'journals_posted_total',
      help: 'PostJournal calls that returned a journal, by kind and whether it was a replay',
      labelNames: ['kind', 'replayed'] as const,
      registers: [registry],
    }),
    balanceSnapshots: new Counter({
      name: 'balance_snapshots_total',
      help: 'Balance snapshot rounds, by result: created, up_to_date, lock_timeout or failed',
      labelNames: ['result'] as const,
      registers: [registry],
    }),
  };
}
