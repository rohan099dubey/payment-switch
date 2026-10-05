import type { Logger } from '@switch/common';
import { canTransition, isTerminal, type TransferState } from './states';
import type { Transfer } from './transfer';

/**
 * Zero rows matched the compare-and-set: another driver moved the transfer, or this one
 * lost its lease. Stop driving and do not retry the write (spec section 13).
 */
export class StaleTransferError extends Error {
  constructor(
    readonly transferId: string,
    readonly expectedVersion: number,
    readonly expectedState: TransferState,
  ) {
    super(`transfer ${transferId} is no longer at version ${expectedVersion} in ${expectedState} under this lease`);
    this.name = 'StaleTransferError';
  }
}

/** A transition the state machine does not allow. Always a programming error. */
export class IllegalTransitionError extends Error {
  constructor(
    readonly from: TransferState,
    readonly to: TransferState,
  ) {
    super(`illegal transfer transition ${from} -> ${to}`);
    this.name = 'IllegalTransitionError';
  }
}

/** Everything one compare-and-set needs. The store runs it as one transaction. */
export interface CasRequest {
  transferId: string;
  fromState: TransferState;
  fromVersion: number;
  toState: TransferState;
  leaseOwner: string;
  leaseMs: number;
  /** Terminal states also clear `lease_owner` and `lease_expires_at`. */
  terminal: boolean;
  failureCode: string | null;
  failureMessage: string | null;
  reason: string;
  detail: Record<string, unknown>;
}

export interface TransitionStore {
  /**
   * In one transaction: the CAS `UPDATE` on `(id, version, state, lease_owner)` and the
   * `transfer_events` insert. Returns the updated row, or `null` when zero rows matched
   * (and then nothing was written).
   */
  casTransition: (request: CasRequest) => Promise<Transfer | null>;
}

export interface TransitionOptions {
  reason: string;
  detail?: Record<string, unknown>;
  patch?: { failureCode?: string; failureMessage?: string };
}

export interface TransitionDeps {
  store: TransitionStore;
  leaseMs: number;
  logger: Logger;
}

/**
 * The only way a transfer changes state (spec sections 6 and 13): checks the edge against
 * the transition map, then compare-and-sets on version, state and lease owner, renews the
 * lease, resets `attempts`, and appends the event, all in one transaction.
 *
 * @throws IllegalTransitionError if the state machine forbids `transfer.state -> to`.
 * @throws StaleTransferError if zero rows matched.
 */
export async function transition(
  deps: TransitionDeps,
  transfer: Transfer,
  to: TransferState,
  leaseOwner: string,
  { reason, detail = {}, patch = {} }: TransitionOptions,
): Promise<Transfer> {
  if (!canTransition(transfer.state, to)) throw new IllegalTransitionError(transfer.state, to);

  const updated = await deps.store.casTransition({
    transferId: transfer.id,
    fromState: transfer.state,
    fromVersion: transfer.version,
    toState: to,
    leaseOwner,
    leaseMs: deps.leaseMs,
    terminal: isTerminal(to),
    failureCode: patch.failureCode ?? null,
    failureMessage: patch.failureMessage ?? null,
    reason,
    detail,
  });
  if (updated === null) throw new StaleTransferError(transfer.id, transfer.version, transfer.state);

  deps.logger.info(
    { transfer_id: transfer.id, from_state: transfer.state, to_state: to, reason, version: updated.version },
    'transfer state changed',
  );
  return updated;
}
