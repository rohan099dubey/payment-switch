/**
 * In-memory fakes for saga unit tests. No database: the fake store applies the same
 * compare-and-set guard as the SQL (id, version, state, lease owner), so the saga is
 * tested against the real contract, not a looser one.
 */
import { status as Status } from '@grpc/grpc-js';
import { createLogger, makeGrpcError, type CallTarget } from '@switch/common';
import type {
  BankPort,
  BankReceipt,
  CallOptions,
  Clock,
  DownstreamOutcome,
  JournalLeg,
  LedgerPort,
  Resolution,
  SagaObserver,
  SagaStep,
  SagaStore,
} from '../../src/domain/saga';
import type { SagaPolicy } from '../../src/domain/policy';
import { TransferState } from '../../src/domain/states';
import type { Transfer } from '../../src/domain/transfer';
import type { CasRequest } from '../../src/domain/transitions';

export const LEASE_OWNER = 'test-instance:lease-1';

export const silentLogger = createLogger('test', { level: 'silent' });

export function makeTransfer(overrides: Partial<Transfer> = {}): Transfer {
  const now = new Date(0);
  return {
    id: '00000000-0000-4000-8000-000000000001',
    clientId: 'client-1',
    idempotencyKey: 'key-1',
    requestHash: 'hash',
    payer: { bankId: 'bank_a', accountId: 'A1' },
    payee: { bankId: 'bank_b', accountId: 'B1' },
    amount: 12_500n,
    currency: 'INR',
    note: null,
    state: TransferState.INITIATED,
    failureCode: null,
    failureMessage: null,
    version: 1,
    attempts: 0,
    nextAttemptAt: now,
    leaseOwner: LEASE_OWNER,
    leaseExpiresAt: new Date(15_000),
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

export interface RecordedEvent {
  from: TransferState;
  to: TransferState;
  reason: string;
  detail: Record<string, unknown>;
}

/** Every write and every downstream call, in order, so tests can assert sequencing. */
export type TimelineEntry =
  { kind: 'cas'; to: TransferState } | { kind: 'yield' } | { kind: 'call'; name: string; stateAtCall: TransferState };

export class FakeStore implements SagaStore {
  readonly events: RecordedEvent[] = [];
  readonly casRequests: CasRequest[] = [];
  yields = 0;
  lastBackoffMs: number | undefined;
  /** Makes the next CAS behave as if another driver had moved the row. */
  stealOnNextCas = false;

  constructor(
    public row: Transfer,
    private readonly timeline: TimelineEntry[],
  ) {}

  casTransition(req: CasRequest): Promise<Transfer | null> {
    this.casRequests.push(req);
    if (this.stealOnNextCas) {
      this.stealOnNextCas = false;
      this.row = { ...this.row, version: this.row.version + 1, leaseOwner: 'someone-else' };
    }
    const r = this.row;
    if (
      r.id !== req.transferId ||
      r.version !== req.fromVersion ||
      r.state !== req.fromState ||
      r.leaseOwner !== req.leaseOwner
    ) {
      return Promise.resolve(null);
    }
    this.row = {
      ...r,
      state: req.toState,
      version: r.version + 1,
      attempts: 0,
      failureCode: req.failureCode ?? r.failureCode,
      failureMessage: req.failureMessage ?? r.failureMessage,
      leaseOwner: req.terminal ? null : r.leaseOwner,
      leaseExpiresAt: req.terminal ? null : r.leaseExpiresAt,
    };
    this.events.push({ from: req.fromState, to: req.toState, reason: req.reason, detail: req.detail });
    this.timeline.push({ kind: 'cas', to: req.toState });
    return Promise.resolve(this.row);
  }

  yieldTransfer(req: {
    transferId: string;
    version: number;
    leaseOwner: string;
    backoffMs: number;
  }): Promise<Transfer | null> {
    const r = this.row;
    if (r.id !== req.transferId || r.version !== req.version || r.leaseOwner !== req.leaseOwner)
      return Promise.resolve(null);
    this.yields++;
    this.lastBackoffMs = req.backoffMs;
    this.row = { ...r, attempts: r.attempts + 1, leaseOwner: null, leaseExpiresAt: null };
    this.timeline.push({ kind: 'yield' });
    return Promise.resolve(this.row);
  }

  getTransfer(id: string): Promise<Transfer | null> {
    return Promise.resolve(this.row.id === id ? this.row : null);
  }
}

/** What one fake downstream call does: answer, throw, or take time first. */
export type Script =
  { ok: true; txnId?: string; applied?: boolean } | { resolved: Resolution } | { error: unknown } | { hang: true };

export const ok = (txnId = 'txn'): Script => ({ ok: true, txnId });
export const fail = (code: Status, errorCode: string): Script => ({
  error: makeGrpcError(code, errorCode, `${errorCode} from fake`),
});
export const unavailable = (): Script => fail(Status.UNAVAILABLE, 'BANK_UNAVAILABLE');
export const deadline = (): Script => fail(Status.DEADLINE_EXCEEDED, 'DEADLINE');
/** Hangs until the call's own timeout passes, then fails with DEADLINE_EXCEEDED, like grpc-js. */
export const hang = (): Script => ({ hang: true });

export class FakeClock implements Clock {
  constructor(public t = 1_000_000) {}
  now = (): number => this.t;
  sleep = (ms: number): Promise<void> => {
    this.t += ms;
    return Promise.resolve();
  };
}

export interface RecordedCall {
  name: string;
  timeoutMs: number;
  requestId: string | undefined;
}

/**
 * Downstream fakes. Each operation has a queue of scripted answers; once the queue is
 * empty the default answer (`ok`) repeats. A `hang` advances the fake clock by the
 * call's timeout, so budget arithmetic is exercised for real.
 */
export class FakeDownstream {
  readonly calls: RecordedCall[] = [];
  private readonly scripts = new Map<string, Script[]>();

  constructor(
    private readonly clock: FakeClock,
    private readonly store: () => FakeStore,
    private readonly timeline: TimelineEntry[],
  ) {}

  script(
    name: 'Debit' | 'Credit' | 'ReverseDebit' | 'Resolve:DEBIT' | 'Resolve:CREDIT' | `PostJournal:${JournalLeg}`,
    ...answers: Script[]
  ): this {
    this.scripts.set(name, [...(this.scripts.get(name) ?? []), ...answers]);
    return this;
  }

  callsTo(name: string): RecordedCall[] {
    return this.calls.filter((c) => c.name === name);
  }

  private async run(
    name: string,
    options: CallOptions,
  ): Promise<{ txnId: string; applied: boolean; resolved: Resolution }> {
    this.calls.push({ name, timeoutMs: options.timeoutMs, requestId: options.requestId });
    this.timeline.push({ kind: 'call', name, stateAtCall: this.store().row.state });
    const next = this.scripts.get(name)?.shift() ?? ok();
    if ('hang' in next) {
      await this.clock.sleep(options.timeoutMs);
      throw makeGrpcError(Status.DEADLINE_EXCEEDED, 'DEADLINE', 'Deadline exceeded');
    }
    if ('error' in next) throw next.error;
    if ('resolved' in next) return { txnId: 'txn', applied: true, resolved: next.resolved };
    return { txnId: next.txnId ?? 'txn', applied: next.applied ?? true, resolved: 'APPLIED' };
  }

  bank(): BankPort {
    const receipt = async (name: string, o: CallOptions): Promise<BankReceipt> => {
      const r = await this.run(name, o);
      return { bankTxnId: r.txnId, applied: r.applied };
    };
    return {
      debit: (_t, o) => receipt('Debit', o),
      credit: (_t, o) => receipt('Credit', o),
      reverseDebit: (_t, o) => receipt('ReverseDebit', o),
      resolve: async (_t, operation, o) => (await this.run(`Resolve:${operation}`, o)).resolved,
    };
  }

  ledger(): LedgerPort {
    return {
      postLeg: async (_t, leg, o) => {
        const r = await this.run(`PostJournal:${leg}`, o);
        return { journalId: `journal-${leg}-${r.txnId}`, replayed: false };
      },
    };
  }
}

export class RecordingObserver implements SagaObserver {
  readonly downstream: { target: CallTarget; operation: string; outcome: DownstreamOutcome }[] = [];
  readonly steps: SagaStep[] = [];
  readonly terminals: { state: TransferState; failureCode: string | null }[] = [];

  downstreamCall = (target: CallTarget, operation: string, outcome: DownstreamOutcome): void => {
    this.downstream.push({ target, operation, outcome });
  };
  stepDuration = (step: SagaStep): void => {
    this.steps.push(step);
  };
  terminal = (transfer: Transfer): void => {
    this.terminals.push({ state: transfer.state, failureCode: transfer.failureCode });
  };
}

export function testPolicy(overrides: Partial<SagaPolicy> = {}): SagaPolicy {
  return {
    bankCallTimeoutMs: 2000,
    ledgerCallTimeoutMs: 2000,
    bankAttempts: 3,
    ledgerAttempts: 3,
    retryBaseMs: 100,
    retryMaxMs: 800,
    minAttemptMs: 100,
    inlineBudgetMs: 8000,
    leaseMs: 15_000,
    recoveryBackoffMs: (attempts) => 1000 * 2 ** attempts,
    ...overrides,
  };
}
