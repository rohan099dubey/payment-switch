import path from 'node:path';
import { createInstrument, createLogger, createPool, runMigrations, startHealthServer } from '@switch/common';
import { Registry } from 'prom-client';
import { loadLedgerConfig } from './config';
import { createLedgerHandlers } from './grpc/handlers';
import { startGrpcServer } from './grpc/server';
import { createLedgerMetrics } from './metrics';
import { ping } from './repo/balanceRepo';

const SHUTDOWN_GRACE_MS = 10_000;

/** Wiring and startup only (spec section 3 conventions). */
async function main(): Promise<void> {
  const config = loadLedgerConfig();
  const logger = createLogger('ledger', { level: config.LOG_LEVEL });
  const pool = createPool(config.DATABASE_URL, logger);

  await runMigrations(pool, path.resolve(__dirname, '..', 'migrations'), logger);

  const registry = new Registry();
  const metrics = createLedgerMetrics(registry);
  const instrument = createInstrument({ logger, registry });

  const grpcServer = await startGrpcServer(createLedgerHandlers({ pool, metrics, instrument }), config.GRPC_PORT);
  const health = await startHealthServer({
    port: config.HTTP_PORT,
    registry,
    logger,
    ready: async () => {
      await ping(pool);
      return true;
    },
  });
  logger.info({ grpc_port: grpcServer.port, http_port: config.HTTP_PORT }, 'ledger started');

  let stopping = false;
  const stop = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'ledger shutting down');
    void (async () => {
      await grpcServer.shutdown(SHUTDOWN_GRACE_MS);
      await health.close();
      await pool.end();
      logger.info('ledger stopped');
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
  process.stderr.write(`ledger failed to start: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
