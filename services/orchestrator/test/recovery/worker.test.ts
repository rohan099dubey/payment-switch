import { status as Status } from '@grpc/grpc-js';
import { describe, expect, it } from 'vitest';
import { FailureCode } from '../../src/domain/failureCodes';
import { SagaEngine, type BankPort, type SagaStore } from '../../src/domain/saga';
import { isTerminal, NON_TERMINAL_STATES, TransferState } from '../../src/domain/states';
import type { Transfer } from '../../src/domain/transfer';
import type { CasRequest } from '../../src/domain/transitions';
import {
  recoveryAction,
  RecoveryWorker,
  type RecoveryConfig,
  type RecoveryResult,
  type RecoveryStore,
} from '../../src/recovery/worker';
import {
  fail,
  FakeClock,
  FakeDownstream,
  FakeStore,
  makeTransfer,
  RecordingObserver,
  silentLogger,
  testPolicy,
  unavailable,
  type TimelineEntry,
} from '../domain/fakes';

const S = TransferState;
const CONFIG: RecoveryConfig = {
  pollMs: 10,
  batch: 20,
  concurrency: 5,
  leaseMs: 15_000,
  resolveAfterAttempts: 3,
  maxRecoveryAttempts: 20,
};

/** Many rows, each guarded by a FakeStore (same CAS rules as the SQL), plus the claim query. */
class MapStore implements SagaStore, RecoveryStore {
  readonly rows = new Map<string, FakeStore>();
  readonly released: string[] = [];
  readonly lapsed = new Set<string>();
  claims = 0;

  constructor(private readonly timeline: TimelineEntry[]) {}

  add(t: Transfer): void {
    this.rows.set(t.id, new FakeStore({ ...t, leaseOwner: null, leaseExpiresAt: null }, this.timeline));
  }
  row(id: string): Transfer {
    const r = this.rows.get(id)?.row;
    if (r === undefined) throw new Error(`no row ${id}`);
    return r;
  }
  first(): FakeStore {
    const [f] = this.rows.values();
    if (f === undefined) throw new Error('empty store');
    return f;
  }
  private of(id: string): FakeStore {
    const f = this.rows.get(id);
    if (f === undefined) throw new Error(`no row ${id}`);
    return f;
  }

  casTransition = (req: CasRequest): Promise<Transfer | null> => this.of(req.transferId).casTransition(req);
  yieldTransfer = (req: {
    transferId: string;
    version: number;
    leaseOwner: string;
    backoffMs: number;
  }): Promise<Transfer | null> => this.of(req.transferId).yieldTransfer(req);
  getTransfer = (id: string): Promise<Transfer | null> => Promise.resolve(this.rows.get(id)?.row ?? null);

  claimDue = (leaseOwner: string, _leaseMs: number, limit: number): Promise<Transfer[]> => {
    this.claims++;
    const claimed: Transfer[] = [];
    for (const f of this.rows.values()) {
      if (claimed.length >= limit) break;
      if (isTerminal(f.row.state) || f.row.leaseOwner !== null) continue;
      f.row = { ...f.row, leaseOwner };
      claimed.push(f.row);
    }
    return Promise.resolve(claimed);
  };
  renewLease = (id: string, leaseOwner: string): Promise<Transfer | null> => {
    const f = this.of(id);
    return Promise.resolve(!this.lapsed.has(id) && f.row.leaseOwner === leaseOwner ? f.row : null);
  };
  releaseLease = (id: string, leaseOwner: string): Promise<boolean> => {
    const f = this.of(id);
    if (f.row.leaseOwner !== leaseOwner) return Promise.resolve(false);
    f.row = { ...f.row, leaseOwner: null };
    this.released.push(id);
    return Promise.resolve(true);
  };
  countInFlight = (): Promise<Map<TransferState, number>> => {
    const counts = new Map<TransferState, number>(NON_TERMINAL_STATES.map((s) => [s, 0]));
    for (const f of this.rows.values()) {
      if (!isTerminal(f.row.state)) counts.set(f.row.state, (counts.get(f.row.state) ?? 0) + 1);
    }
    return Promise.resolve(counts);
  };
}

interface Harness {
  store: MapStore;
  downstream: FakeDownstream;
  worker: RecoveryWorker;
  results: RecoveryResult[];
  inFlight: Map<TransferState, number>[];
  observer: RecordingObserver;
}

function setup(
  transfers: Partial<Transfer>[],
  options: { bank?: BankPort; config?: Partial<RecoveryConfig> } = {},
): Harness {
  const clock = new FakeClock();
  const timeline: TimelineEntry[] = [];
  const store = new MapStore(timeline);
  transfers.forEach((t, i) => {
    store.add(makeTransfer({ id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`, ...t }));
  });
  const downstream = new FakeDownstream(clock, () => store.first(), timeline);
  const observer = new RecordingObserver();
  const results: RecoveryResult[] = [];
  const inFlight: Map<TransferState, number>[] = [];
  const saga = new SagaEngine({
    store,
    bank: options.bank ?? downstream.bank(),
    ledger: downstream.ledger(),
    policy: testPolicy(),
    clock,
    logger: silentLogger,
    observer,
    random: () => 0.5,
    sleep: clock.sleep,
  });
  const worker = new RecoveryWorker({
    store,
    saga,
    config: { ...CONFIG, ...options.config },
    instanceId: 'orch-test',
    logger: silentLogger,
    observer: {
      run: (r) => results.push(r),
      inFlight: (c) => inFlight.push(c),
    },
  });
  return { store, downstream, worker, results, inFlight, observer };
}

const ID1 = '00000000-0000-4000-8000-000000000001';
const reasons = (h: Harness, id = ID1): string[] =>
  (h.store.rows.get(id)?.events ?? []).map((e) => `${e.to}:${e.reason}`);

describe('recoveryAction (section 6, recovery steps 2 and 3)', () => {
  const t = (state: TransferState, attempts: number): Transfer => makeTransfer({ state, attempts });
  it.each([
    [S.INITIATED, 0, 'advance'],
    [S.DEBITED, 5, 'advance'],
    [S.CREDITED, 19, 'advance'],
    [S.DEBIT_SENT, 0, 'advance'],
    [S.DEBIT_SENT, 2, 'advance'],
    [S.DEBIT_SENT, 3, 'resolve'],
    [S.CREDIT_SENT, 2, 'advance'],
    [S.CREDIT_SENT, 7, 'resolve'],
    [S.REVERSING, 3, 'advance'],
    [S.REVERSING, 19, 'advance'],
    [S.REVERSING, 20, 'exhaust'],
    [S.DEBIT_SENT, 20, 'exhaust'],
    [S.INITIATED, 25, 'exhaust'],
  ] as const)('%s with attempts %i -> %s', (state, attempts, action) => {
    expect(recoveryAction(t(state, attempts), CONFIG)).toBe(action);
  });

  it('REVERSING is never settled by Resolve, at any attempt count below the limit', () => {
    for (let attempts = 0; attempts < 20; attempts++) {
      expect(recoveryAction(t(S.REVERSING, attempts), CONFIG)).toBe('advance');
    }
  });
});

describe('RecoveryWorker.runOnce — advance', () => {
  it('DEBIT_SENT below the Resolve threshold repeats the idempotent Debit and finishes', async () => {
    const h = setup([{ state: S.DEBIT_SENT, attempts: 2, version: 2 }]);
    expect(await h.worker.runOnce()).toEqual(['advanced']);
    expect(h.store.row(ID1).state).toBe(S.SUCCESS);
    expect(h.downstream.callsTo('Debit')).toHaveLength(1);
    expect(h.downstream.callsTo('Resolve:DEBIT')).toHaveLength(0);
  });

  it('INITIATED left by a crash before the first CAS is driven from the start', async () => {
    const h = setup([{ state: S.INITIATED }]);
    expect(await h.worker.runOnce()).toEqual(['advanced']);
    expect(reasons(h)[0]).toBe('DEBIT_SENT:DEBIT_INTENT');
    expect(h.store.row(ID1).state).toBe(S.SUCCESS);
  });

  it('an unknown outcome yields again: same state, attempts + 1, lease released, result "yielded"', async () => {
    const h = setup([{ state: S.CREDIT_SENT, attempts: 1 }]);
    h.downstream.script('Credit', unavailable(), unavailable(), unavailable());
    expect(await h.worker.runOnce()).toEqual(['yielded']);
    expect(h.store.row(ID1)).toMatchObject({ state: S.CREDIT_SENT, attempts: 2, leaseOwner: null });
  });

  it('REVERSING at attempts >= 3 retries ReverseDebit, never Resolve', async () => {
    const h = setup([{ state: S.REVERSING, attempts: 9, failureCode: 'PAYEE_ACCOUNT_NOT_FOUND' }]);
    expect(await h.worker.runOnce()).toEqual(['advanced']);
    expect(h.store.row(ID1).state).toBe(S.REVERSED);
    expect(h.downstream.callsTo('ReverseDebit')).toHaveLength(1);
    expect(h.downstream.calls.filter((c) => c.name.startsWith('Resolve'))).toEqual([]);
  });

  it('recovery events record the driver and the recovery lease owner', async () => {
    const h = setup([{ state: S.DEBITED }]);
    await h.worker.runOnce();
    const events = h.store.rows.get(ID1)?.events ?? [];
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) {
      expect(e.detail.driver).toBe('recovery');
      expect(String(e.detail.lease_owner)).toMatch(/^orch-test:recovery:/);
      expect(e.detail.request_id).toBeUndefined();
    }
  });
});

describe('RecoveryWorker.runOnce — Resolve for *_SENT at attempts >= RESOLVE_AFTER_ATTEMPTS', () => {
  it('DEBIT_SENT, APPLIED: posts the debit leg, DEBITED, then carries on to SUCCESS without a new Debit', async () => {
    const h = setup([{ state: S.DEBIT_SENT, attempts: 3 }]);
    h.downstream.script('Resolve:DEBIT', { resolved: 'APPLIED' });
    expect(await h.worker.runOnce()).toEqual(['resolved_applied']);
    expect(h.store.row(ID1).state).toBe(S.SUCCESS);
    expect(reasons(h)).toEqual([
      'DEBITED:DEBIT_CONFIRMED_BY_RESOLVE',
      'CREDIT_SENT:CREDIT_INTENT',
      'CREDITED:CREDIT_CONFIRMED',
      'SUCCESS:TRANSFER_COMPLETED',
    ]);
    expect(h.downstream.callsTo('Debit')).toHaveLength(0);
    expect(h.downstream.callsTo('PostJournal:debit-leg')).toHaveLength(1);
  });

  it('DEBIT_SENT, VOIDED: FAILED / DEBIT_NOT_CONFIRMED, nothing posted, no Debit', async () => {
    const h = setup([{ state: S.DEBIT_SENT, attempts: 3 }]);
    h.downstream.script('Resolve:DEBIT', { resolved: 'VOIDED' });
    expect(await h.worker.runOnce()).toEqual(['resolved_voided']);
    expect(h.store.row(ID1)).toMatchObject({ state: S.FAILED, failureCode: FailureCode.DEBIT_NOT_CONFIRMED });
    expect(h.downstream.calls.map((c) => c.name)).toEqual(['Resolve:DEBIT']);
  });

  it('CREDIT_SENT, VOIDED: REVERSING / CREDIT_NOT_CONFIRMED, then refunded to REVERSED', async () => {
    const h = setup([{ state: S.CREDIT_SENT, attempts: 4 }]);
    h.downstream.script('Resolve:CREDIT', { resolved: 'VOIDED' });
    expect(await h.worker.runOnce()).toEqual(['resolved_voided']);
    expect(h.store.row(ID1)).toMatchObject({ state: S.REVERSED, failureCode: FailureCode.CREDIT_NOT_CONFIRMED });
    expect(reasons(h)).toEqual(['REVERSING:CREDIT_NOT_CONFIRMED', 'REVERSED:REVERSAL_CONFIRMED']);
    expect(h.downstream.calls.map((c) => c.name)).toEqual(['Resolve:CREDIT', 'ReverseDebit', 'PostJournal:reversal']);
  });

  it('CREDIT_SENT, APPLIED: posts the credit leg, CREDITED, SUCCESS', async () => {
    const h = setup([{ state: S.CREDIT_SENT, attempts: 3 }]);
    h.downstream.script('Resolve:CREDIT', { resolved: 'APPLIED' });
    expect(await h.worker.runOnce()).toEqual(['resolved_applied']);
    expect(h.store.row(ID1).state).toBe(S.SUCCESS);
    expect(h.downstream.callsTo('Credit')).toHaveLength(0);
  });

  it('Resolve unreachable: yield, state kept (a timeout is never a failure)', async () => {
    const h = setup([{ state: S.DEBIT_SENT, attempts: 3 }]);
    h.downstream.script('Resolve:DEBIT', unavailable(), unavailable(), unavailable());
    expect(await h.worker.runOnce()).toEqual(['yielded']);
    expect(h.store.row(ID1)).toMatchObject({ state: S.DEBIT_SENT, attempts: 4, failureCode: null });
  });

  it('APPLIED but the Ledger is down: yield in DEBIT_SENT; the next run resolves again and posts', async () => {
    const h = setup([{ state: S.DEBIT_SENT, attempts: 3 }]);
    h.downstream
      .script('Resolve:DEBIT', { resolved: 'APPLIED' }, { resolved: 'APPLIED' })
      .script('PostJournal:debit-leg', unavailable(), unavailable(), unavailable());
    expect(await h.worker.runOnce()).toEqual(['resolved_applied']);
    expect(h.store.row(ID1)).toMatchObject({ state: S.DEBIT_SENT, attempts: 4 });
    expect(await h.worker.runOnce()).toEqual(['resolved_applied']);
    expect(h.store.row(ID1).state).toBe(S.SUCCESS);
  });

  it.each([
    [
      'an answer that is neither APPLIED nor VOIDED',
      { resolved: 'INVALID' as const },
      FailureCode.BANK_INVARIANT_VIOLATION,
    ],
    ['a BUG-class error', fail(Status.INVALID_ARGUMENT, 'INVALID_REQUEST'), FailureCode.BANK_INVARIANT_VIOLATION],
  ])('%s -> NEEDS_MANUAL_REVIEW', async (_name, answer, code) => {
    const h = setup([{ state: S.DEBIT_SENT, attempts: 3 }]);
    h.downstream.script('Resolve:DEBIT', answer);
    await h.worker.runOnce();
    expect(h.store.row(ID1)).toMatchObject({ state: S.NEEDS_MANUAL_REVIEW, failureCode: code });
  });

  it('APPLIED but the Ledger rejects the leg as a bug -> NEEDS_MANUAL_REVIEW / LEDGER_REJECTED', async () => {
    const h = setup([{ state: S.DEBIT_SENT, attempts: 3 }]);
    h.downstream
      .script('Resolve:DEBIT', { resolved: 'APPLIED' })
      .script('PostJournal:debit-leg', fail(Status.FAILED_PRECONDITION, 'LEDGER_INVARIANT_VIOLATION'));
    await h.worker.runOnce();
    expect(h.store.row(ID1)).toMatchObject({ state: S.NEEDS_MANUAL_REVIEW, failureCode: FailureCode.LEDGER_REJECTED });
  });
});

describe('RecoveryWorker.runOnce — exhaustion, leases, batching', () => {
  it.each([S.DEBIT_SENT, S.REVERSING, S.INITIATED])(
    '%s at MAX_RECOVERY_ATTEMPTS -> NEEDS_MANUAL_REVIEW / RECOVERY_EXHAUSTED, with no downstream call',
    async (state) => {
      const h = setup([{ state, attempts: 20 }]);
      expect(await h.worker.runOnce()).toEqual(['exhausted']);
      expect(h.store.row(ID1)).toMatchObject({
        state: S.NEEDS_MANUAL_REVIEW,
        failureCode: FailureCode.RECOVERY_EXHAUSTED,
      });
      expect(reasons(h)).toEqual(['NEEDS_MANUAL_REVIEW:RECOVERY_EXHAUSTED']);
      expect(h.downstream.calls).toEqual([]);
      expect(h.observer.terminals).toEqual([
        { state: S.NEEDS_MANUAL_REVIEW, failureCode: FailureCode.RECOVERY_EXHAUSTED },
      ]);
    },
  );

  it('a transfer whose lease lapsed before its turn is skipped untouched', async () => {
    const h = setup([{ state: S.DEBITED }]);
    h.store.lapsed.add(ID1);
    expect(await h.worker.runOnce()).toEqual([]);
    expect(h.store.row(ID1).state).toBe(S.DEBITED);
    expect(h.downstream.calls).toEqual([]);
  });

  it('a transfer leased by someone else is never claimed or driven', async () => {
    const h = setup([{ state: S.DEBITED }]);
    const f = h.store.rows.get(ID1);
    if (f === undefined) throw new Error('missing');
    f.row = { ...f.row, leaseOwner: 'other-instance:lease' };
    expect(await h.worker.runOnce()).toEqual([]);
    expect(h.downstream.calls).toEqual([]);
  });

  it('claims at most RECOVERY_BATCH, and terminal transfers never', async () => {
    const h = setup(
      [...Array.from({ length: 7 }, () => ({ state: S.DEBITED })), { state: S.SUCCESS }, { state: S.FAILED }],
      { config: { batch: 5 } },
    );
    expect(await h.worker.runOnce()).toHaveLength(5);
    expect(await h.worker.runOnce()).toHaveLength(2);
    expect(await h.worker.runOnce()).toHaveLength(0);
  });

  it('drives at most RECOVERY_CONCURRENCY transfers at a time, and all of them', async () => {
    let active = 0;
    let peak = 0;
    const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5));
    const receipt = async (): Promise<{ bankTxnId: string; applied: boolean }> => {
      active++;
      peak = Math.max(peak, active);
      await tick();
      active--;
      return { bankTxnId: 'txn', applied: true };
    };
    const bank: BankPort = {
      debit: receipt,
      credit: receipt,
      reverseDebit: receipt,
      resolve: () => Promise.resolve('APPLIED'),
    };
    const h = setup(
      Array.from({ length: 12 }, () => ({ state: S.DEBIT_SENT })),
      { bank, config: { concurrency: 5 } },
    );
    expect(await h.worker.runOnce()).toHaveLength(12);
    expect(peak).toBe(5);
    for (const f of h.store.rows.values()) expect(f.row.state).toBe(S.SUCCESS);
  });

  it('an unexpected error on one transfer releases its lease; the rest of the batch still runs', async () => {
    const h = setup([{ state: S.DEBITED }, { state: S.DEBITED }]);
    const original = h.store.casTransition;
    h.store.casTransition = (req) =>
      req.transferId === ID1 ? Promise.reject(new Error('connection terminated')) : original(req);
    expect(await h.worker.runOnce()).toEqual(['advanced']);
    expect(h.store.released).toEqual([ID1]);
    expect(h.store.row(ID1).leaseOwner).toBeNull();
  });

  it('refreshes transfers_in_flight after every run, with every non-terminal state present', async () => {
    const h = setup([{ state: S.DEBIT_SENT, attempts: 3 }, { state: S.SUCCESS }]);
    h.downstream.script('Resolve:DEBIT', unavailable(), unavailable(), unavailable());
    await h.worker.runOnce();
    const counts = h.inFlight.at(-1);
    expect(counts?.get(S.DEBIT_SENT)).toBe(1);
    expect([...(counts?.keys() ?? [])].sort()).toEqual([...NON_TERMINAL_STATES].sort());
    expect(h.results).toEqual(['yielded']);
  });
});

describe('RecoveryWorker loop', () => {
  it('polls until stopped, then stops claiming', async () => {
    const h = setup([]);
    h.worker.start();
    await new Promise((r) => setTimeout(r, 60));
    await h.worker.stop(1000);
    const claims = h.store.claims;
    expect(claims).toBeGreaterThan(1);
    await new Promise((r) => setTimeout(r, 40));
    expect(h.store.claims).toBe(claims);
  });

  it('survives a failing iteration', async () => {
    const h = setup([]);
    let calls = 0;
    h.store.claimDue = () => (++calls === 1 ? Promise.reject(new Error('db down')) : Promise.resolve([]));
    h.worker.start();
    await new Promise((r) => setTimeout(r, 60));
    await h.worker.stop(1000);
    expect(calls).toBeGreaterThan(1);
  });
});
