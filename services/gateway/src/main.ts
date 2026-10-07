// First import: tracing must hook gRPC, http and pg before they load (ADR-028).
import { shutdownTracing } from '@switch/common/tracing';
import { createLogger } from '@switch/common';
import { Redis } from 'ioredis';
import { Registry } from 'prom-client';
import { buildApp } from './app';
import { createOrchestratorClient } from './clients/orchestratorClient';
import { loadGatewayConfig } from './config';
import { createGatewayMetrics } from './metrics';
import { RedisTokenBucket } from './plugins/rateLimit';

/** In-flight requests may need the full CreateTransfer deadline to finish. */
const SHUTDOWN_GRACE_MS = 12_000;
/** A Redis that does not answer within this is treated as down (fail open, ADR-006). */
/**
 * How long one rate-limit command may wait for Redis (ADR-019, amended 2026-10-07). A dead
 * Redis fails at once (no offline queue), so this only bounds a connected but silent one.
 * It was 250 ms, which mistook event-loop lag during a 450-request burst for an outage:
 * on the GitHub runner 68 requests failed open and slipped past the limit.
 */
const REDIS_COMMAND_TIMEOUT_MS = 1000;

/** Wiring and startup only (spec section 3 conventions). */
async function main(): Promise<void> {
  const config = loadGatewayConfig();
  const logger = createLogger('gateway', { level: config.LOG_LEVEL });

  const redis = new Redis(config.REDIS_URL, {
    // Never queue commands while disconnected: a rate-limit check must fail fast so the
    // request can fail open instead of waiting for Redis to come back.
    enableOfflineQueue: false,
    maxRetriesPerRequest: 0,
    commandTimeout: REDIS_COMMAND_TIMEOUT_MS,
  });
  let redisDown = false;
  redis.on('error', (err: Error) => {
    if (!redisDown) logger.warn({ err: err.message }, 'redis connection error');
    redisDown = true;
  });
  redis.on('ready', () => {
    if (redisDown) logger.info('redis connection restored');
    redisDown = false;
  });

  const registry = new Registry();
  const metrics = createGatewayMetrics(registry);
  const orchestrator = createOrchestratorClient(config.ORCHESTRATOR_ADDR, config.ORCHESTRATOR_TIMEOUT_MS);

  const app = await buildApp({
    config,
    logger,
    registry,
    metrics,
    orchestrator,
    limiter: new RedisTokenBucket(redis, config.RATE_LIMIT_RPS, config.RATE_LIMIT_BURST),
    redisReady: async () => {
      // PING resolves only with PONG; any failure (down, timeout) rejects and means not ready.
      await redis.ping();
      return true;
    },
  });
  await app.listen({ port: config.HTTP_PORT, host: '::' });
  logger.info({ http_port: config.HTTP_PORT, orchestrator: config.ORCHESTRATOR_ADDR }, 'gateway started');

  let stopping = false;
  const stop = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'gateway shutting down');
    const force = setTimeout(() => {
      logger.warn('shutdown grace period elapsed; exiting');
      process.exit(1);
    }, SHUTDOWN_GRACE_MS);
    void (async () => {
      await app.close();
      orchestrator.close();
      redis.disconnect();
      clearTimeout(force);
      await shutdownTracing();
      logger.info('gateway stopped');
      process.exit(0);
    })().catch((err: unknown) => {
      logger.error({ err }, 'error during shutdown');
      process.exit(1);
    });
  };
  process.on('SIGTERM', () => {
    stop('SIGTERM');
  });
  process.on('SIGINT', () => {
    stop('SIGINT');
  });
}

main().catch((err: unknown) => {
  // The logger may not exist yet (bad config), so write the failure directly.
  process.stderr.write(`gateway failed to start: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
