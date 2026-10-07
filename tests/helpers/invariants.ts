/**
 * The invariants from ARCHITECTURE.md section 16: the proof the project works.
 *
 * Two ways to evaluate them:
 * - **Against a baseline** (the chaos tests). `snapshotBaseline()` records the test
 *   accounts' balances and the ledger before the run; I2–I4 compare against it. No other
 *   traffic may hit the stack during the run, so callers quiesce first.
 * - **Scoped to a set of transfers** (`scripts/checkInvariants.ts`). With no baseline,
 *   I2–I4 are evaluated from the per-transfer evidence alone: the bank operations and
 *   journals that carry those transfer ids must add up.
 *
 * I5 always uses `Bank.GetOperation` and `Ledger.ListJournals`, as section 16 prescribes.
 *
 * I8 (phase 2, ADR-025) covers the transactional outbox: every transfer that reached its
 * terminal state after `0002_outbox.sql` was applied has exactly one outbox event of the
 * matching type, naming the same transfer, state and amount; once the stack is quiet,
 * none is unpublished.
 *
 * I9 (phase 2, ADR-026) follows the event one hop further: every published outbox event
 * has exactly one outcome in the notification service's dedupe table, `DELIVERED`, or
 * `DEAD_LETTERED` for a payee the simulated merchant always fails (`whfail-`).
 *
 * I10 (phase 2, ADR-027) looks from outside: after a reconciliation run covering the
 * transfers, no OPEN break (bank statement against ledger journals) names one of them.
 */
import type { Pool, QueryResult, QueryResultRow } from 'pg';
import type { BankAdmin, BankId } from './bankAdmin';
import type { JournalView, LedgerReader } from './ledgerClient';

export type InvariantId = 'I1' | 'I2' | 'I3' | 'I4' | 'I5' | 'I6' | 'I7' | 'I8' | 'I9' | 'I10';

export interface InvariantResult {
  id: InvariantId;
  ok: boolean;
  summary: string;
  /** At most `MAX_PROBLEMS` examples; `problemCount` is the full count. */
  problems: string[];
  problemCount: number;
}

export interface TestAccount {
  bank: BankId;
  accountId: string;
}

export interface InvariantDeps {
  banks: BankAdmin;
  ledger: LedgerReader;
  orchDb: Pool;
  ledgerDb: Pool;
  /** Parallel gRPC calls while collecting evidence. */
  concurrency?: number;
}

export interface Baseline {
  takenAt: Date;
  accounts: TestAccount[];
  balances: Map<string, bigint>;
  ledger: Map<string, bigint>;
}

export interface RunTransfer {
  id: string;
  idempotencyKey: string;
  state: string;
  failureCode: string | null;
  payerBank: BankId;
  payeeBank: BankId;
  amount: bigint;
}

type OpStatus = 'APPLIED' | 'VOIDED' | 'NOT_FOUND';

export interface Evidence {
  transfer: RunTransfer;
  debit: { status: OpStatus; amount: bigint };
  credit: { status: OpStatus; amount: bigint };
  reverse: { status: OpStatus; amount: bigint };
  journals: JournalView[];
}

const MAX_PROBLEMS = 20;

/** Errors where the connection itself failed and no query result exists. */
const CONNECTION_ERRORS = new Set(['ECONNRESET', 'ECONNREFUSED', 'EPIPE']);

function isConnectionError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const code = (err as { code?: unknown }).code;
  const message = err instanceof Error ? err.message : '';
  return (typeof code === 'string' && CONNECTION_ERRORS.has(code)) || message.includes('Connection terminated');
}

/**
 * A read-only verification query. On Docker Desktop for Windows the host port forwarder
 * occasionally resets a fresh connection at the end of a long chaos run, before it reaches
 * Postgres (the database logs nothing; ADR-021, 2026-10-07 amendment). Only such
 * connection-level failures are retried, at most twice, and each retry is logged. A SQL
 * error or any wrong result fails at once. The data checked is the same, so no
 * invariant is loosened.
 */
export async function readQuery<R extends QueryResultRow>(
  pool: Pool,
  text: string,
  values: unknown[] = [],
): Promise<QueryResult<R>> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await pool.query<R>(text, values);
    } catch (err) {
      if (!isConnectionError(err) || attempt >= 3) throw err;
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`verification read: connection reset (${message}); retry ${attempt} of 2\n`);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}
const TERMINAL = new Set(['SUCCESS', 'FAILED', 'REVERSED', 'NEEDS_MANUAL_REVIEW']);
const BANKS: readonly BankId[] = ['bank_a', 'bank_b'];

const accountKey = (a: TestAccount): string => `${a.bank}/${a.accountId}`;

function result(id: InvariantId, summary: string, problems: string[]): InvariantResult {
  return {
    id,
    ok: problems.length === 0,
    summary,
    problems: problems.slice(0, MAX_PROBLEMS),
    problemCount: problems.length,
  };
}

/** Runs `fn` over `items` with at most `limit` in flight; results keep input order. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      const item = items[i];
      if (item !== undefined) out[i] = await fn(item);
    }
  });
  await Promise.all(lanes);
  return out;
}

// ---------------------------------------------------------------- data

/** Balances of the test accounts and every ledger account, before the run. */
export async function snapshotBaseline(deps: InvariantDeps, accounts: TestAccount[]): Promise<Baseline> {
  const balances = new Map<string, bigint>();
  await mapLimit(accounts, deps.concurrency ?? 32, async (a) => {
    balances.set(accountKey(a), await deps.banks.balance(a.bank, a.accountId));
  });
  const trial = await deps.ledger.getTrialBalance();
  return { takenAt: new Date(), accounts, balances, ledger: trial.balances };
}

/** Transfers of one run, found by idempotency-key prefix and/or creation time. */
export async function loadTransfers(
  orchDb: Pool,
  filter: { keyPrefix?: string; since?: Date },
): Promise<RunTransfer[]> {
  const res = await readQuery<{
    id: string;
    idempotency_key: string;
    state: string;
    failure_code: string | null;
    payer_bank_id: BankId;
    payee_bank_id: BankId;
    amount: string;
  }>(
    orchDb,
    `SELECT id, idempotency_key, state, failure_code, payer_bank_id, payee_bank_id, amount
       FROM transfers
      WHERE ($1::text IS NULL OR idempotency_key LIKE $1 || '%')
        AND ($2::timestamptz IS NULL OR created_at >= $2)
      ORDER BY created_at`,
    [filter.keyPrefix ?? null, filter.since ?? null],
  );
  return res.rows.map((r) => ({
    id: r.id,
    idempotencyKey: r.idempotency_key,
    state: r.state,
    failureCode: r.failure_code,
    payerBank: r.payer_bank_id,
    payeeBank: r.payee_bank_id,
    amount: BigInt(r.amount),
  }));
}

/** Every bank operation and journal carrying each transfer's id, via gRPC. */
export async function collectEvidence(deps: InvariantDeps, transfers: RunTransfer[]): Promise<Evidence[]> {
  return mapLimit(transfers, deps.concurrency ?? 32, async (t) => {
    const [debit, credit, reverse, journals] = await Promise.all([
      deps.banks.getOperation(t.payerBank, t.id, 'DEBIT'),
      deps.banks.getOperation(t.payeeBank, t.id, 'CREDIT'),
      deps.banks.getOperation(t.payerBank, t.id, 'REVERSE_DEBIT'),
      deps.ledger.listJournals(t.id),
    ]);
    return { transfer: t, debit, credit, reverse, journals };
  });
}

// ---------------------------------------------------------------- I1 - I7

/** I1: every journal balances and the ledger as a whole is zero-sum. */
export async function checkI1(deps: InvariantDeps): Promise<InvariantResult> {
  const trial = await deps.ledger.getTrialBalance();
  const unbalanced = await readQuery<{ journal_id: string; d: string; c: string }>(
    deps.ledgerDb,
    `SELECT journal_id, sum(amount) FILTER (WHERE direction = 'D')::text AS d,
            sum(amount) FILTER (WHERE direction = 'C')::text AS c
       FROM entries GROUP BY journal_id
     HAVING coalesce(sum(amount) FILTER (WHERE direction = 'D'), 0)
         <> coalesce(sum(amount) FILTER (WHERE direction = 'C'), 0)`,
  );
  const problems = unbalanced.rows.map((r) => `journal ${r.journal_id}: debits ${r.d} credits ${r.c}`);
  if (!trial.balanced) problems.unshift('GetTrialBalance.balanced is false');
  return result(
    'I1',
    `trial balance balanced=${trial.balanced}, unbalanced journals=${unbalanced.rowCount ?? 0}`,
    problems,
  );
}

async function currentBalances(deps: InvariantDeps, accounts: TestAccount[]): Promise<Map<string, bigint>> {
  const now = new Map<string, bigint>();
  await mapLimit(accounts, deps.concurrency ?? 32, async (a) => {
    now.set(accountKey(a), await deps.banks.balance(a.bank, a.accountId));
  });
  return now;
}

const sumOf = (values: Iterable<bigint>): bigint => {
  let total = 0n;
  for (const v of values) total += v;
  return total;
};

/** I2: the test accounts' balances sum to the baseline sum, and none is negative. */
export async function checkI2(deps: InvariantDeps, baseline: Baseline): Promise<InvariantResult> {
  const now = await currentBalances(deps, baseline.accounts);
  const before = sumOf(baseline.balances.values());
  const after = sumOf(now.values());
  const problems: string[] = [];
  if (before !== after) problems.push(`sum of test balances changed: ${before} -> ${after} (${after - before})`);
  for (const [key, balance] of now) if (balance < 0n) problems.push(`${key} is negative: ${balance}`);
  return result('I2', `sum of ${baseline.accounts.length} test balances ${before} -> ${after}`, problems);
}

/** I3: `transit` is back at its baseline once every transfer is terminal. */
export async function checkI3(deps: InvariantDeps, baseline: Baseline): Promise<InvariantResult> {
  const before = baseline.ledger.get('transit') ?? 0n;
  const after = await deps.ledger.getBalance('transit');
  return result('I3', `transit ${before} -> ${after}`, before === after ? [] : [`transit moved by ${after - before}`]);
}

/** I4: for each bank, customer balance change plus (receivable change minus payable change) is zero. */
export async function checkI4(deps: InvariantDeps, baseline: Baseline): Promise<InvariantResult> {
  const now = await currentBalances(deps, baseline.accounts);
  const trial = await deps.ledger.getTrialBalance();
  const problems: string[] = [];
  const parts: string[] = [];
  for (const bank of BANKS) {
    let customers = 0n;
    for (const a of baseline.accounts.filter((x) => x.bank === bank)) {
      customers += (now.get(accountKey(a)) ?? 0n) - (baseline.balances.get(accountKey(a)) ?? 0n);
    }
    const delta = (code: string): bigint => (trial.balances.get(code) ?? 0n) - (baseline.ledger.get(code) ?? 0n);
    const receivable = delta(`receivable:${bank}`);
    const payable = delta(`payable:${bank}`);
    const total = customers + (receivable - payable);
    parts.push(`${bank}: customers ${customers}, receivable ${receivable}, payable ${payable}`);
    if (total !== 0n)
      problems.push(`${bank}: customers ${customers} + (receivable ${receivable} - payable ${payable}) = ${total}`);
  }
  return result('I4', parts.join('; '), problems);
}

const kinds = (journals: JournalView[]): string =>
  journals
    .map((j) => j.kind)
    .sort()
    .join(',');

/** I5: exactly-once effects per transfer, by final state (section 16 table). */
export function checkI5(evidence: Evidence[]): InvariantResult {
  const problems: string[] = [];
  const expectAmount = (e: Evidence, label: string, op: { status: OpStatus; amount: bigint }): void => {
    if (op.status === 'APPLIED' && op.amount !== e.transfer.amount) {
      problems.push(`${e.transfer.id}: ${label} applied ${op.amount}, transfer is ${e.transfer.amount}`);
    }
  };
  for (const e of evidence) {
    const t = e.transfer;
    const bad = (why: string): void => {
      problems.push(`${t.id} (${t.state}): ${why}`);
    };
    for (const j of e.journals) {
      for (const line of j.lines)
        if (line.amount !== t.amount) bad(`journal ${j.kind} line ${line.accountCode} is ${line.amount}`);
    }
    switch (t.state) {
      case 'SUCCESS':
        if (e.debit.status !== 'APPLIED') bad(`payer DEBIT is ${e.debit.status}, expected APPLIED`);
        if (e.credit.status !== 'APPLIED') bad(`payee CREDIT is ${e.credit.status}, expected APPLIED`);
        if (e.reverse.status !== 'NOT_FOUND') bad(`REVERSE_DEBIT is ${e.reverse.status}, expected none`);
        if (kinds(e.journals) !== 'TRANSFER_CREDIT_LEG,TRANSFER_DEBIT_LEG') bad(`journals [${kinds(e.journals)}]`);
        break;
      case 'REVERSED':
        if (e.debit.status !== 'APPLIED') bad(`payer DEBIT is ${e.debit.status}, expected APPLIED`);
        if (e.credit.status === 'APPLIED') bad('payee CREDIT is APPLIED, expected none applied');
        if (e.reverse.status !== 'APPLIED') bad(`REVERSE_DEBIT is ${e.reverse.status}, expected APPLIED`);
        if (kinds(e.journals) !== 'TRANSFER_DEBIT_LEG,TRANSFER_REVERSAL') bad(`journals [${kinds(e.journals)}]`);
        break;
      case 'FAILED':
        if (e.debit.status === 'APPLIED') bad('payer DEBIT is APPLIED, expected none applied');
        if (e.credit.status !== 'NOT_FOUND') bad(`payee CREDIT is ${e.credit.status}, expected none`);
        if (e.reverse.status !== 'NOT_FOUND') bad(`REVERSE_DEBIT is ${e.reverse.status}, expected none`);
        if (e.journals.length !== 0) bad(`journals [${kinds(e.journals)}], expected none`);
        break;
      default:
        bad('not in SUCCESS, REVERSED or FAILED (see I6)');
    }
    expectAmount(e, 'DEBIT', e.debit);
    expectAmount(e, 'CREDIT', e.credit);
    expectAmount(e, 'REVERSE_DEBIT', e.reverse);
  }
  return result('I5', `${evidence.length} transfers checked against their bank operations and journals`, problems);
}

/** I6: nothing non-terminal, and zero in NEEDS_MANUAL_REVIEW. */
export function checkI6(transfers: RunTransfer[]): InvariantResult {
  const problems = transfers
    .filter((t) => !TERMINAL.has(t.state) || t.state === 'NEEDS_MANUAL_REVIEW')
    .map((t) => `${t.id}: ${t.state}${t.failureCode === null ? '' : ` / ${t.failureCode}`}`);
  return result('I6', `${transfers.length} transfers, ${problems.length} unfinished or under review`, problems);
}

/** Each transfer's outbox facts, read from `orchestrator_db` (I8). */
export interface OutboxFacts {
  transferId: string;
  state: string;
  amount: bigint;
  /** When the transfer entered its terminal state; null if it is not terminal. */
  terminalAt: Date | null;
  events: { eventType: string; payload: Record<string, unknown>; publishedAt: Date | null }[];
}

const EVENT_TYPE: Record<string, string> = {
  SUCCESS: 'transfer.succeeded',
  FAILED: 'transfer.failed',
  REVERSED: 'transfer.reversed',
  NEEDS_MANUAL_REVIEW: 'transfer.needs_manual_review',
};

/** When `0002_outbox.sql` was applied: transfers that finished earlier never had an event. */
export async function outboxCutoff(orchDb: Pool): Promise<Date | null> {
  const r = await readQuery<{ applied_at: Date }>(
    orchDb,
    "SELECT applied_at FROM schema_migrations WHERE filename = '0002_outbox.sql'",
  );
  return r.rows[0]?.applied_at ?? null;
}

export async function loadOutboxFacts(orchDb: Pool, transferIds: readonly string[]): Promise<OutboxFacts[]> {
  const ids = [...transferIds];
  const transfers = await readQuery<{ id: string; state: string; amount: string; terminal_at: Date | null }>(
    orchDb,
    `SELECT t.id, t.state, t.amount::text AS amount,
            (SELECT min(e.created_at) FROM transfer_events e
              WHERE e.transfer_id = t.id
                AND e.to_state IN ('SUCCESS','FAILED','REVERSED','NEEDS_MANUAL_REVIEW')) AS terminal_at
       FROM transfers t WHERE t.id = ANY($1::uuid[])`,
    [ids],
  );
  const events = await readQuery<{
    aggregate_id: string;
    event_type: string;
    payload: Record<string, unknown>;
    published_at: Date | null;
  }>(
    orchDb,
    'SELECT aggregate_id, event_type, payload, published_at FROM outbox WHERE aggregate_id = ANY($1::uuid[])',
    [ids],
  );
  const byTransfer = new Map<string, OutboxFacts['events']>();
  for (const e of events.rows) {
    const list = byTransfer.get(e.aggregate_id) ?? [];
    list.push({ eventType: e.event_type, payload: e.payload, publishedAt: e.published_at });
    byTransfer.set(e.aggregate_id, list);
  }
  return transfers.rows.map((t) => ({
    transferId: t.id,
    state: t.state,
    amount: BigInt(t.amount),
    terminalAt: t.terminal_at,
    events: byTransfer.get(t.id) ?? [],
  }));
}

/**
 * I8. `cutoff` is when the outbox was created (`outboxCutoff`); a transfer that finished
 * before it must have no event. `requirePublished`: the stack is quiet, so every event
 * must have reached Kafka.
 */
export function checkI8(facts: OutboxFacts[], cutoff: Date | null, requirePublished: boolean): InvariantResult {
  const problems: string[] = [];
  let expected = 0;
  let unpublished = 0;
  for (const f of facts) {
    const mustHave = f.terminalAt !== null && cutoff !== null && f.terminalAt >= cutoff;
    if (!mustHave) {
      if (f.events.length > 0)
        problems.push(`${f.transferId} (${f.state}): ${f.events.length} event(s), expected none`);
      continue;
    }
    expected++;
    const [event, ...extra] = f.events;
    if (event === undefined || extra.length > 0) {
      problems.push(`${f.transferId} (${f.state}): ${f.events.length} outbox events, expected exactly 1`);
      continue;
    }
    if (event.eventType !== EVENT_TYPE[f.state]) {
      problems.push(`${f.transferId} (${f.state}): event ${event.eventType}, expected ${EVENT_TYPE[f.state] ?? '?'}`);
    }
    const p = event.payload;
    if (p.transfer_id !== f.transferId || p.state !== f.state || p.amount !== f.amount.toString()) {
      problems.push(
        `${f.transferId}: payload names ${String(p.transfer_id)} / ${String(p.state)} / ${String(p.amount)}`,
      );
    }
    if (event.publishedAt === null) {
      unpublished++;
      if (requirePublished) problems.push(`${f.transferId}: event not published`);
    }
  }
  return result(
    'I8',
    `${expected} terminal transfers with one outbox event each, ${unpublished} unpublished`,
    problems,
  );
}

/** Waits until every outbox event of these transfers is published (the relay drains). */
export async function awaitOutboxPublished(
  orchDb: Pool,
  transferIds: readonly string[],
  timeoutMs: number,
): Promise<void> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const r = await readQuery<{ n: number }>(
      orchDb,
      'SELECT count(*)::int AS n FROM outbox WHERE aggregate_id = ANY($1::uuid[]) AND published_at IS NULL',
      [[...transferIds]],
    );
    if (r.rows[0]?.n === 0) return;
    if (Date.now() >= until)
      throw new Error(`${r.rows[0]?.n ?? '?'} outbox events still unpublished after ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/** One published outbox event and its outcome in `notification_db` (I9). */
export interface NotificationFacts {
  eventId: string;
  transferId: string;
  payeeAccountId: string;
  outcome: string | null;
  attempts: number | null;
}

export async function loadNotificationFacts(
  orchDb: Pool,
  notifyDb: Pool,
  transferIds: readonly string[],
): Promise<NotificationFacts[]> {
  const events = await readQuery<{ id: string; aggregate_id: string; payee: string }>(
    orchDb,
    `SELECT id::text AS id, aggregate_id, payload->'payee'->>'account_id' AS payee
       FROM outbox WHERE aggregate_id = ANY($1::uuid[]) AND published_at IS NOT NULL`,
    [[...transferIds]],
  );
  const ids = events.rows.map((e) => e.id);
  const outcomes = await readQuery<{ event_id: string; outcome: string; attempts: number }>(
    notifyDb,
    'SELECT event_id::text AS event_id, outcome, attempts FROM processed_events WHERE event_id = ANY($1::bigint[])',
    [ids],
  );
  const byId = new Map(outcomes.rows.map((o) => [o.event_id, o]));
  return events.rows.map((e) => ({
    eventId: e.id,
    transferId: e.aggregate_id,
    payeeAccountId: e.payee,
    outcome: byId.get(e.id)?.outcome ?? null,
    attempts: byId.get(e.id)?.attempts ?? null,
  }));
}

/** I9: each published event has exactly one outcome (the primary key forbids a second). */
export function checkI9(facts: NotificationFacts[]): InvariantResult {
  const problems: string[] = [];
  let delivered = 0;
  let deadLettered = 0;
  for (const f of facts) {
    const expected = f.payeeAccountId.startsWith('whfail-') ? 'DEAD_LETTERED' : 'DELIVERED';
    if (f.outcome === null) problems.push(`event ${f.eventId} (${f.transferId}): no outcome recorded`);
    else if (f.outcome !== expected)
      problems.push(`event ${f.eventId} (${f.transferId}): ${f.outcome}, expected ${expected}`);
    else if (f.attempts === null || f.attempts < 1 || f.attempts > 5) {
      problems.push(`event ${f.eventId}: ${String(f.attempts)} attempts`);
    }
    if (f.outcome === 'DELIVERED') delivered++;
    if (f.outcome === 'DEAD_LETTERED') deadLettered++;
  }
  return result(
    'I9',
    `${facts.length} published events: ${delivered} delivered, ${deadLettered} dead-lettered`,
    problems,
  );
}

/** Waits until the notification service has recorded an outcome for every published event. */
export async function awaitNotified(
  orchDb: Pool,
  notifyDb: Pool,
  transferIds: readonly string[],
  timeoutMs: number,
): Promise<void> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const missing = (await loadNotificationFacts(orchDb, notifyDb, transferIds)).filter((f) => f.outcome === null);
    if (missing.length === 0) return;
    if (Date.now() >= until)
      throw new Error(`${missing.length} published events have no outcome after ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

/** I10: `openBreakRefs` are the reference ids of OPEN reconciliation breaks. */
export function checkI10(transfers: RunTransfer[], openBreakRefs: ReadonlySet<string>): InvariantResult {
  const problems = transfers
    .filter((t) => openBreakRefs.has(t.id))
    .map((t) => `${t.id} (${t.state}): open reconciliation break`);
  return result('I10', `${transfers.length} transfers, ${problems.length} with an open reconciliation break`, problems);
}

/** Reference ids of every OPEN break, read from `reconciliation_db`. */
export async function loadOpenBreakRefs(reconDb: Pool): Promise<Set<string>> {
  const r = await readQuery<{ reference_id: string }>(
    reconDb,
    "SELECT DISTINCT reference_id FROM reconciliation_breaks WHERE status = 'OPEN'",
  );
  return new Set(r.rows.map((row) => row.reference_id));
}

export interface DuplicateSample {
  idempotencyKey: string;
  /** Transfer id from every answered request that used this key (original and duplicates). */
  responseIds: string[];
}

/** I7: every duplicate request returned the same transfer id, which has one final state. */
export function checkI7(samples: DuplicateSample[], transfers: RunTransfer[]): InvariantResult {
  const byKey = new Map(transfers.map((t) => [t.idempotencyKey, t]));
  const problems: string[] = [];
  for (const s of samples) {
    const ids = new Set(s.responseIds);
    const stored = byKey.get(s.idempotencyKey);
    if (ids.size !== 1) problems.push(`${s.idempotencyKey}: requests returned ${ids.size} different ids`);
    if (stored === undefined) problems.push(`${s.idempotencyKey}: no transfer stored`);
    else if (!ids.has(stored.id))
      problems.push(`${s.idempotencyKey}: answered ${[...ids].join(',')}, stored ${stored.id}`);
    else if (!TERMINAL.has(stored.state))
      problems.push(`${s.idempotencyKey}: final state ${stored.state} is not terminal`);
  }
  return result('I7', `${samples.length} duplicated keys checked`, problems);
}

// ---------------------------------------------------------------- scoped (no baseline)

/**
 * I2–I4 evaluated from per-transfer evidence alone, for `scripts/checkInvariants.ts`:
 * the bank operations and journals carrying the in-scope transfer ids must add up.
 * I2: money out of payers (debits minus refunds) equals money into payees (credits).
 * I3: those journals leave `transit` unchanged.
 * I4: per bank, the customer effect plus (receivable change minus payable change) is zero.
 */
export function checkScoped(evidence: Evidence[]): InvariantResult[] {
  let out = 0n;
  let inn = 0n;
  let transit = 0n;
  const customers = new Map<BankId, bigint>(BANKS.map((b) => [b, 0n]));
  const receivable = new Map<BankId, bigint>(BANKS.map((b) => [b, 0n]));
  const payable = new Map<BankId, bigint>(BANKS.map((b) => [b, 0n]));
  const add = (m: Map<BankId, bigint>, bank: BankId, v: bigint): void => {
    m.set(bank, (m.get(bank) ?? 0n) + v);
  };

  for (const e of evidence) {
    const t = e.transfer;
    if (e.debit.status === 'APPLIED') {
      out += e.debit.amount;
      add(customers, t.payerBank, -e.debit.amount);
    }
    if (e.reverse.status === 'APPLIED') {
      out -= e.reverse.amount;
      add(customers, t.payerBank, e.reverse.amount);
    }
    if (e.credit.status === 'APPLIED') {
      inn += e.credit.amount;
      add(customers, t.payeeBank, e.credit.amount);
    }
    for (const j of e.journals) {
      for (const l of j.lines) {
        const signed = l.direction === 'D' ? l.amount : -l.amount;
        if (l.accountCode === 'transit') transit -= signed; // liability: credit-normal
        for (const bank of BANKS) {
          if (l.accountCode === `receivable:${bank}`) add(receivable, bank, signed); // asset: debit-normal
          if (l.accountCode === `payable:${bank}`) add(payable, bank, -signed); // liability: credit-normal
        }
      }
    }
  }

  const i4: string[] = [];
  for (const bank of BANKS) {
    const total = (customers.get(bank) ?? 0n) + ((receivable.get(bank) ?? 0n) - (payable.get(bank) ?? 0n));
    if (total !== 0n)
      i4.push(
        `${bank}: customers ${customers.get(bank)} + receivable ${receivable.get(bank)} - payable ${payable.get(bank)} = ${total}`,
      );
  }
  return [
    result(
      'I2',
      `out of payers ${out}, into payees ${inn}`,
      out === inn ? [] : [`payers lost ${out} but payees gained ${inn}`],
    ),
    result('I3', `net transit movement ${transit}`, transit === 0n ? [] : [`transit moved by ${transit}`]),
    result('I4', BANKS.map((b) => `${b}: customers ${customers.get(b)}`).join('; '), i4),
  ];
}

export function formatResults(results: InvariantResult[]): string {
  return results
    .map((r) => {
      const head = `${r.ok ? 'PASS' : 'FAIL'} ${r.id}  ${r.summary}`;
      if (r.ok) return head;
      const more =
        r.problemCount > r.problems.length ? `\n      ... and ${r.problemCount - r.problems.length} more` : '';
      return `${head}\n${r.problems.map((p) => `      - ${p}`).join('\n')}${more}`;
    })
    .join('\n');
}
