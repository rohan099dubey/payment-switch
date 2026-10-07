import { loadConfig } from '@switch/common';
import { z } from 'zod';

const ADDRESS = /^[A-Za-z0-9.-]+:\d{1,5}$/;
const BANK_ID = /^[a-z][a-z0-9_]*$/;

const port = (fallback: number): z.ZodDefault<z.ZodCoercedNumber> =>
  z.coerce.number().int().min(1).max(65535).default(fallback);

/** `BANK_ENDPOINTS` as the Orchestrator reads it: `bank_a=bank-a:50061,bank_b=bank-b:50062`. */
export function parseBankEndpoints(value: string, ctx: z.RefinementCtx): ReadonlyMap<string, string> {
  const endpoints = new Map<string, string>();
  for (const entry of value.split(',').map((part) => part.trim())) {
    const [bankId, address, ...rest] = entry.split('=');
    if (
      bankId === undefined ||
      address === undefined ||
      rest.length > 0 ||
      !BANK_ID.test(bankId) ||
      !ADDRESS.test(address)
    ) {
      ctx.addIssue({ code: 'custom', message: `entry "${entry}" is not bank_id=host:port` });
    } else if (endpoints.has(bankId)) {
      ctx.addIssue({ code: 'custom', message: `bank id "${bankId}" is listed twice` });
    } else {
      endpoints.set(bankId, address);
    }
  }
  return endpoints;
}

/** Phase 2, item 3 (section 19, ADR-027). */
export const reconciliationConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  GRPC_PORT: port(50053),
  HTTP_PORT: port(9104),
  DATABASE_URL: z
    .string()
    .min(1)
    .default('postgres://reconciliation:reconciliation@postgres-reconciliation:5432/reconciliation_db'),
  BANK_ENDPOINTS: z.string().min(1).default('bank_a=bank-a:50061,bank_b=bank-b:50062').transform(parseBankEndpoints),
  LEDGER_ADDR: z.string().regex(ADDRESS, 'LEDGER_ADDR must be host:port').default('ledger:50052'),
  /** Section 19: "default every 5 minutes". */
  RECON_INTERVAL_MS: z.coerce.number().int().positive().default(300_000),
  /** A run never reaches closer than this to now, so in-flight legs settle first. */
  RECON_SETTLE_MS: z.coerce.number().int().min(0).default(120_000),
  /** Where the very first scheduled run starts; empty means the service's first start. */
  RECON_INITIAL_FROM: z
    .string()
    .default('')
    .refine((v) => v === '' || !Number.isNaN(Date.parse(v)), 'RECON_INITIAL_FROM must be an ISO timestamp'),
  RECON_LOOKUP_CONCURRENCY: z.coerce.number().int().positive().default(16),
});

export type ReconciliationConfig = z.output<typeof reconciliationConfigSchema>;

export function loadReconciliationConfig(env: NodeJS.ProcessEnv = process.env): ReconciliationConfig {
  return loadConfig(reconciliationConfigSchema, env);
}
