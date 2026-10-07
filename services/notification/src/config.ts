import { loadConfig } from '@switch/common';
import { z } from 'zod';

const ADDRESS = /^[A-Za-z0-9.-]+:\d{1,5}$/;

/** `KAFKA_BROKERS`: a comma-separated host:port list. */
export function parseBrokers(value: string, ctx: z.RefinementCtx): string[] {
  const brokers = value.split(',').map((part) => part.trim());
  for (const broker of brokers) {
    if (!ADDRESS.test(broker)) ctx.addIssue({ code: 'custom', message: `broker "${broker}" must be host:port` });
  }
  return brokers;
}

/** Phase 2, item 2 (section 19, ADR-026). */
export const notificationConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  HTTP_PORT: z.coerce.number().int().min(1).max(65535).default(9103),
  DATABASE_URL: z
    .string()
    .min(1)
    .default('postgres://notification:notification@postgres-notification:5432/notification_db'),
  KAFKA_BROKERS: z.string().min(1).default('kafka:9092').transform(parseBrokers),
  WEBHOOK_RETRY_BASE_MS: z.coerce.number().int().min(0).default(200),
  WEBHOOK_FAILURE_RATE: z.coerce.number().min(0).max(1).default(0),
  WEBHOOK_SEED: z.coerce.number().int().min(0).max(0xffffffff).default(42),
  WEBHOOK_LATENCY_MS: z.coerce.number().int().min(0).default(0),
});

export type NotificationConfig = z.output<typeof notificationConfigSchema>;

export function loadNotificationConfig(env: NodeJS.ProcessEnv = process.env): NotificationConfig {
  return loadConfig(notificationConfigSchema, env);
}
