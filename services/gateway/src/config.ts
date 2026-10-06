import { loadConfig } from '@switch/common';
import { z } from 'zod';

const positiveInt = (fallback: number): z.ZodDefault<z.ZodCoercedNumber> =>
  z.coerce.number().int().positive().default(fallback);

/** Used as the JWT `sub`, the Orchestrator `client_id` and in the Redis key `rl:{client_id}`. */
export const CLIENT_ID = /^[A-Za-z0-9_.-]{1,64}$/;

const apiClientSchema = z.strictObject({
  client_id: z.string().regex(CLIENT_ID, 'client_id must match [A-Za-z0-9_.-]{1,64}'),
  client_secret: z.string().min(1),
});

export interface ApiClient {
  clientId: string;
  clientSecret: string;
}

/** `API_CLIENTS`: a JSON array of `{client_id, client_secret}`, ids unique (section 5). */
function parseApiClients(value: string, ctx: z.RefinementCtx): readonly ApiClient[] {
  let json: unknown;
  try {
    json = JSON.parse(value);
  } catch {
    ctx.addIssue({ code: 'custom', message: 'must be a JSON array of {client_id, client_secret}' });
    return [];
  }
  const parsed = z.array(apiClientSchema).min(1).safeParse(json);
  if (!parsed.success) {
    ctx.addIssue({ code: 'custom', message: `must be a non-empty JSON array of {client_id, client_secret}` });
    return [];
  }
  const clients = parsed.data.map((c) => ({ clientId: c.client_id, clientSecret: c.client_secret }));
  const ids = new Set(clients.map((c) => c.clientId));
  if (ids.size !== clients.length) ctx.addIssue({ code: 'custom', message: 'client_id values must be unique' });
  return clients;
}

/** Spec section 15, Gateway block. `JWT_SECRET` and `API_CLIENTS` are required, with no default. */
export const gatewayConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  HTTP_PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_TTL_SECONDS: positiveInt(900),
  API_CLIENTS: z.string().transform(parseApiClients),
  REDIS_URL: z.string().min(1).default('redis://redis:6379'),
  RATE_LIMIT_RPS: positiveInt(100),
  RATE_LIMIT_BURST: positiveInt(200),
  ORCHESTRATOR_ADDR: z
    .string()
    .regex(/^[A-Za-z0-9.-]+:\d{1,5}$/, 'ORCHESTRATOR_ADDR must be host:port')
    .default('orchestrator:50051'),
  ORCHESTRATOR_TIMEOUT_MS: positiveInt(10_000),
  MAX_TRANSFER_AMOUNT: positiveInt(10_000_000).pipe(z.number().max(Number.MAX_SAFE_INTEGER)),
});

export type GatewayConfig = z.output<typeof gatewayConfigSchema>;

export function loadGatewayConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  return loadConfig(gatewayConfigSchema, env);
}
