// First import: tracing must hook gRPC, http and pg before they load (ADR-028).
import { shutdownTracing } from '@switch/common/tracing';
import path from 'node:path';
import { createInstrument, createLogger, createPool, runMigrations, startHealthServer } from '@switch/common';
import { Registry } from 'prom-client';
import { ChaosEngine } from './chaos/chaos';
import { chaosSettingsFromConfig, loadBankConfig } from './config';
import { createBankHandlers } from './grpc/handlers';
import { startGrpcServer } from './grpc/server';
import { createBankMetrics } from './metrics';
import { ping } from './repo/accountsRepo';

/** Longer than CHAOS_SLOW_MS, so in-flight late applies can finish on SIGTERM. */
const SHUTDOWN_GRACE_MS = 10_000;

/** Wiring and startup only (spec section 3 conventions). */
async function main(): Promise<void> {
  const config = loadBankConfig();
  const logger = createLogger('mock-bank', { level: config.LOG_LEVEL }).child({ bank_id: config.BANK_ID });
  const pool = createPool(config.DATABASE_URL, logger);

  await runMigrations(pool, path.resolve(__dirname, '..', 'migrations'), logger);

  const registry = new Registry();
  registry.setDefaultLabels({ bank_id: config.BANK_ID });
  const metrics = createBankMetrics(registry);
  const instrument = createInstrument({ logger, registry });
  const chaos = new ChaosEngine(chaosSettingsFromConfig(config));

  const grpcServer = await startGrpcServer(
    createBankHandlers({ pool, chaos, metrics, instrument, bankCallTimeoutMs: config.BANK_CALL_TIMEOUT_MS }),
    config.GRPC_PORT,
  );
  const health = await startHealthServer({
    port: config.HTTP_PORT,
    registry,
    logger,
    ready: async () => {
      await ping(pool);
      return true;
    },
  });
  logger.info({ grpc_port: grpcServer.port, http_port: config.HTTP_PORT, chaos: chaos.settings }, 'mock bank started');

  let stopping = false;
  const stop = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'mock bank shutting down');
    void (async () => {
      await grpcServer.shutdown(SHUTDOWN_GRACE_MS);
      await health.close();
      await pool.end();
      await shutdownTracing();
      logger.info('mock bank stopped');
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
    `mock bank failed to start: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exit(1);
});
