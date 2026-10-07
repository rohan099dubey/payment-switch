// First import: tracing must hook gRPC, http and pg before they load (ADR-028).
import { shutdownTracing } from '@switch/common/tracing';
import path from 'node:path';
import { createInstrument, createLogger, createPool, runMigrations, startHealthServer } from '@switch/common';
import type { Pool } from 'pg';
import { Registry } from 'prom-client';
import { createBankSide, createLedgerSide } from './clients/sources';
import { loadReconciliationConfig } from './config';
import { Reconciler, type BankSide } from './domain/reconciler';
import { createReconciliationHandlers } from './grpc/handlers';
import { startGrpcServer } from './grpc/server';
import { createReconciliationMetrics, runObserver } from './metrics';
import { createReconStore, ping } from './repo/reconRepo';
import { ReconciliationRunner, Scheduler } from './runner';

const SHUTDOWN_GRACE_MS = 10_000;

/** The first scheduled run starts at the configured time, or when the service first ran. */
async function initialFrom(pool: Pool, configured: string): Promise<Date> {
  if (configured !== '') return new Date(configured);
  const { rows } = await pool.query<{ at: Date }>(
    "SELECT applied_at AS at FROM schema_migrations WHERE filename = '0001_init.sql'",
  );
  return rows[0]?.at ?? new Date();
}

/** Wiring and startup only (section 3 conventions). Phase 2, item 3 (ADR-027). */
async function main(): Promise<void> {
  const config = loadReconciliationConfig();
  const logger = createLogger('reconciliation', { level: config.LOG_LEVEL });
  const pool = createPool(config.DATABASE_URL, logger);
  await runMigrations(pool, path.resolve(__dirname, '..', 'migrations'), logger);

  const registry = new Registry();
  const metrics = createReconciliationMetrics(registry);
  const instrument = createInstrument({ logger, registry });

  const bankSides = new Map<string, BankSide & { close: () => void }>();
  for (const [bankId, address] of config.BANK_ENDPOINTS) bankSides.set(bankId, createBankSide(bankId, address));
  const ledger = createLedgerSide(config.LEDGER_ADDR);

  const reconciler = new Reconciler({
    banks: bankSides,
    ledger,
    store: createReconStore(pool),
    concurrency: config.RECON_LOOKUP_CONCURRENCY,
  });
  const runner = new ReconciliationRunner(pool, reconciler, logger, runObserver(metrics));
  const scheduler = new Scheduler(
    pool,
    runner,
    {
      intervalMs: config.RECON_INTERVAL_MS,
      settleMs: config.RECON_SETTLE_MS,
      initialFrom: await initialFrom(pool, config.RECON_INITIAL_FROM),
    },
    logger,
  );

  const grpcServer = await startGrpcServer(
    createReconciliationHandlers({ pool, runner, instrument }),
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
  scheduler.start();
  logger.info(
    {
      grpc_port: grpcServer.port,
      http_port: config.HTTP_PORT,
      banks: [...config.BANK_ENDPOINTS.keys()],
      interval_ms: config.RECON_INTERVAL_MS,
      settle_ms: config.RECON_SETTLE_MS,
    },
    'reconciliation service started',
  );

  let stopping = false;
  const stop = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'reconciliation service shutting down');
    void (async () => {
      await grpcServer.shutdown(SHUTDOWN_GRACE_MS);
      await scheduler.stop();
      await health.close();
      for (const side of bankSides.values()) side.close();
      ledger.close();
      await pool.end();
      await shutdownTracing();
      logger.info('reconciliation service stopped');
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
    `reconciliation failed to start: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exit(1);
});
