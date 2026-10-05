import { loadConfig } from '@switch/common';
import { z } from 'zod';

const port = (fallback: number): z.ZodDefault<z.ZodCoercedNumber> =>
  z.coerce.number().int().min(1).max(65535).default(fallback);

/** Spec section 15, Ledger block, plus the variables common to all services. */
export const ledgerConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  GRPC_PORT: port(50052),
  HTTP_PORT: port(9102),
  DATABASE_URL: z.string().min(1).default('postgres://ledger:ledger@postgres-ledger:5432/ledger_db'),
});

export type LedgerConfig = z.output<typeof ledgerConfigSchema>;

export function loadLedgerConfig(env: NodeJS.ProcessEnv = process.env): LedgerConfig {
  return loadConfig(ledgerConfigSchema, env);
}
