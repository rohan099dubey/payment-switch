import { randomUUID } from 'node:crypto';
import { status as Status } from '@grpc/grpc-js';
import { makeGrpcError, sleep, withContext, type Instrument, type Logger } from '@switch/common';
import {
  TransferState as ProtoTransferState,
  type Transfer as ProtoTransfer,
  type TransferServiceServer,
} from '@switch/proto-gen/orchestrator/v1';
import type { Pool } from 'pg';
import { OrchestratorErrorCode } from '../domain/failureCodes';
import { SagaEngine, type SagaDeps } from '../domain/saga';
import { isTerminal, type TransferState } from '../domain/states';
import type { Transfer } from '../domain/transfer';
import { validateCreateTransfer } from '../domain/validate';
import { getTransfer, getTransferForClient, insertTransfer, releaseLease } from '../repo/transfersRepo';

/** Poll interval while a replay waits for the original request to finish (section 6, step 4). */
export const REPLAY_POLL_MS = 100;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const PROTO_STATE: Readonly<Record<TransferState, ProtoTransferState>> = {
  INITIATED: ProtoTransferState.TRANSFER_STATE_INITIATED,
  DEBIT_SENT: ProtoTransferState.TRANSFER_STATE_DEBIT_SENT,
  DEBITED: ProtoTransferState.TRANSFER_STATE_DEBITED,
  CREDIT_SENT: ProtoTransferState.TRANSFER_STATE_CREDIT_SENT,
  CREDITED: ProtoTransferState.TRANSFER_STATE_CREDITED,
  SUCCESS: ProtoTransferState.TRANSFER_STATE_SUCCESS,
  FAILED: ProtoTransferState.TRANSFER_STATE_FAILED,
  REVERSING: ProtoTransferState.TRANSFER_STATE_REVERSING,
  REVERSED: ProtoTransferState.TRANSFER_STATE_REVERSED,
  NEEDS_MANUAL_REVIEW: ProtoTransferState.TRANSFER_STATE_NEEDS_MANUAL_REVIEW,
};

export interface HandlerDeps {
  pool: Pool;
  instrument: Instrument;
  /** Everything the saga needs except the per-request logger (the saga adds `transfer_id` itself). */
  saga: Omit<SagaDeps, 'logger'>;
  knownBank: (bankId: string) => boolean;
  instanceId: string;
  maxAmount: bigint;
  inlineBudgetMs: number;
  replayWaitMs: number;
  leaseMs: number;
}

/**
 * The lease owner for one drive attempt: INSTANCE_ID plus a fresh random token, so two
 * drivers inside one process never share a lease (section 13).
 */
export function newLeaseOwner(instanceId: string): string {
  return `${instanceId}:${randomUUID()}`;
}

/** gRPC transport for `TransferService`. Business failures are `OK` with a `failure_code`. */
export function createTransferHandlers(deps: HandlerDeps): TransferServiceServer {
  const { pool, instrument, saga, instanceId } = deps;

  /** Step 4: poll a replayed transfer until it is terminal or `REPLAY_WAIT_MS` runs out. */
  async function awaitReplay(existing: Transfer): Promise<Transfer> {
    const until = saga.clock.now() + deps.replayWaitMs;
    let latest = existing;
    while (!isTerminal(latest.state) && saga.clock.now() < until) {
      await sleep(Math.min(REPLAY_POLL_MS, Math.max(0, until - saga.clock.now())));
      latest = (await getTransfer(pool, latest.id)) ?? latest;
    }
    return latest;
  }

  return {
    createTransfer: instrument('CreateTransfer', async (request, { requestId, logger }) => {
      // The budget starts when the request arrives: the Gateway's deadline already has.
      const deadline = saga.clock.now() + deps.inlineBudgetMs;

      // 1. Validate.
      const validation = validateCreateTransfer(request, { knownBank: deps.knownBank, maxAmount: deps.maxAmount });
      if (!validation.ok) throw makeGrpcError(Status.INVALID_ARGUMENT, validation.errorCode, validation.reason);

      // 2-3. Hash (done in validation) and register, owning the lease from the insert.
      const leaseOwner = newLeaseOwner(instanceId);
      const outcome = await insertTransfer(pool, validation.transfer, leaseOwner, deps.leaseMs, {
        request_id: requestId,
        instance_id: instanceId,
      });

      // 4. Duplicate key: a conflict or a replay. A replay never drives the saga.
      if (outcome.status === 'duplicate') {
        const existing = outcome.existing;
        if (existing.requestHash !== validation.transfer.requestHash) {
          throw makeGrpcError(
            Status.ALREADY_EXISTS,
            OrchestratorErrorCode.IDEMPOTENCY_KEY_REUSED,
            'idempotency key was already used with a different request body',
          );
        }
        const latest = await awaitReplay(existing);
        withContext(logger, { transfer_id: latest.id }).info({ state: latest.state }, 'replayed transfer');
        return { transfer: toProtoTransfer(latest), replayed: true };
      }

      // 5. Drive.
      const created = outcome.transfer;
      const log: Logger = withContext(logger, { transfer_id: created.id });
      log.info({ amount: created.amount.toString() }, 'transfer registered');
      try {
        const driven = await new SagaEngine({ ...saga, logger }).advance(created, {
          mode: 'inline',
          deadline,
          leaseOwner,
          requestId,
        });
        return { transfer: toProtoTransfer(driven), replayed: false };
      } catch (err) {
        // Unexpected (e.g. the database went away mid-saga). Hand the transfer to
        // recovery now rather than after the lease expires. Best effort.
        await releaseLease(pool, created.id, leaseOwner).catch((releaseErr: unknown) => {
          log.warn({ err: releaseErr }, 'could not release the lease; it will expire');
        });
        throw err;
      }
    }),

    getTransfer: instrument('GetTransfer', async (request) => {
      if (request.clientId === '') {
        throw makeGrpcError(Status.INVALID_ARGUMENT, OrchestratorErrorCode.INVALID_REQUEST, 'client_id is required');
      }
      // A malformed id cannot name a transfer; answer as absent rather than leak a SQL error.
      const transfer = UUID.test(request.transferId)
        ? await getTransferForClient(pool, request.transferId, request.clientId)
        : null;
      if (transfer === null) {
        throw makeGrpcError(Status.NOT_FOUND, OrchestratorErrorCode.TRANSFER_NOT_FOUND, 'transfer not found');
      }
      return toProtoTransfer(transfer);
    }),
  };
}

export function toProtoTransfer(t: Transfer): ProtoTransfer {
  return {
    transferId: t.id,
    state: PROTO_STATE[t.state],
    payer: { bankId: t.payer.bankId, accountId: t.payer.accountId },
    payee: { bankId: t.payee.bankId, accountId: t.payee.accountId },
    amount: t.amount.toString(),
    currency: t.currency,
    note: t.note ?? '',
    failureCode: t.failureCode ?? '',
    failureMessage: t.failureMessage ?? '',
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  };
}
