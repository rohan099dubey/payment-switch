/**
 * ADR-010: `202` is a normal outcome. `CreateTransfer` can return a non-terminal transfer
 * when the inline budget runs out, so tests never assume the create call finished the
 * saga. They hand its response to `awaitTerminal`, which polls `GetTransfer` until the
 * transfer is terminal or `timeoutMs` passes.
 *
 * Since M6 the recovery worker finishes a yielded transfer, so the poll timeout must
 * cover recovery's backoff (2, 4, 8 s, then Resolve) when chaos is on.
 */
import { callUnary, sleep } from '@switch/common';
import { TransferState, type Transfer, type TransferServiceClient } from '@switch/proto-gen/orchestrator/v1';

export const TERMINAL_STATES: ReadonlySet<TransferState> = new Set([
  TransferState.TRANSFER_STATE_SUCCESS,
  TransferState.TRANSFER_STATE_FAILED,
  TransferState.TRANSFER_STATE_REVERSED,
  TransferState.TRANSFER_STATE_NEEDS_MANUAL_REVIEW,
]);

export const GET_TRANSFER_TIMEOUT_MS = 3000;
export const POLL_INTERVAL_MS = 100;

export async function awaitTerminal(
  client: TransferServiceClient,
  clientId: string,
  transfer: Transfer,
  timeoutMs = 15_000,
): Promise<Transfer> {
  const until = Date.now() + timeoutMs;
  let latest = transfer;
  while (!TERMINAL_STATES.has(latest.state)) {
    if (Date.now() >= until) {
      throw new Error(
        `transfer ${latest.transferId} still in state ${String(latest.state)} after ${timeoutMs} ms (ADR-010: before M6, nothing drives a yielded transfer)`,
      );
    }
    await sleep(POLL_INTERVAL_MS);
    latest = await callUnary(
      client.getTransfer.bind(client),
      { transferId: latest.transferId, clientId },
      { timeoutMs: GET_TRANSFER_TIMEOUT_MS },
    );
  }
  return latest;
}
