import path from 'node:path';
import { createInstrument, createLogger, createPool, runMigrations, startHealthServer } from '@switch/common';
import { Registry } from 'prom-client';
import { BankClients, createBankPort } from './clients/bankClients';
import { createLedgerClient, createLedgerPort } from './clients/ledgerClient';
import { loadOrchestratorConfig } from './config';
import { policyFromConfig } from './domain/policy';
import { createTransferHandlers } from './grpc/handlers';
import { startGrpcServer } from './grpc/server';
import { SagaEngine, type SagaDeps } from './domain/saga';
import { createOrchestratorMetrics, recoveryObserver, sagaObserver } from './metrics';
import { RecoveryWorker } from './recovery/worker';
import { createRecoveryStore, createTransferStore } from './repo/transfersRepo';

/** Section 6, Shutdown: wait up to 10 seconds for inline sagas. */
const SHUTDOWN_GRACE_MS = 10_000;

/** Wiring and startup only (spec section 3 conventions). */
async function main(): Promise<void> {
  const config = loadOrchestratorConfig();
  const logger = createLogger('orchestrator', { level: config.LOG_LEVEL }).child({ instance_id: config.INSTANCE_ID });
  const pool = createPool(config.DATABASE_URL, logger);

  await runMigrations(pool, path.resolve(__dirname, '..', 'migrations'), logger);

  const registry = new Registry();
  const metrics = createOrchestratorMetrics(registry);
  const instrument = createInstrument({ logger, registry });
  const banks = new BankClients(config.BANK_ENDPOINTS);
  const ledger = createLedgerClient(config.LEDGER_ADDR);
  const policy = policyFromConfig(config);

  const sagaDeps: Omit<SagaDeps, 'logger'> = {
    store: createTransferStore(pool),
    bank: createBankPort(banks),
    ledger: createLedgerPort(ledger),
    policy,
    clock: { now: () => Date.now() },
    observer: sagaObserver(metrics),
  };

  const grpcServer = await startGrpcServer(
    createTransferHandlers({
      pool,
      instrument,
      saga: sagaDeps,
      knownBank: (bankId) => banks.has(bankId),
      instanceId: config.INSTANCE_ID,
      maxAmount: config.MAX_TRANSFER_AMOUNT,
      inlineBudgetMs: config.SAGA_INLINE_BUDGET_MS,
      replayWaitMs: config.REPLAY_WAIT_MS,
      leaseMs: config.LEASE_MS,
    }),
    config.GRPC_PORT,
  );
  const health = await startHealthServer({
    port: config.HTTP_PORT,
    registry,
    logger,
    ready: async () => {
      await pool.query('SELECT 1');
      return true;
    },
  });
  const recoveryLogger = logger.child({ component: 'recovery' });
  const recovery = new RecoveryWorker({
    store: createRecoveryStore(pool),
    saga: new SagaEngine({ ...sagaDeps, logger: recoveryLogger }),
    config: {
      pollMs: config.RECOVERY_POLL_MS,
      batch: config.RECOVERY_BATCH,
      concurrency: config.RECOVERY_CONCURRENCY,
      leaseMs: config.LEASE_MS,
      resolveAfterAttempts: config.RESOLVE_AFTER_ATTEMPTS,
      maxRecoveryAttempts: config.MAX_RECOVERY_ATTEMPTS,
    },
    instanceId: config.INSTANCE_ID,
    logger: recoveryLogger,
    observer: recoveryObserver(metrics),
  });
  recovery.start();
  logger.info(
    { grpc_port: grpcServer.port, http_port: config.HTTP_PORT, banks: banks.bankIds, ledger: config.LEDGER_ADDR },
    'orchestrator started',
  );

  let stopping = false;
  const stop = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'orchestrator shutting down');
    void (async () => {
      // Stop accepting calls and let inline sagas finish. Anything still unfinished
      // keeps its *_SENT intent and is picked up after its lease expires.
      await grpcServer.shutdown(SHUTDOWN_GRACE_MS);
      // Then stop the recovery loop, letting the batch in progress finish within the grace.
      await recovery.stop(SHUTDOWN_GRACE_MS);
      await health.close();
      banks.close();
      ledger.close();
      await pool.end();
      logger.info('orchestrator stopped');
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
  process.stderr.write(
    `orchestrator failed to start: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exit(1);
});
