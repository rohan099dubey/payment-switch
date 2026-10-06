import { callUnary, makeClient } from '@switch/common';
import {
  TransferServiceClient,
  type CreateTransferRequest,
  type CreateTransferResponse,
  type Transfer,
} from '@switch/proto-gen/orchestrator/v1';

/** `GetTransfer` deadline: a constant 3000 ms (section 14). */
export const GET_TRANSFER_TIMEOUT_MS = 3000;
/** How long `/readyz` waits for the channel to reach READY. */
export const READY_WAIT_MS = 1000;

/** What the routes need from the Orchestrator. Errors are thrown as received (gRPC). */
export interface OrchestratorPort {
  createTransfer: (request: CreateTransferRequest, requestId: string) => Promise<CreateTransferResponse>;
  getTransfer: (transferId: string, clientId: string, requestId: string) => Promise<Transfer>;
  /** True once the channel is connected (READY) within `READY_WAIT_MS`. */
  ready: () => Promise<boolean>;
  close: () => void;
}

/**
 * Every call carries a deadline and forwards the request id as `x-request-id`. The
 * Gateway never retries `CreateTransfer`: the client retries with the same key (section 5).
 */
export function createOrchestratorClient(address: string, createTimeoutMs: number): OrchestratorPort {
  const client = makeClient(TransferServiceClient, address);
  return {
    createTransfer: (request, requestId) =>
      callUnary(client.createTransfer.bind(client), request, { timeoutMs: createTimeoutMs, requestId }),
    getTransfer: (transferId, clientId, requestId) =>
      callUnary(
        client.getTransfer.bind(client),
        { transferId, clientId },
        { timeoutMs: GET_TRANSFER_TIMEOUT_MS, requestId },
      ),
    ready: () =>
      new Promise<boolean>((resolve) => {
        client.waitForReady(Date.now() + READY_WAIT_MS, (err) => {
          resolve(err === undefined);
        });
      }),
    close: () => {
      client.close();
    },
  };
}
