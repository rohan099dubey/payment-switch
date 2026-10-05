/** The ten transfer states (spec section 11). Values match the `transfers.state` CHECK. */
export const TransferState = {
  INITIATED: 'INITIATED',
  DEBIT_SENT: 'DEBIT_SENT',
  DEBITED: 'DEBITED',
  CREDIT_SENT: 'CREDIT_SENT',
  CREDITED: 'CREDITED',
  SUCCESS: 'SUCCESS',
  FAILED: 'FAILED',
  REVERSING: 'REVERSING',
  REVERSED: 'REVERSED',
  NEEDS_MANUAL_REVIEW: 'NEEDS_MANUAL_REVIEW',
} as const;

export type TransferState = (typeof TransferState)[keyof typeof TransferState];

export const ALL_STATES: readonly TransferState[] = Object.values(TransferState);

export const TERMINAL_STATES: ReadonlySet<TransferState> = new Set<TransferState>([
  TransferState.SUCCESS,
  TransferState.FAILED,
  TransferState.REVERSED,
  TransferState.NEEDS_MANUAL_REVIEW,
]);

/** The non-terminal states, in the order the recovery claim query lists them. */
export const NON_TERMINAL_STATES: readonly TransferState[] = ALL_STATES.filter((s) => !TERMINAL_STATES.has(s));

/**
 * Every legal edge. Terminal states have none: nothing ever leaves a terminal state.
 * `NEEDS_MANUAL_REVIEW` is reachable from every non-terminal state, because recovery
 * exhaustion (section 6, step 3) can strike anywhere. The other edges are exactly the
 * transition table in section 11.
 */
export const ALLOWED_TRANSITIONS: Readonly<Record<TransferState, readonly TransferState[]>> = {
  INITIATED: [TransferState.DEBIT_SENT, TransferState.NEEDS_MANUAL_REVIEW],
  DEBIT_SENT: [TransferState.DEBITED, TransferState.FAILED, TransferState.NEEDS_MANUAL_REVIEW],
  DEBITED: [TransferState.CREDIT_SENT, TransferState.NEEDS_MANUAL_REVIEW],
  CREDIT_SENT: [TransferState.CREDITED, TransferState.REVERSING, TransferState.NEEDS_MANUAL_REVIEW],
  CREDITED: [TransferState.SUCCESS, TransferState.NEEDS_MANUAL_REVIEW],
  REVERSING: [TransferState.REVERSED, TransferState.NEEDS_MANUAL_REVIEW],
  SUCCESS: [],
  FAILED: [],
  REVERSED: [],
  NEEDS_MANUAL_REVIEW: [],
};

export function isTerminal(state: TransferState): boolean {
  return TERMINAL_STATES.has(state);
}

export function canTransition(from: TransferState, to: TransferState): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export function isTransferState(value: string): value is TransferState {
  return (ALL_STATES as readonly string[]).includes(value);
}
