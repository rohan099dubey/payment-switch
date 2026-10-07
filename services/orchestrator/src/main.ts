// First import: tracing must hook gRPC, http and pg before they load (ADR-028).
import { shutdownTracing } from '@switch/common/tracing';
import path from 'node:path';
import { createInstrument, createLogger, createPool, runMigrations, startHealthServer } from '@switch/common';
import { Registry } from 'prom-client';
import { BankClients, createBankPort } from './clients/bankClients';
import { KafkaPublisher } from './clients/kafkaPublisher';
import { createLedgerClient, createLedgerPort } from './clients/ledgerClient';
import { loadOrchestratorConfig } from './config';
import { policyFromConfig } from './domain/policy';
import { createTransferHandlers } from './grpc/handlers';
import { startGrpcServer } from './grpc/server';
import { SagaEngine, type SagaDeps } from './domain/saga';
import { OUTBOX_BATCH, TRANSFER_EVENTS_TOPIC } from './domain/outboxEvents';
import { createOrchestratorMetrics, recoveryObserver, relayObserver, sagaObserver } from './metrics';
import { OutboxRelay } from './outbox/relay';
import { createOutboxStore } from './repo/outboxRepo';
import { RecoveryWorker } from './recovery/worker';
import { createRecoveryStore, createTransferStore, ping } from './repo/transfersRepo';

/** Section 6, Shutdown: wait up to 10 seconds for inline sagas. */
const SHUTDOWN_GRACE_MS = 10_000;

/** ADR-025: partitions of `transfer-events` when the relay creates it. */
const KAFKA_PARTITIONS = 3;
/** ADR-025: the relay's backoff ceiling while Kafka is unreachable. */
const RELAY_MAX_BACKOFF_MS = 30_000;

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
      await ping(pool);
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

  // Phase 2, item 1 (section 19, ADR-025). Kafka is not a dependency of the payment path:
  // if it is down, events wait in the outbox and the relay backs off.
  const relayLogger = logger.child({ component: 'outbox' });
  const publisher = new KafkaPublisher({
    brokers: config.KAFKA_BROKERS,
    clientId: `orchestrator-${config.INSTANCE_ID}`,
    topic: TRANSFER_EVENTS_TOPIC,
    partitions: KAFKA_PARTITIONS,
    logger: relayLogger,
  });
  const relay = new OutboxRelay({
    store: createOutboxStore(pool),
    publisher,
    config: { pollMs: config.OUTBOX_POLL_MS, batch: OUTBOX_BATCH, maxBackoffMs: RELAY_MAX_BACKOFF_MS },
    logger: relayLogger,
    observer: relayObserver(metrics),
  });
  relay.start();
  logger.info(
    {
      grpc_port: grpcServer.port,
      http_port: config.HTTP_PORT,
      banks: banks.bankIds,
      ledger: config.LEDGER_ADDR,
      kafka: config.KAFKA_BROKERS,
    },
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
      // Recovery can still finish transfers, so the relay stops after it. Unpublished
      // events stay in the outbox for any instance's relay.
      await relay.stop(SHUTDOWN_GRACE_MS);
      await publisher.close().catch((err: unknown) => {
        logger.warn({ err }, 'kafka producer did not close cleanly');
      });
      await health.close();
      banks.close();
      ledger.close();
      await pool.end();
      await shutdownTracing();
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
