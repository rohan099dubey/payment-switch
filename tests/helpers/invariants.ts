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
 */
import type { Pool } from 'pg';
import type { BankAdmin, BankId } from './bankAdmin';
import type { JournalView, LedgerReader } from './ledgerClient';

export type InvariantId = 'I1' | 'I2' | 'I3' | 'I4' | 'I5' | 'I6' | 'I7';

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
  const res = await orchDb.query<{
    id: string;
    idempotency_key: string;
    state: string;
    failure_code: string | null;
    payer_bank_id: BankId;
    payee_bank_id: BankId;
    amount: string;
  }>(
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
  const unbalanced = await deps.ledgerDb.query<{ journal_id: string; d: string; c: string }>(
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
