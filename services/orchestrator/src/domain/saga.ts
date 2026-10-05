import { classify, errorCodeOf, sleep, withRetry, type CallTarget, type ErrorClass, type Logger } from '@switch/common';
import { creditFailureCode, debitFailureCode, FailureCode } from './failureCodes';
import type { SagaPolicy } from './policy';
import { isTerminal, TransferState } from './states';
import type { Transfer } from './transfer';
import { StaleTransferError, transition, type TransitionOptions, type TransitionStore } from './transitions';

/** Per-call settings the saga hands a port: a deadline is mandatory (section 14). */
export interface CallOptions {
  timeoutMs: number;
  requestId?: string;
}

export interface BankReceipt {
  bankTxnId: string;
  /** The bank answered OK with status `APPLIED`. Anything else is a contract violation. */
  applied: boolean;
}

/** The payer's or payee's bank, chosen by the port from the transfer. Errors are thrown as received. */
export interface BankPort {
  debit: (transfer: Transfer, options: CallOptions) => Promise<BankReceipt>;
  credit: (transfer: Transfer, options: CallOptions) => Promise<BankReceipt>;
  reverseDebit: (transfer: Transfer, options: CallOptions) => Promise<BankReceipt>;
}

export type JournalLeg = 'debit-leg' | 'credit-leg' | 'reversal';

export interface LedgerPort {
  postLeg: (
    transfer: Transfer,
    leg: JournalLeg,
    options: CallOptions,
  ) => Promise<{ journalId: string; replayed: boolean }>;
}

export interface SagaStore extends TransitionStore {
  /**
   * `attempts + 1`, `next_attempt_at = now() + backoffMs`, lease released; guarded by
   * `(id, version, lease_owner)`. Returns the row, or `null` if it no longer matched.
   */
  yieldTransfer: (request: {
    transferId: string;
    version: number;
    leaseOwner: string;
    backoffMs: number;
  }) => Promise<Transfer | null>;
  getTransfer: (id: string) => Promise<Transfer | null>;
}

export interface Clock {
  now: () => number;
}

export type DownstreamOutcome = 'ok' | 'definite' | 'unknown' | 'bug';
export type SagaStep = 'debit' | 'credit' | 'reverse' | 'ledger';

/** Metrics hooks, so the engine has no prom-client dependency and tests can record calls. */
export interface SagaObserver {
  downstreamCall: (target: CallTarget, operation: string, outcome: DownstreamOutcome) => void;
  stepDuration: (step: SagaStep, seconds: number) => void;
  /** A transfer reached a terminal state (its `failureCode` is the manual-review reason). */
  terminal: (transfer: Transfer, durationSeconds: number) => void;
}

export interface SagaDeps {
  store: SagaStore;
  bank: BankPort;
  ledger: LedgerPort;
  policy: SagaPolicy;
  clock: Clock;
  logger: Logger;
  observer: SagaObserver;
  /** Injectable for deterministic tests; default `Math.random` / real `sleep`. */
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * `inline`: called from `CreateTransfer` with an absolute `deadline` (epoch ms). Every
 * downstream attempt is bounded by it, so `advance` returns within the budget (ADR-010).
 * `recovery`: called by the recovery worker (M6); full per-call timeouts, no deadline.
 */
export type SagaContext = { leaseOwner: string; requestId?: string } & (
  { mode: 'inline'; deadline: number } | { mode: 'recovery' }
);

type StepResult =
  | { kind: 'ok'; detail: Record<string, unknown> }
  | { kind: 'definite'; code: FailureCode; message: string; detail: Record<string, unknown> }
  | { kind: 'bug'; code: FailureCode; message: string; detail: Record<string, unknown> }
  | { kind: 'unknown'; message: string; detail: Record<string, unknown> };

type CallResult<T> = { ok: true; value: T } | { ok: false; errorClass: ErrorClass; err: unknown };

/** The inline budget ran out before an attempt could start. No call was made (ADR-010). */
export class BudgetExhaustedError extends Error {
  constructor(readonly remainingMs: number) {
    super(`inline saga budget exhausted (${Math.max(0, Math.round(remainingMs))} ms left)`);
    this.name = 'BudgetExhaustedError';
  }
}

/**
 * The only code that moves money (spec sections 6 and 11). `advance` loops until the
 * transfer is terminal, an outcome is unknown, the inline budget runs out, or the lease
 * or version is lost. A timeout never changes the state: only a definite answer does.
 */
export class SagaEngine {
  private readonly random: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly deps: SagaDeps) {
    this.random = deps.random ?? Math.random;
    this.sleep = deps.sleep ?? sleep;
  }

  async advance(transfer: Transfer, ctx: SagaContext): Promise<Transfer> {
    let t = transfer;
    try {
      while (!isTerminal(t.state)) {
        if (ctx.mode === 'inline' && this.deps.clock.now() > ctx.deadline) return await this.yield(t, ctx);

        switch (t.state) {
          case TransferState.INITIATED:
            t = await this.cas(t, TransferState.DEBIT_SENT, ctx, { reason: 'DEBIT_INTENT' });
            break;

          case TransferState.DEBIT_SENT: {
            const r = await this.debitStep(t, ctx);
            if (r.kind === 'ok')
              t = await this.cas(t, TransferState.DEBITED, ctx, { reason: 'DEBIT_CONFIRMED', detail: r.detail });
            else if (r.kind === 'definite') t = await this.fail(t, TransferState.FAILED, r, ctx);
            else if (r.kind === 'bug') t = await this.fail(t, TransferState.NEEDS_MANUAL_REVIEW, r, ctx);
            else return await this.yield(t, ctx, r);
            break;
          }

          case TransferState.DEBITED:
            t = await this.cas(t, TransferState.CREDIT_SENT, ctx, { reason: 'CREDIT_INTENT' });
            break;

          case TransferState.CREDIT_SENT: {
            const r = await this.creditStep(t, ctx);
            if (r.kind === 'ok')
              t = await this.cas(t, TransferState.CREDITED, ctx, { reason: 'CREDIT_CONFIRMED', detail: r.detail });
            else if (r.kind === 'definite') t = await this.fail(t, TransferState.REVERSING, r, ctx);
            else if (r.kind === 'bug') t = await this.fail(t, TransferState.NEEDS_MANUAL_REVIEW, r, ctx);
            else return await this.yield(t, ctx, r);
            break;
          }

          case TransferState.CREDITED:
            t = await this.cas(t, TransferState.SUCCESS, ctx, { reason: 'TRANSFER_COMPLETED' });
            break;

          case TransferState.REVERSING: {
            const r = await this.reverseStep(t, ctx);
            if (r.kind === 'ok')
              t = await this.cas(t, TransferState.REVERSED, ctx, { reason: 'REVERSAL_CONFIRMED', detail: r.detail });
            // reverseStep never reports `definite`: a refused refund is a broken invariant.
            else if (r.kind === 'bug' || r.kind === 'definite')
              t = await this.fail(t, TransferState.NEEDS_MANUAL_REVIEW, r, ctx);
            else return await this.yield(t, ctx, r);
            break;
          }

          default:
            // Unreachable: every non-terminal state is handled above.
            throw new Error(`advance: unhandled state ${t.state}`);
        }
      }
      return t;
    } catch (err) {
      if (!(err instanceof StaleTransferError)) throw err;
      // Another driver owns the transfer now. Stop, do not retry the write.
      this.deps.logger.warn(
        { transfer_id: t.id, state: t.state, version: t.version },
        'lost the transfer to another driver; stopped',
      );
      return (await this.deps.store.getTransfer(t.id)) ?? t;
    }
  }

  // ---------------------------------------------------------------- steps

  /** Payer bank `Debit` (reference id = transfer id), then the `debit-leg` journal. */
  private async debitStep(t: Transfer, ctx: SagaContext): Promise<StepResult> {
    const bank = await this.call(
      t,
      {
        target: 'bank',
        operation: 'Debit',
        bankId: t.payer.bankId,
        step: 'debit',
        attempts: this.deps.policy.bankAttempts,
        timeoutMs: this.deps.policy.bankCallTimeoutMs,
      },
      ctx,
      (o) => this.deps.bank.debit(t, o),
    );
    if (!bank.ok) return bankFailure(bank, debitFailureCode, { bank_id: t.payer.bankId });
    if (!bank.value.applied) return violation('Debit answered OK without APPLIED', bank.value.bankTxnId);
    return this.ledgerLeg(t, 'debit-leg', ctx, { bank_txn_id: bank.value.bankTxnId });
  }

  /** Payee bank `Credit`, then `credit-leg`. A definite failure here means `REVERSING`. */
  private async creditStep(t: Transfer, ctx: SagaContext): Promise<StepResult> {
    const bank = await this.call(
      t,
      {
        target: 'bank',
        operation: 'Credit',
        bankId: t.payee.bankId,
        step: 'credit',
        attempts: this.deps.policy.bankAttempts,
        timeoutMs: this.deps.policy.bankCallTimeoutMs,
      },
      ctx,
      (o) => this.deps.bank.credit(t, o),
    );
    if (!bank.ok) return bankFailure(bank, creditFailureCode, { bank_id: t.payee.bankId });
    if (!bank.value.applied) return violation('Credit answered OK without APPLIED', bank.value.bankTxnId);
    return this.ledgerLeg(t, 'credit-leg', ctx, { bank_txn_id: bank.value.bankTxnId });
  }

  /** Payer bank `ReverseDebit`, then `reversal`. Any definite refusal is a bug (section 6). */
  private async reverseStep(t: Transfer, ctx: SagaContext): Promise<StepResult> {
    const bank = await this.call(
      t,
      {
        target: 'bank',
        operation: 'ReverseDebit',
        bankId: t.payer.bankId,
        step: 'reverse',
        attempts: this.deps.policy.bankAttempts,
        timeoutMs: this.deps.policy.bankCallTimeoutMs,
      },
      ctx,
      (o) => this.deps.bank.reverseDebit(t, o),
    );
    if (!bank.ok) return bankFailure(bank, () => null, { bank_id: t.payer.bankId });
    if (!bank.value.applied) return violation('ReverseDebit answered OK without APPLIED', bank.value.bankTxnId);
    return this.ledgerLeg(t, 'reversal', ctx, { bank_txn_id: bank.value.bankTxnId });
  }

  private async ledgerLeg(
    t: Transfer,
    leg: JournalLeg,
    ctx: SagaContext,
    bankDetail: Record<string, unknown>,
  ): Promise<StepResult> {
    const posted = await this.call(
      t,
      {
        target: 'ledger',
        operation: 'PostJournal',
        step: 'ledger',
        attempts: this.deps.policy.ledgerAttempts,
        timeoutMs: this.deps.policy.ledgerCallTimeoutMs,
      },
      ctx,
      (o) => this.deps.ledger.postLeg(t, leg, o),
    );
    if (posted.ok) {
      return {
        kind: 'ok',
        detail: { ...bankDetail, journal_id: posted.value.journalId, journal_replayed: posted.value.replayed },
      };
    }
    const detail = { ...bankDetail, leg, ...errorDetail(posted.err) };
    // classify never calls a ledger error DEFINITE_FAILURE; if it ever did, it is still not a business answer.
    if (posted.errorClass === 'UNKNOWN_OUTCOME') return { kind: 'unknown', message: errorMessage(posted.err), detail };
    return { kind: 'bug', code: FailureCode.LEDGER_REJECTED, message: errorMessage(posted.err), detail };
  }

  // ---------------------------------------------------------------- plumbing

  /**
   * One downstream call with inline retries for `UNKNOWN_OUTCOME` only (section 14). In
   * inline mode each attempt is skipped if the budget is nearly spent, and its gRPC
   * deadline is clipped to what is left of the budget (ADR-010).
   */
  private async call<T>(
    t: Transfer,
    spec: {
      target: CallTarget;
      operation: string;
      step: SagaStep;
      attempts: number;
      timeoutMs: number;
      bankId?: string;
    },
    ctx: SagaContext,
    fn: (options: CallOptions) => Promise<T>,
  ): Promise<CallResult<T>> {
    const { policy, clock, observer } = this.deps;
    const { target, operation, step, attempts, timeoutMs: callTimeoutMs } = spec;
    // One log line per downstream call result (section 17 standard fields).
    const logger = this.deps.logger.child({
      transfer_id: t.id,
      target,
      operation,
      ...(spec.bankId === undefined ? {} : { bank_id: spec.bankId }),
    });
    const started = clock.now();
    try {
      const value = await withRetry(
        async () => {
          let timeoutMs = callTimeoutMs;
          if (ctx.mode === 'inline') {
            const remainingMs = ctx.deadline - clock.now();
            if (remainingMs < policy.minAttemptMs) throw new BudgetExhaustedError(remainingMs);
            timeoutMs = Math.min(callTimeoutMs, remainingMs);
          }
          const attemptStarted = clock.now();
          try {
            const result = await fn(
              ctx.requestId === undefined ? { timeoutMs } : { timeoutMs, requestId: ctx.requestId },
            );
            observer.downstreamCall(target, operation, 'ok');
            logger.info(
              { outcome: 'ok', duration_ms: clock.now() - attemptStarted, timeout_ms: timeoutMs },
              'downstream call succeeded',
            );
            return result;
          } catch (err) {
            const outcome = toOutcome(classify(err, target));
            observer.downstreamCall(target, operation, outcome);
            logger.info(
              { outcome, ...errorDetail(err), duration_ms: clock.now() - attemptStarted, timeout_ms: timeoutMs },
              'downstream call failed',
            );
            throw err;
          }
        },
        {
          attempts,
          baseMs: policy.retryBaseMs,
          maxMs: policy.retryMaxMs,
          shouldRetry: (err) => !(err instanceof BudgetExhaustedError) && classify(err, target) === 'UNKNOWN_OUTCOME',
          random: this.random,
          // Inline, a backoff never sleeps past the deadline: the next attempt then sees
          // the budget spent and stops, so advance returns within the budget (ADR-010).
          sleep: (ms) => {
            const capped = ctx.mode === 'inline' ? Math.min(ms, Math.max(0, ctx.deadline - clock.now())) : ms;
            return this.sleep(capped);
          },
        },
      );
      return { ok: true, value };
    } catch (err) {
      if (err instanceof BudgetExhaustedError) logger.info({ outcome: 'unknown' }, err.message);
      return { ok: false, errorClass: classify(err, target), err };
    } finally {
      observer.stepDuration(step, (clock.now() - started) / 1000);
    }
  }

  private async cas(t: Transfer, to: TransferState, ctx: SagaContext, options: TransitionOptions): Promise<Transfer> {
    const detail =
      ctx.requestId === undefined ? (options.detail ?? {}) : { ...options.detail, request_id: ctx.requestId };
    const updated = await transition(
      { store: this.deps.store, leaseMs: this.deps.policy.leaseMs, logger: this.deps.logger },
      t,
      to,
      ctx.leaseOwner,
      { ...options, detail },
    );
    if (isTerminal(updated.state)) {
      this.deps.observer.terminal(updated, Math.max(0, (this.deps.clock.now() - updated.createdAt.getTime()) / 1000));
    }
    return updated;
  }

  private fail(
    t: Transfer,
    to: TransferState,
    r: { code: FailureCode; message: string; detail: Record<string, unknown> },
    ctx: SagaContext,
  ): Promise<Transfer> {
    return this.cas(t, to, ctx, {
      reason: r.code,
      detail: r.detail,
      patch: { failureCode: r.code, failureMessage: r.message },
    });
  }

  /**
   * Hands the transfer to recovery (section 6): `attempts + 1`, `next_attempt_at = now() +
   * backoff(attempts)`, lease released. The state is unchanged: an unknown outcome is
   * never a failure.
   */
  private async yield(t: Transfer, ctx: SagaContext, cause?: StepResult): Promise<Transfer> {
    const attempts = t.attempts + 1;
    const backoffMs = this.deps.policy.recoveryBackoffMs(attempts);
    const yielded = await this.deps.store.yieldTransfer({
      transferId: t.id,
      version: t.version,
      leaseOwner: ctx.leaseOwner,
      backoffMs,
    });
    this.deps.logger.info(
      {
        transfer_id: t.id,
        state: t.state,
        attempts,
        backoff_ms: backoffMs,
        mode: ctx.mode,
        ...(cause?.kind === 'unknown' ? { cause: cause.message } : {}),
        stale: yielded === null,
      },
      'saga yielded to recovery',
    );
    if (yielded !== null) return yielded;
    return (await this.deps.store.getTransfer(t.id)) ?? t;
  }
}

function toOutcome(errorClass: ErrorClass): DownstreamOutcome {
  switch (errorClass) {
    case 'DEFINITE_FAILURE':
      return 'definite';
    case 'BUG':
      return 'bug';
    case 'UNKNOWN_OUTCOME':
      return 'unknown';
  }
}

/**
 * A failed bank call as a step result. A definite failure whose error code the step's
 * table does not know is treated as a bug, never guessed into a failure branch (ADR-018).
 */
function bankFailure(
  result: { errorClass: ErrorClass; err: unknown },
  failureCodeOf: (bankErrorCode: string | undefined) => FailureCode | null,
  base: Record<string, unknown>,
): StepResult {
  const message = errorMessage(result.err);
  const detail = { ...base, ...errorDetail(result.err) };
  switch (result.errorClass) {
    case 'UNKNOWN_OUTCOME':
      return { kind: 'unknown', message, detail };
    case 'BUG':
      return { kind: 'bug', code: FailureCode.BANK_INVARIANT_VIOLATION, message, detail };
    case 'DEFINITE_FAILURE': {
      const code = failureCodeOf(errorCodeOf(result.err));
      return code === null
        ? { kind: 'bug', code: FailureCode.BANK_INVARIANT_VIOLATION, message, detail }
        : { kind: 'definite', code, message, detail };
    }
  }
}

function violation(message: string, bankTxnId: string): StepResult {
  return { kind: 'bug', code: FailureCode.BANK_INVARIANT_VIOLATION, message, detail: { bank_txn_id: bankTxnId } };
}

function errorMessage(err: unknown): string {
  if (typeof err === 'object' && err !== null) {
    const details = (err as { details?: unknown }).details;
    if (typeof details === 'string' && details !== '') return details;
  }
  return err instanceof Error ? err.message : String(err);
}

function errorDetail(err: unknown): Record<string, unknown> {
  const grpcCode = typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined;
  const errorCode = errorCodeOf(err);
  return {
    ...(typeof grpcCode === 'number' ? { grpc_code: grpcCode } : {}),
    ...(errorCode === undefined ? {} : { error_code: errorCode }),
    message: errorMessage(err),
  };
}
