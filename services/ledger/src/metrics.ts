import { collectDefaultMetrics, Counter, type Registry } from 'prom-client';

export interface LedgerMetrics {
  journalsPosted: Counter<'kind' | 'replayed'>;
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
  };
}
