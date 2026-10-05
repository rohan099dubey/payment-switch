import { collectDefaultMetrics, Counter, type Registry } from 'prom-client';

export interface BankMetrics {
  /** `operation`: DEBIT, CREDIT, REVERSE_DEBIT, RESOLVE. `result`: APPLIED, REPLAYED, VOIDED or the error code. */
  bankOperations: Counter<'operation' | 'result'>;
  /** `mode`: down, reject, late_apply, lost_response, latency. */
  chaosInjected: Counter<'mode'>;
}

/** Mock Bank metrics (spec section 17). `instrument()` adds the gRPC ones. */
export function createBankMetrics(registry: Registry): BankMetrics {
  collectDefaultMetrics({ register: registry });
  return {
    bankOperations: new Counter({
      name: 'bank_operations_total',
      help: 'Money operations and Resolve calls that reached the database, by operation and result',
      labelNames: ['operation', 'result'] as const,
      registers: [registry],
    }),
    chaosInjected: new Counter({
      name: 'chaos_injected_total',
      help: 'Failures and delays injected by the chaos engine, by mode',
      labelNames: ['mode'] as const,
      registers: [registry],
    }),
  };
}
