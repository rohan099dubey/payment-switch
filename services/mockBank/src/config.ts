import { loadConfig } from '@switch/common';
import { z } from 'zod';
import type { ChaosSettings } from './chaos/chaos';

const port = z.coerce.number().int().min(1).max(65535);
const nonNegativeInt = (fallback: number): z.ZodDefault<z.ZodCoercedNumber> =>
  z.coerce.number().int().min(0).default(fallback);
const rate = z.coerce.number().min(0).max(1).default(0);

/**
 * Spec section 15, Mock Bank block. BANK_ID, ports and DATABASE_URL differ per instance,
 * so they are required rather than defaulted to one instance's values.
 * BANK_CALL_TIMEOUT_MS is the Orchestrator's deadline; the bank reads it only to enforce
 * "slow_ms is larger than BANK_CALL_TIMEOUT_MS" at startup (section 14).
 */
export const bankConfigSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    BANK_ID: z.string().regex(/^[a-z][a-z0-9_]*$/, 'BANK_ID must be lower_snake_case, e.g. bank_a'),
    GRPC_PORT: port,
    HTTP_PORT: port,
    DATABASE_URL: z.string().min(1),
    BANK_CALL_TIMEOUT_MS: z.coerce.number().int().positive().default(2000),
    CHAOS_SEED: nonNegativeInt(42).pipe(z.number().max(0xffffffff)),
    CHAOS_DOWN: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),
    CHAOS_LATENCY_MIN_MS: nonNegativeInt(0),
    CHAOS_LATENCY_MAX_MS: nonNegativeInt(0),
    CHAOS_REJECT_RATE: rate,
    CHAOS_LATE_APPLY_RATE: rate,
    CHAOS_LOST_RESPONSE_RATE: rate,
    CHAOS_SLOW_MS: nonNegativeInt(3000),
  })
  .refine((c) => c.CHAOS_SLOW_MS > c.BANK_CALL_TIMEOUT_MS, {
    message: 'CHAOS_SLOW_MS must be larger than BANK_CALL_TIMEOUT_MS',
    path: ['CHAOS_SLOW_MS'],
  })
  .refine((c) => c.CHAOS_REJECT_RATE + c.CHAOS_LATE_APPLY_RATE + c.CHAOS_LOST_RESPONSE_RATE <= 1 + 1e-9, {
    message: 'CHAOS_REJECT_RATE + CHAOS_LATE_APPLY_RATE + CHAOS_LOST_RESPONSE_RATE must be <= 1',
    path: ['CHAOS_REJECT_RATE'],
  })
  .refine((c) => c.CHAOS_LATENCY_MIN_MS <= c.CHAOS_LATENCY_MAX_MS, {
    message: 'CHAOS_LATENCY_MIN_MS must be <= CHAOS_LATENCY_MAX_MS',
    path: ['CHAOS_LATENCY_MIN_MS'],
  });

export type BankConfig = z.output<typeof bankConfigSchema>;

export function loadBankConfig(env: NodeJS.ProcessEnv = process.env): BankConfig {
  return loadConfig(bankConfigSchema, env);
}

export function chaosSettingsFromConfig(config: BankConfig): ChaosSettings {
  return {
    down: config.CHAOS_DOWN,
    latencyMinMs: config.CHAOS_LATENCY_MIN_MS,
    latencyMaxMs: config.CHAOS_LATENCY_MAX_MS,
    rejectRate: config.CHAOS_REJECT_RATE,
    lateApplyRate: config.CHAOS_LATE_APPLY_RATE,
    lostResponseRate: config.CHAOS_LOST_RESPONSE_RATE,
    slowMs: config.CHAOS_SLOW_MS,
    seed: config.CHAOS_SEED,
  };
}
