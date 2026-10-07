// First import: tracing must hook gRPC, http and pg before they load (ADR-028).
import { shutdownTracing } from '@switch/common/tracing';
import path from 'node:path';
import { createLogger, createPool, runMigrations, sleep, startHealthServer } from '@switch/common';
import { Registry } from 'prom-client';
import { createKafka, ensureTopics, KafkaDeadLetters, startConsumer } from './clients/kafka';
import { loadNotificationConfig } from './config';
import { MAX_WEBHOOK_ATTEMPTS } from './domain/events';
import { EventProcessor } from './domain/processor';
import { SimulatedWebhook } from './domain/webhook';
import { createNotificationMetrics, processorObserver } from './metrics';
import { createNotificationStore, ping } from './repo/notificationsRepo';

const SHUTDOWN_GRACE_MS = 10_000;

/** Wiring and startup only (section 3 conventions). Phase 2, item 2 (ADR-026). */
async function main(): Promise<void> {
  const config = loadNotificationConfig();
  const logger = createLogger('notification', { level: config.LOG_LEVEL });
  const pool = createPool(config.DATABASE_URL, logger);
  await runMigrations(pool, path.resolve(__dirname, '..', 'migrations'), logger);

  const registry = new Registry();
  const metrics = createNotificationMetrics(registry);
  const kafka = createKafka(config.KAFKA_BROKERS, 'notification', logger);

  // Kafka can still be starting; keep trying rather than crash-loop.
  for (let attempt = 1; ; attempt++) {
    try {
      await ensureTopics(kafka);
      break;
    } catch (err) {
      logger.warn({ err, attempt }, 'kafka not ready; retrying topic setup');
      await sleep(Math.min(500 * 2 ** attempt, 10_000));
    }
  }

  const deadLetters = new KafkaDeadLetters(kafka);
  const processor = new EventProcessor({
    store: createNotificationStore(pool),
    webhook: new SimulatedWebhook(
      { failureRate: config.WEBHOOK_FAILURE_RATE, seed: config.WEBHOOK_SEED, latencyMs: config.WEBHOOK_LATENCY_MS },
      sleep,
    ),
    deadLetters,
    observer: processorObserver(metrics),
    sleep,
    maxAttempts: MAX_WEBHOOK_ATTEMPTS,
    retryBaseMs: config.WEBHOOK_RETRY_BASE_MS,
  });

  let joined = false;
  const health = await startHealthServer({
    port: config.HTTP_PORT,
    registry,
    logger,
    ready: async () => {
      await ping(pool);
      return joined;
    },
  });
  const consumer = await startConsumer(
    kafka,
    async (message) => {
      const result = await processor.handle(message);
      if (result !== 'delivered') logger.info({ result, event_id: message.headers['event-id'] }, 'event handled');
    },
    () => {
      joined = true;
      logger.info('joined consumer group');
    },
  );
  logger.info({ http_port: config.HTTP_PORT, kafka: config.KAFKA_BROKERS }, 'notification service started');

  let stopping = false;
  const stop = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'notification service shutting down');
    const timer = setTimeout(() => process.exit(1), SHUTDOWN_GRACE_MS);
    void (async () => {
      // Uncommitted offsets come back to whichever member takes the partition next.
      await consumer.disconnect();
      await deadLetters.close();
      await health.close();
      await pool.end();
      await shutdownTracing();
      clearTimeout(timer);
      logger.info('notification service stopped');
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
  process.stderr.write(
    `notification failed to start: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exit(1);
});
