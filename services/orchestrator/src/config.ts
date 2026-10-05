import { hostname } from 'node:os';
import { loadConfig } from '@switch/common';
import { z } from 'zod';

const port = (fallback: number): z.ZodDefault<z.ZodCoercedNumber> =>
  z.coerce.number().int().min(1).max(65535).default(fallback);
const positiveInt = (fallback: number): z.ZodDefault<z.ZodCoercedNumber> =>
  z.coerce.number().int().positive().default(fallback);
const nonNegativeInt = (fallback: number): z.ZodDefault<z.ZodCoercedNumber> =>
  z.coerce.number().int().min(0).default(fallback);

const BANK_ID = /^[a-z][a-z0-9_]*$/;
const ADDRESS = /^[A-Za-z0-9.-]+:\d{1,5}$/;

/**
 * Parses `BANK_ENDPOINTS` (`bank_a=bank-a:50061,bank_b=bank-b:50062`) into a map from
 * `bank_id` to gRPC address. Rejects duplicates, malformed ids and malformed addresses.
 */
export function parseBankEndpoints(value: string, ctx: z.RefinementCtx): ReadonlyMap<string, string> {
  const endpoints = new Map<string, string>();
  for (const entry of value.split(',').map((part) => part.trim())) {
    const [bankId, address, ...rest] = entry.split('=');
    if (bankId === undefined || address === undefined || rest.length > 0) {
      ctx.addIssue({ code: 'custom', message: `entry "${entry}" is not bank_id=host:port` });
      continue;
    }
    if (!BANK_ID.test(bankId)) {
      ctx.addIssue({ code: 'custom', message: `bank id "${bankId}" must be lower_snake_case` });
    } else if (!ADDRESS.test(address)) {
      ctx.addIssue({ code: 'custom', message: `address "${address}" for ${bankId} must be host:port` });
    } else if (endpoints.has(bankId)) {
      ctx.addIssue({ code: 'custom', message: `bank id "${bankId}" is listed twice` });
    } else {
      endpoints.set(bankId, address);
    }
  }
  return endpoints;
}

/**
 * Spec section 15, Orchestrator block. `ORCHESTRATOR_TIMEOUT_MS` is the Gateway's
 * deadline; it is read here only to enforce section 14's startup constraint
 * "`SAGA_INLINE_BUDGET_MS` is smaller than `ORCHESTRATOR_TIMEOUT_MS`". The recovery
 * settings are parsed now and used from M6.
 */
export const orchestratorConfigSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    GRPC_PORT: port(50051),
    HTTP_PORT: port(9101),
    DATABASE_URL: z.string().min(1).default('postgres://orch:orch@postgres-orchestrator:5432/orchestrator_db'),
    BANK_ENDPOINTS: z.string().min(1).default('bank_a=bank-a:50061,bank_b=bank-b:50062').transform(parseBankEndpoints),
    LEDGER_ADDR: z.string().regex(ADDRESS, 'LEDGER_ADDR must be host:port').default('ledger:50052'),
    MAX_TRANSFER_AMOUNT: z.coerce.bigint().positive().default(10_000_000n),
    BANK_CALL_TIMEOUT_MS: positiveInt(2000),
    LEDGER_CALL_TIMEOUT_MS: positiveInt(2000),
    INLINE_BANK_RETRIES: nonNegativeInt(2),
    INLINE_LEDGER_RETRIES: nonNegativeInt(2),
    SAGA_INLINE_BUDGET_MS: positiveInt(8000),
    ORCHESTRATOR_TIMEOUT_MS: positiveInt(10_000),
    REPLAY_WAIT_MS: nonNegativeInt(2000),
    LEASE_MS: positiveInt(15_000),
    RECOVERY_POLL_MS: positiveInt(1000),
    RECOVERY_BATCH: positiveInt(20),
    RECOVERY_CONCURRENCY: positiveInt(5),
    RESOLVE_AFTER_ATTEMPTS: positiveInt(3),
    MAX_RECOVERY_ATTEMPTS: positiveInt(20),
    // Empty (as in .env.example) means "use the container hostname".
    INSTANCE_ID: z
      .string()
      .default('')
      .transform((value) => (value.trim() === '' ? hostname() : value.trim())),
  })
  .refine((c) => c.SAGA_INLINE_BUDGET_MS < c.ORCHESTRATOR_TIMEOUT_MS, {
    message: 'SAGA_INLINE_BUDGET_MS must be smaller than ORCHESTRATOR_TIMEOUT_MS',
    path: ['SAGA_INLINE_BUDGET_MS'],
  })
  .refine((c) => c.REPLAY_WAIT_MS < c.ORCHESTRATOR_TIMEOUT_MS, {
    message: 'REPLAY_WAIT_MS must be smaller than ORCHESTRATOR_TIMEOUT_MS',
    path: ['REPLAY_WAIT_MS'],
  })
  .refine((c) => c.LEASE_MS > c.SAGA_INLINE_BUDGET_MS, {
    message: 'LEASE_MS must be larger than SAGA_INLINE_BUDGET_MS, or an inline saga can outlive its lease',
    path: ['LEASE_MS'],
  });

export type OrchestratorConfig = z.output<typeof orchestratorConfigSchema>;

export function loadOrchestratorConfig(env: NodeJS.ProcessEnv = process.env): OrchestratorConfig {
  return loadConfig(orchestratorConfigSchema, env);
}
