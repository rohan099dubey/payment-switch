import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import type { GatewayMetrics } from '../metrics';
import { ApiError } from './errorHandler';

/** Same path from `src/plugins` (tests) and `dist/plugins` (runtime): the .lua stays in src/. */
export const TOKEN_BUCKET_LUA_PATH = path.resolve(__dirname, '..', '..', 'src', 'lua', 'tokenBucket.lua');

export interface RateLimitDecision {
  allowed: boolean;
  remaining: number;
  /** Whole seconds until a token is available; 0 when allowed. */
  retryAfterSeconds: number;
}

/** Takes one token from a client's bucket. Throws if the store is unreachable. */
export interface RateLimiter {
  take: (clientId: string) => Promise<RateLimitDecision>;
}

export function bucketKey(clientId: string): string {
  return `rl:${clientId}`;
}

/** `Retry-After` is whole seconds, never 0 for a rejection. */
export function retryAfterSeconds(retryAfterMs: number): number {
  return Math.max(1, Math.ceil(retryAfterMs / 1000));
}

/** The two Redis commands the bucket needs; an ioredis `Redis` satisfies it. */
export interface ScriptRunner {
  evalsha: (sha: string, numKeys: number, ...args: (string | number)[]) => Promise<unknown>;
  script: (subcommand: 'LOAD', script: string) => Promise<unknown>;
}

/**
 * The Redis token bucket (section 5): `tokenBucket.lua` run with `EVALSHA`, so the
 * check-and-decrement is atomic, with the clock from Redis `TIME`. On `NOSCRIPT` (Redis
 * restarted and lost its script cache) the script is loaded once and the call retried.
 */
export class RedisTokenBucket implements RateLimiter {
  private readonly script: string;
  private readonly sha: string;

  constructor(
    private readonly redis: ScriptRunner,
    private readonly ratePerSecond: number,
    private readonly burst: number,
    script: string = readFileSync(TOKEN_BUCKET_LUA_PATH, 'utf8'),
  ) {
    this.script = script;
    this.sha = createHash('sha1').update(script, 'utf8').digest('hex');
  }

  async take(clientId: string): Promise<RateLimitDecision> {
    const key = bucketKey(clientId);
    let reply: unknown;
    try {
      reply = await this.redis.evalsha(this.sha, 1, key, this.ratePerSecond, this.burst);
    } catch (err) {
      if (!(err instanceof Error) || !err.message.startsWith('NOSCRIPT')) throw err;
      await this.redis.script('LOAD', this.script);
      reply = await this.redis.evalsha(this.sha, 1, key, this.ratePerSecond, this.burst);
    }
    return parseReply(reply);
  }
}

function parseReply(reply: unknown): RateLimitDecision {
  if (!Array.isArray(reply) || reply.length !== 3 || !reply.every((v) => typeof v === 'number')) {
    throw new Error(`unexpected token bucket reply: ${JSON.stringify(reply)}`);
  }
  const [allowed, remaining, retryAfterMs] = reply as [number, number, number];
  return {
    allowed: allowed === 1,
    remaining: Math.max(0, remaining),
    retryAfterSeconds: allowed === 1 ? 0 : retryAfterSeconds(retryAfterMs),
  };
}

/**
 * `preHandler` after authentication on both `/v1/transfers` routes. Sets
 * `X-RateLimit-Remaining`; a rejection is 429 `RATE_LIMITED` with `Retry-After`. If the
 * store is unreachable the request is allowed: fail open, with a warning and
 * `rate_limit_fail_open_total` (ADR-006).
 */
export function rateLimit(limiter: RateLimiter, metrics: GatewayMetrics): preHandlerAsyncHookHandler {
  return async (request: FastifyRequest, reply) => {
    const clientId = request.clientId;
    if (clientId === undefined) throw new Error('rateLimit must run after authenticate');

    let decision: RateLimitDecision;
    try {
      decision = await limiter.take(clientId);
    } catch (err) {
      metrics.rateLimitFailOpen.inc();
      request.log.warn({ err, client_id: clientId }, 'rate limiter unavailable; failing open');
      return;
    }

    void reply.header('x-ratelimit-remaining', String(decision.remaining));
    if (!decision.allowed) {
      metrics.rateLimitRejections.inc();
      throw new ApiError(429, 'RATE_LIMITED', 'rate limit exceeded; retry after the Retry-After interval', undefined, {
        'retry-after': String(decision.retryAfterSeconds),
        'x-ratelimit-remaining': '0',
      });
    }
  };
}
