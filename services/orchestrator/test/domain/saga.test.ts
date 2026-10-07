import { status as Status } from '@grpc/grpc-js';
import { describe, expect, it } from 'vitest';
import { FailureCode } from '../../src/domain/failureCodes';
import type { SagaPolicy } from '../../src/domain/policy';
import { SagaEngine, type SagaContext } from '../../src/domain/saga';
import { TransferState } from '../../src/domain/states';
import type { Transfer } from '../../src/domain/transfer';
import {
  deadline,
  fail,
  FakeClock,
  FakeDownstream,
  FakeStore,
  hang,
  LEASE_OWNER,
  makeTransfer,
  ok,
  RecordingObserver,
  silentLogger,
  testPolicy,
  unavailable,
  type TimelineEntry,
} from './fakes';

const S = TransferState;

interface Harness {
  clock: FakeClock;
  timeline: TimelineEntry[];
  store: FakeStore;
  downstream: FakeDownstream;
  observer: RecordingObserver;
  engine: SagaEngine;
  inline: () => SagaContext;
  recovery: SagaContext;
}

function setup(options: { transfer?: Partial<Transfer>; policy?: Partial<SagaPolicy> } = {}): Harness {
  const clock = new FakeClock();
  const timeline: TimelineEntry[] = [];
  const store = new FakeStore(makeTransfer(options.transfer), timeline);
  const downstream = new FakeDownstream(clock, () => store, timeline);
  const observer = new RecordingObserver();
  const policy = testPolicy(options.policy);
  const engine = new SagaEngine({
    store,
    bank: downstream.bank(),
    ledger: downstream.ledger(),
    policy,
    clock,
    logger: silentLogger,
    observer,
    random: () => 0.5,
    sleep: clock.sleep,
  });
  const inline = (): SagaContext => ({
    mode: 'inline',
    deadline: clock.now() + policy.inlineBudgetMs,
    leaseOwner: LEASE_OWNER,
    requestId: 'req-1',
  });
  const recovery: SagaContext = { mode: 'recovery', leaseOwner: LEASE_OWNER };
  return { clock, timeline, store, downstream, observer, engine, inline, recovery };
}

const trail = (store: FakeStore): string[] => store.events.map((e) => `${e.from}->${e.to}`);

describe('SagaEngine.advance — success path', () => {
  it('walks INITIATED to SUCCESS through every intermediate state, one event each', async () => {
    const { engine, store, inline, observer } = setup();
    const result = await engine.advance(store.row, inline());

    expect(result.state).toBe(S.SUCCESS);
    expect(trail(store)).toEqual([
      'INITIATED->DEBIT_SENT',
      'DEBIT_SENT->DEBITED',
      'DEBITED->CREDIT_SENT',
      'CREDIT_SENT->CREDITED',
      'CREDITED->SUCCESS',
    ]);
    expect(store.events.map((e) => e.reason)).toEqual([
      'DEBIT_INTENT',
      'DEBIT_CONFIRMED',
      'CREDIT_INTENT',
      'CREDIT_CONFIRMED',
      'TRANSFER_COMPLETED',
    ]);
    expect(result.failureCode).toBeNull();
    expect(observer.terminals).toEqual([{ state: S.SUCCESS, failureCode: null }]);
  });

  it('commits each *_SENT intent before the bank call, and posts the leg journal before confirming', async () => {
    const { engine, store, inline, timeline } = setup();
    await engine.advance(store.row, inline());

    expect(timeline).toEqual([
      { kind: 'cas', to: S.DEBIT_SENT },
      { kind: 'call', name: 'Debit', stateAtCall: S.DEBIT_SENT },
      { kind: 'call', name: 'PostJournal:debit-leg', stateAtCall: S.DEBIT_SENT },
      { kind: 'cas', to: S.DEBITED },
      { kind: 'cas', to: S.CREDIT_SENT },
      { kind: 'call', name: 'Credit', stateAtCall: S.CREDIT_SENT },
      { kind: 'call', name: 'PostJournal:credit-leg', stateAtCall: S.CREDIT_SENT },
      { kind: 'cas', to: S.CREDITED },
      { kind: 'cas', to: S.SUCCESS },
    ]);
  });

  it('records the bank transaction and journal ids in the confirming events', async () => {
    const { engine, store, inline, downstream } = setup();
    downstream.script('Debit', ok('d-1')).script('Credit', ok('c-1'));
    await engine.advance(store.row, inline());

    expect(store.events[1]?.detail).toMatchObject({
      bank_txn_id: 'd-1',
      journal_id: 'journal-debit-leg-txn',
      request_id: 'req-1',
    });
    expect(store.events[3]?.detail).toMatchObject({ bank_txn_id: 'c-1', journal_id: 'journal-credit-leg-txn' });
  });

  it('every CAS carries the lease owner, the lease length, and clears the lease only on a terminal state', async () => {
    const { engine, store, inline } = setup();
    await engine.advance(store.row, inline());

    for (const req of store.casRequests) {
      expect(req.leaseOwner).toBe(LEASE_OWNER);
      expect(req.leaseMs).toBe(15_000);
      expect(req.terminal).toBe(req.toState === S.SUCCESS);
    }
    expect(store.row.leaseOwner).toBeNull();
  });

  it('resumes from any intermediate state (what recovery will do in M6)', async () => {
    const { engine, store, recovery, downstream } = setup({ transfer: { state: S.CREDIT_SENT, version: 4 } });
    const result = await engine.advance(store.row, recovery);

    expect(result.state).toBe(S.SUCCESS);
    expect(downstream.callsTo('Debit')).toHaveLength(0);
    expect(trail(store)).toEqual(['CREDIT_SENT->CREDITED', 'CREDITED->SUCCESS']);
  });

  it('does nothing to a terminal transfer', async () => {
    const { engine, store, inline, downstream } = setup({ transfer: { state: S.FAILED } });
    const result = await engine.advance(store.row, inline());
    expect(result.state).toBe(S.FAILED);
    expect(store.events).toHaveLength(0);
    expect(downstream.calls).toHaveLength(0);
  });
});

describe('SagaEngine.advance — definite failures', () => {
  it.each([
    ['INSUFFICIENT_FUNDS', Status.FAILED_PRECONDITION, FailureCode.INSUFFICIENT_FUNDS],
    ['ACCOUNT_NOT_FOUND', Status.NOT_FOUND, FailureCode.PAYER_ACCOUNT_NOT_FOUND],
    ['ACCOUNT_BLOCKED', Status.FAILED_PRECONDITION, FailureCode.PAYER_ACCOUNT_BLOCKED],
    ['REFERENCE_VOIDED', Status.FAILED_PRECONDITION, FailureCode.DEBIT_NOT_CONFIRMED],
    ['CURRENCY_MISMATCH', Status.INVALID_ARGUMENT, FailureCode.CURRENCY_MISMATCH],
  ])('Debit %s -> fenced -> FAILED / %s, nothing posted, no retry', async (bankCode, status, failureCode) => {
    const { engine, store, inline, downstream } = setup();
    downstream.script('Debit', fail(status, bankCode)).script('Resolve:DEBIT', { resolved: 'VOIDED' });
    const result = await engine.advance(store.row, inline());

    expect(result.state).toBe(S.FAILED);
    expect(result.failureCode).toBe(failureCode);
    expect(result.failureMessage).toContain(bankCode);
    expect(trail(store)).toEqual(['INITIATED->DEBIT_SENT', 'DEBIT_SENT->FAILED']);
    expect(store.events[1]?.reason).toBe(failureCode);
    expect(downstream.callsTo('Debit')).toHaveLength(1);
    expect(downstream.calls.filter((c) => c.name.startsWith('PostJournal'))).toHaveLength(0);
    // ADR-024: fenced before failing. REFERENCE_VOIDED already is the tombstone.
    const fenced = bankCode !== 'REFERENCE_VOIDED';
    expect(downstream.callsTo('Resolve:DEBIT')).toHaveLength(fenced ? 1 : 0);
    if (fenced) expect(store.events[1]?.detail).toMatchObject({ fenced_by: 'Resolve', resolution: 'VOIDED' });
  });

  it.each([
    ['ACCOUNT_NOT_FOUND', Status.NOT_FOUND, FailureCode.PAYEE_ACCOUNT_NOT_FOUND],
    ['ACCOUNT_BLOCKED', Status.FAILED_PRECONDITION, FailureCode.PAYEE_ACCOUNT_BLOCKED],
    ['REFERENCE_VOIDED', Status.FAILED_PRECONDITION, FailureCode.CREDIT_NOT_CONFIRMED],
    ['CURRENCY_MISMATCH', Status.INVALID_ARGUMENT, FailureCode.CURRENCY_MISMATCH],
  ])('Credit %s -> fenced -> REVERSING / %s -> refund -> REVERSED', async (bankCode, status, failureCode) => {
    const { engine, store, inline, downstream, observer } = setup();
    downstream.script('Credit', fail(status, bankCode)).script('Resolve:CREDIT', { resolved: 'VOIDED' });
    const result = await engine.advance(store.row, inline());

    expect(result.state).toBe(S.REVERSED);
    expect(result.failureCode).toBe(failureCode);
    expect(trail(store)).toEqual([
      'INITIATED->DEBIT_SENT',
      'DEBIT_SENT->DEBITED',
      'DEBITED->CREDIT_SENT',
      'CREDIT_SENT->REVERSING',
      'REVERSING->REVERSED',
    ]);
    expect(downstream.calls.map((c) => c.name)).toEqual([
      'Debit',
      'PostJournal:debit-leg',
      'Credit',
      ...(bankCode === 'REFERENCE_VOIDED' ? [] : ['Resolve:CREDIT']),
      'ReverseDebit',
      'PostJournal:reversal',
    ]);
    expect(observer.terminals).toEqual([{ state: S.REVERSED, failureCode }]);
  });
});

describe('SagaEngine.advance — bugs go to NEEDS_MANUAL_REVIEW, never retried', () => {
  it.each([
    ['INVALID_ARGUMENT from the Ledger', Status.INVALID_ARGUMENT, 'JOURNAL_INVALID'],
    ['FAILED_PRECONDITION from the Ledger (ADR-017)', Status.FAILED_PRECONDITION, 'LEDGER_INVARIANT_VIOLATION'],
    ['NOT_FOUND from the Ledger', Status.NOT_FOUND, 'ACCOUNT_NOT_FOUND'],
    ['ALREADY_EXISTS from the Ledger', Status.ALREADY_EXISTS, 'IDEMPOTENCY_KEY_REUSED'],
  ])('%s on the debit leg -> LEDGER_REJECTED', async (_name, status, code) => {
    const { engine, store, inline, downstream, observer } = setup();
    downstream.script('PostJournal:debit-leg', fail(status, code));
    const result = await engine.advance(store.row, inline());

    expect(result.state).toBe(S.NEEDS_MANUAL_REVIEW);
    expect(result.failureCode).toBe(FailureCode.LEDGER_REJECTED);
    expect(downstream.callsTo('PostJournal:debit-leg')).toHaveLength(1);
    expect(observer.terminals).toEqual([{ state: S.NEEDS_MANUAL_REVIEW, failureCode: FailureCode.LEDGER_REJECTED }]);
  });

  it('a Ledger bug on the credit leg -> LEDGER_REJECTED, not REVERSING', async () => {
    const { engine, store, inline, downstream } = setup();
    downstream.script('PostJournal:credit-leg', fail(Status.INVALID_ARGUMENT, 'JOURNAL_INVALID'));
    const result = await engine.advance(store.row, inline());
    expect(result.state).toBe(S.NEEDS_MANUAL_REVIEW);
    expect(trail(store).at(-1)).toBe('CREDIT_SENT->NEEDS_MANUAL_REVIEW');
  });

  it.each([
    ['NOTHING_TO_REVERSE', Status.FAILED_PRECONDITION],
    ['ACCOUNT_NOT_FOUND', Status.NOT_FOUND],
    ['INVALID_REQUEST', Status.INVALID_ARGUMENT],
  ])('ReverseDebit %s -> BANK_INVARIANT_VIOLATION (a refused refund is a broken invariant)', async (code, status) => {
    const { engine, store, inline, downstream } = setup();
    downstream
      .script('Credit', fail(Status.NOT_FOUND, 'ACCOUNT_NOT_FOUND'))
      .script('Resolve:CREDIT', { resolved: 'VOIDED' })
      .script('ReverseDebit', fail(status, code));
    const result = await engine.advance(store.row, inline());

    expect(result.state).toBe(S.NEEDS_MANUAL_REVIEW);
    expect(result.failureCode).toBe(FailureCode.BANK_INVARIANT_VIOLATION);
    expect(trail(store).slice(-2)).toEqual(['CREDIT_SENT->REVERSING', 'REVERSING->NEEDS_MANUAL_REVIEW']);
    expect(downstream.callsTo('ReverseDebit')).toHaveLength(1);
  });

  it.each([
    ['Debit, INVALID_REQUEST', 'Debit', Status.INVALID_ARGUMENT, 'INVALID_REQUEST'],
    ['Debit, REFERENCE_CONFLICT', 'Debit', Status.INVALID_ARGUMENT, 'REFERENCE_CONFLICT'],
    ['Debit, PERMISSION_DENIED', 'Debit', Status.PERMISSION_DENIED, 'X'],
    [
      'Credit, INSUFFICIENT_FUNDS (impossible for a credit)',
      'Credit',
      Status.FAILED_PRECONDITION,
      'INSUFFICIENT_FUNDS',
    ],
    ['Debit, FAILED_PRECONDITION with an unknown code (ADR-018)', 'Debit', Status.FAILED_PRECONDITION, 'SOMETHING_NEW'],
  ] as const)('bank bug: %s -> BANK_INVARIANT_VIOLATION', async (_name, op, status, code) => {
    const { engine, store, inline, downstream } = setup();
    downstream.script(op, fail(status, code));
    const result = await engine.advance(store.row, inline());
    expect(result.state).toBe(S.NEEDS_MANUAL_REVIEW);
    expect(result.failureCode).toBe(FailureCode.BANK_INVARIANT_VIOLATION);
    expect(downstream.callsTo(op)).toHaveLength(1);
  });

  it('a bank OK without APPLIED is a contract violation, not a success', async () => {
    const { engine, store, inline, downstream } = setup();
    downstream.script('Debit', { ok: true, applied: false });
    const result = await engine.advance(store.row, inline());
    expect(result.state).toBe(S.NEEDS_MANUAL_REVIEW);
    expect(result.failureCode).toBe(FailureCode.BANK_INVARIANT_VIOLATION);
    expect(downstream.calls.filter((c) => c.name.startsWith('PostJournal'))).toHaveLength(0);
  });
});

describe('SagaEngine.advance — unknown outcomes never change the state', () => {
  it('retries an UNAVAILABLE debit inline with the same request and succeeds', async () => {
    const { engine, store, inline, downstream, observer } = setup();
    downstream.script('Debit', unavailable(), unavailable(), ok());
    const result = await engine.advance(store.row, inline());

    expect(result.state).toBe(S.SUCCESS);
    expect(downstream.callsTo('Debit')).toHaveLength(3);
    expect(observer.downstream.filter((d) => d.operation === 'Debit').map((d) => d.outcome)).toEqual([
      'unknown',
      'unknown',
      'ok',
    ]);
  });

  it('after INLINE_BANK_RETRIES the transfer yields in DEBIT_SENT: no FAILED, attempts + 1, lease released', async () => {
    const { engine, store, inline, downstream, observer } = setup();
    downstream.script('Debit', unavailable(), unavailable(), unavailable());
    const result = await engine.advance(store.row, inline());

    expect(result.state).toBe(S.DEBIT_SENT);
    expect(result.failureCode).toBeNull();
    expect(result.attempts).toBe(1);
    expect(result.leaseOwner).toBeNull();
    expect(store.yields).toBe(1);
    expect(store.lastBackoffMs).toBe(2000); // policy backoff for the new attempts count (1)
    expect(downstream.callsTo('Debit')).toHaveLength(3);
    expect(trail(store)).toEqual(['INITIATED->DEBIT_SENT']);
    expect(observer.terminals).toHaveLength(0);
  });

  it('a Ledger outage after a successful debit yields in DEBIT_SENT (the debit is rediscovered later)', async () => {
    const { engine, store, inline, downstream } = setup();
    downstream.script('PostJournal:debit-leg', unavailable(), unavailable(), unavailable());
    const result = await engine.advance(store.row, inline());

    expect(result.state).toBe(S.DEBIT_SENT);
    expect(downstream.callsTo('Debit')).toHaveLength(1);
    expect(downstream.callsTo('PostJournal:debit-leg')).toHaveLength(3);
  });

  it('a Ledger INTERNAL is UNKNOWN_OUTCOME: retried, then yields', async () => {
    const { engine, store, inline, downstream } = setup();
    downstream.script('PostJournal:debit-leg', fail(Status.INTERNAL, 'INTERNAL'), ok());
    const result = await engine.advance(store.row, inline());
    expect(result.state).toBe(S.SUCCESS);
    expect(downstream.callsTo('PostJournal:debit-leg')).toHaveLength(2);
  });

  it('an unknown credit outcome yields in CREDIT_SENT, never REVERSING', async () => {
    const { engine, store, inline, downstream } = setup();
    downstream.script('Credit', deadline(), deadline(), deadline());
    const result = await engine.advance(store.row, inline());
    expect(result.state).toBe(S.CREDIT_SENT);
    expect(downstream.callsTo('ReverseDebit')).toHaveLength(0);
  });

  it('a transient ReverseDebit failure yields in REVERSING (never abandoned)', async () => {
    const { engine, store, inline, downstream } = setup();
    downstream
      .script('Credit', fail(Status.NOT_FOUND, 'ACCOUNT_NOT_FOUND'))
      .script('Resolve:CREDIT', { resolved: 'VOIDED' })
      .script('ReverseDebit', unavailable(), unavailable(), unavailable());
    const result = await engine.advance(store.row, inline());
    expect(result.state).toBe(S.REVERSING);
    expect(result.failureCode).toBe(FailureCode.PAYEE_ACCOUNT_NOT_FOUND);
    expect(store.yields).toBe(1);
  });

  it('a non-gRPC error (socket reset) is an unknown outcome too', async () => {
    const { engine, store, inline, downstream } = setup();
    downstream.script('Debit', { error: new Error('ECONNRESET') }, ok());
    const result = await engine.advance(store.row, inline());
    expect(result.state).toBe(S.SUCCESS);
  });

  it('honours the configured retry count (INLINE_BANK_RETRIES = 0 means one attempt)', async () => {
    const { engine, store, inline, downstream } = setup({ policy: { bankAttempts: 1 } });
    downstream.script('Debit', unavailable());
    const result = await engine.advance(store.row, inline());
    expect(result.state).toBe(S.DEBIT_SENT);
    expect(downstream.callsTo('Debit')).toHaveLength(1);
  });
});

/**
 * ADR-024. A rejection leaves no operation row at the bank, so an earlier attempt that
 * timed out can still apply after a later attempt was refused. The nightly CI run of
 * 2026-10-07 hit exactly this: Debit timed out (late_apply), the retry got
 * INSUFFICIENT_FUNDS, the transfer FAILED, and the first Debit then applied.
 */
describe('SagaEngine.advance — a definite failure is final only once fenced (ADR-024)', () => {
  const insufficient = (): ReturnType<typeof fail> => fail(Status.FAILED_PRECONDITION, 'INSUFFICIENT_FUNDS');

  it('timeout, then INSUFFICIENT_FUNDS, Resolve VOIDED: FAILED with the original code, fenced first', async () => {
    const { engine, store, inline, downstream, timeline } = setup();
    downstream.script('Debit', deadline(), insufficient()).script('Resolve:DEBIT', { resolved: 'VOIDED' });
    const result = await engine.advance(store.row, inline());

    expect(result.state).toBe(S.FAILED);
    expect(result.failureCode).toBe(FailureCode.INSUFFICIENT_FUNDS);
    expect(downstream.callsTo('Debit')).toHaveLength(2);
    // The fence is called in DEBIT_SENT, before the FAILED CAS.
    expect(timeline.slice(-2)).toEqual([
      { kind: 'call', name: 'Resolve:DEBIT', stateAtCall: S.DEBIT_SENT },
      { kind: 'cas', to: S.FAILED },
    ]);
  });

  it('timeout, then INSUFFICIENT_FUNDS, Resolve APPLIED: the late debit landed, so the transfer goes on', async () => {
    const { engine, store, inline, downstream } = setup();
    downstream.script('Debit', deadline(), insufficient()).script('Resolve:DEBIT', { resolved: 'APPLIED' });
    const result = await engine.advance(store.row, inline());

    expect(result.state).toBe(S.SUCCESS);
    expect(result.failureCode).toBeNull();
    expect(trail(store)).toEqual([
      'INITIATED->DEBIT_SENT',
      'DEBIT_SENT->DEBITED',
      'DEBITED->CREDIT_SENT',
      'CREDIT_SENT->CREDITED',
      'CREDITED->SUCCESS',
    ]);
    expect(store.events[1]?.reason).toBe('DEBIT_CONFIRMED_BY_RESOLVE');
    expect(downstream.callsTo('PostJournal:debit-leg')).toHaveLength(1);
  });

  it('a credit refusal with Resolve APPLIED is CREDITED, never refunded', async () => {
    const { engine, store, inline, downstream } = setup();
    downstream
      .script('Credit', deadline(), fail(Status.FAILED_PRECONDITION, 'ACCOUNT_BLOCKED'))
      .script('Resolve:CREDIT', { resolved: 'APPLIED' });
    const result = await engine.advance(store.row, inline());

    expect(result.state).toBe(S.SUCCESS);
    expect(trail(store)).toContain('CREDIT_SENT->CREDITED');
    expect(store.events.find((e) => e.to === S.CREDITED)?.reason).toBe('CREDIT_CONFIRMED_BY_RESOLVE');
    expect(downstream.callsTo('ReverseDebit')).toHaveLength(0);
  });

  it('no answer from Resolve: stays in DEBIT_SENT and yields, never fails an unfenced reference', async () => {
    const { engine, store, inline, downstream, observer } = setup();
    downstream.script('Debit', insufficient()).script('Resolve:DEBIT', unavailable(), unavailable(), unavailable());
    const result = await engine.advance(store.row, inline());

    expect(result.state).toBe(S.DEBIT_SENT);
    expect(result.failureCode).toBeNull();
    expect(store.yields).toBe(1);
    expect(trail(store)).toEqual(['INITIATED->DEBIT_SENT']);
    expect(observer.terminals).toHaveLength(0);
  });

  it('a credit refusal with no answer from Resolve stays in CREDIT_SENT: no refund yet', async () => {
    const { engine, store, inline, downstream } = setup();
    downstream
      .script('Credit', fail(Status.NOT_FOUND, 'ACCOUNT_NOT_FOUND'))
      .script('Resolve:CREDIT', deadline(), deadline(), deadline());
    const result = await engine.advance(store.row, inline());

    expect(result.state).toBe(S.CREDIT_SENT);
    expect(downstream.callsTo('ReverseDebit')).toHaveLength(0);
    expect(store.yields).toBe(1);
  });

  it('a bug from Resolve, or an answer that is neither APPLIED nor VOIDED, goes to manual review', async () => {
    const bug = setup();
    bug.downstream
      .script('Debit', insufficient())
      .script('Resolve:DEBIT', fail(Status.INVALID_ARGUMENT, 'INVALID_REQUEST'));
    expect((await bug.engine.advance(bug.store.row, bug.inline())).state).toBe(S.NEEDS_MANUAL_REVIEW);

    const invalid = setup();
    invalid.downstream.script('Debit', insufficient()).script('Resolve:DEBIT', { resolved: 'INVALID' });
    const result = await invalid.engine.advance(invalid.store.row, invalid.inline());
    expect(result.state).toBe(S.NEEDS_MANUAL_REVIEW);
    expect(result.failureCode).toBe(FailureCode.BANK_INVARIANT_VIOLATION);
  });

  it('recovery fences the same way as an inline drive', async () => {
    const { engine, store, recovery, downstream } = setup({ transfer: { state: S.DEBIT_SENT, version: 2 } });
    downstream.script('Debit', insufficient()).script('Resolve:DEBIT', { resolved: 'VOIDED' });
    const result = await engine.advance(store.row, recovery);
    expect(result.state).toBe(S.FAILED);
    expect(downstream.callsTo('Resolve:DEBIT')).toHaveLength(1);
  });
});

describe('SagaEngine.advance — the inline budget is a hard bound (ADR-010)', () => {
  it('without the bound, hanging calls would take 12 s; with it, advance returns within the 8 s budget', async () => {
    const { engine, store, inline, clock, downstream } = setup();
    // Two lost Debit answers, then the Ledger hangs: 2+2 s of bank, then 2+2+2 s of ledger.
    downstream.script('Debit', hang(), hang(), ok()).script('PostJournal:debit-leg', hang(), hang(), hang());
    const started = clock.now();
    const result = await engine.advance(store.row, inline());

    expect(result.state).toBe(S.DEBIT_SENT);
    expect(clock.now() - started).toBeLessThanOrEqual(8000);
    expect(downstream.callsTo('Debit')).toHaveLength(3);
    // The second ledger attempt is clipped to what is left; the third is never started.
    expect(downstream.callsTo('PostJournal:debit-leg').map((c) => c.timeoutMs)).toEqual([2000, 1800]);
    expect(store.yields).toBe(1);
  });

  it("clips each call's deadline to the budget left", async () => {
    const { engine, store, inline, downstream } = setup({ policy: { inlineBudgetMs: 4500 } });
    downstream.script('Debit', hang(), hang(), hang());
    await engine.advance(store.row, inline());

    // 2000 used, ~100 ms backoff (random 0.5 * 100 = 50), 2000 used, then what is left.
    const timeouts = downstream.callsTo('Debit').map((c) => c.timeoutMs);
    expect(timeouts[0]).toBe(2000);
    expect(timeouts[1]).toBe(2000);
    expect(timeouts[2]).toBeLessThan(2000);
    expect(timeouts[2]).toBeGreaterThanOrEqual(100);
  });

  it('does not start an attempt with less than MIN_ATTEMPT_MS left, and yields instead', async () => {
    const { engine, store, inline, downstream } = setup({ policy: { inlineBudgetMs: 2050 } });
    downstream.script('Debit', hang());
    const result = await engine.advance(store.row, inline());

    // First attempt consumed 2000 ms; 50 ms backoff leaves 0 ms: no second attempt.
    expect(downstream.callsTo('Debit')).toHaveLength(1);
    expect(result.state).toBe(S.DEBIT_SENT);
    expect(store.yields).toBe(1);
  });

  it('yields at the top of the loop once the deadline has passed, without calling anyone', async () => {
    const { engine, store, clock, downstream } = setup();
    const ctx: SagaContext = { mode: 'inline', deadline: clock.now() - 1, leaseOwner: LEASE_OWNER };
    const result = await engine.advance(store.row, ctx);
    expect(result.state).toBe(S.INITIATED);
    expect(downstream.calls).toHaveLength(0);
    expect(store.yields).toBe(1);
  });

  it('recovery mode has no budget: full per-call timeouts on every attempt', async () => {
    const { engine, store, recovery, downstream } = setup({ transfer: { state: S.DEBIT_SENT } });
    downstream.script('Debit', hang(), hang(), hang());
    await engine.advance(store.row, recovery);
    expect(downstream.callsTo('Debit').map((c) => c.timeoutMs)).toEqual([2000, 2000, 2000]);
  });

  it('passes the request id to every downstream call', async () => {
    const { engine, store, inline, downstream } = setup();
    await engine.advance(store.row, inline());
    expect(new Set(downstream.calls.map((c) => c.requestId))).toEqual(new Set(['req-1']));
  });
});

describe('SagaEngine.advance — lease and version loss', () => {
  it('stops driving on StaleTransferError and returns the row as it now stands', async () => {
    const { engine, store, inline, downstream } = setup();
    // The debit succeeds, but someone else moved the transfer before DEBITED is written.
    store.stealOnNextCas = false;
    downstream.script('Debit', ok());
    const original = store.casTransition.bind(store);
    let n = 0;
    store.casTransition = (req) => {
      n++;
      if (n === 2) store.stealOnNextCas = true;
      return original(req);
    };
    const result = await engine.advance(store.row, inline());

    expect(result.state).toBe(S.DEBIT_SENT);
    expect(result.leaseOwner).toBe('someone-else');
    expect(trail(store)).toEqual(['INITIATED->DEBIT_SENT']);
    // No further calls after losing the transfer.
    expect(downstream.callsTo('Credit')).toHaveLength(0);
    expect(store.yields).toBe(0);
  });

  it('never drives a transfer whose lease it does not hold', async () => {
    const { engine, store, inline, downstream } = setup({ transfer: { leaseOwner: 'other-instance:lease' } });
    const result = await engine.advance(store.row, inline());
    expect(result.state).toBe(S.INITIATED);
    expect(downstream.calls).toHaveLength(0);
    expect(store.events).toHaveLength(0);
  });

  it('propagates unexpected store errors (the caller releases the lease)', async () => {
    const { engine, store, inline } = setup();
    store.casTransition = () => Promise.reject(new Error('connection terminated'));
    await expect(engine.advance(store.row, inline())).rejects.toThrow('connection terminated');
  });
});
