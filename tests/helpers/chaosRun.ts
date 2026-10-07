/**
 * Shared machinery for the chaos tests (section 16): test accounts, quiescing the stack
 * before a baseline, a client that retries the way section 16 says clients must, waiting
 * for every transfer to finish, and evaluating I1–I7.
 */
import { sleep } from '@switch/common';
import { Pool } from 'pg';
import { BankAdmin, type BankId } from './bankAdmin';
import { DEV_CLIENTS, GatewayClient, type HttpResult } from './gatewayClient';
import {
  awaitOutboxPublished,
  readQuery,
  checkI8,
  loadOutboxFacts,
  outboxCutoff,
  checkI1,
  checkI2,
  checkI3,
  checkI4,
  checkI5,
  checkI6,
  checkI7,
  collectEvidence,
  loadTransfers,
  type Baseline,
  type DuplicateSample,
  type InvariantDeps,
  type InvariantResult,
  type RunTransfer,
  type TestAccount,
} from './invariants';
import { LedgerReader } from './ledgerClient';
import { waitFor } from './stack';

export const ORCH_DB = process.env.ORCHESTRATOR_DATABASE_URL ?? 'postgres://orch:orch@localhost:5433/orchestrator_db';
export const LEDGER_DB = process.env.LEDGER_DATABASE_URL ?? 'postgres://ledger:ledger@localhost:5434/ledger_db';

export interface ChaosStack extends InvariantDeps {
  banks: BankAdmin;
  ledger: LedgerReader;
  orchDb: Pool;
  ledgerDb: Pool;
  /** One API client per dev credential: each has its own rate-limit bucket. */
  clients: GatewayClient[];
  close: () => Promise<void>;
}

export function openStack(): ChaosStack {
  const banks = new BankAdmin();
  const ledger = new LedgerReader();
  const orchDb = new Pool({ connectionString: ORCH_DB, max: 4 });
  const ledgerDb = new Pool({ connectionString: LEDGER_DB, max: 2 });
  return {
    banks,
    ledger,
    orchDb,
    ledgerDb,
    concurrency: 32,
    clients: [DEV_CLIENTS.demo, DEV_CLIENTS.a, DEV_CLIENTS.b, DEV_CLIENTS.rateLimit].map((c) => GatewayClient.for(c)),
    close: async () => {
      banks.close();
      ledger.close();
      await orchDb.end();
      await ledgerDb.end();
    },
  };
}

const NON_TERMINAL_SQL = "state NOT IN ('SUCCESS','FAILED','REVERSED','NEEDS_MANUAL_REVIEW')";

/**
 * Waits until no transfer anywhere is in flight. A baseline is only meaningful if no
 * other traffic (including the recovery worker finishing earlier work) can move money
 * while the run is measured (section 16: "No other traffic may hit the stack").
 */
export async function quiesce(stack: ChaosStack, timeoutMs = 180_000): Promise<void> {
  await waitFor(
    'no transfer in flight',
    async () => {
      const r = await readQuery<{ n: number }>(
        stack.orchDb,
        `SELECT count(*)::int AS n FROM transfers WHERE ${NON_TERMINAL_SQL}`,
      );
      return r.rows[0]?.n === 0;
    },
    timeoutMs,
  );
}

export async function createAccounts(
  stack: ChaosStack,
  prefix: string,
  perBank: number,
  openingBalance: bigint,
): Promise<TestAccount[]> {
  const accounts: TestAccount[] = [];
  for (const bank of ['bank_a', 'bank_b'] as const) {
    for (let i = 1; i <= perBank; i++)
      accounts.push({ bank, accountId: `${prefix}-${bank}-${String(i).padStart(3, '0')}` });
  }
  for (const a of accounts) await stack.banks.createAccount(a.bank, a.accountId, openingBalance);
  return accounts;
}

/** Polls the run's transfers until none is non-terminal, or throws after `timeoutMs`. */
export async function awaitAllTerminal(stack: ChaosStack, keyPrefix: string, timeoutMs: number): Promise<void> {
  await waitFor(
    `every ${keyPrefix}* transfer terminal`,
    async () => {
      const r = await readQuery<{ n: number }>(
        stack.orchDb,
        `SELECT count(*)::int AS n FROM transfers WHERE idempotency_key LIKE $1 || '%' AND ${NON_TERMINAL_SQL}`,
        [keyPrefix],
      );
      return r.rows[0]?.n === 0;
    },
    timeoutMs,
  );
}

export interface TransferBody {
  payer: { bank_id: BankId; account_id: string };
  payee: { bank_id: BankId; account_id: string };
  amount: number;
  currency: 'INR';
}

export interface Answer {
  status: number;
  id: string | undefined;
  /** Milliseconds from the first send to the final answer, retries included. */
  latencyMs: number;
  attempts: number;
}

export interface RetryPolicy {
  /** Retries after the first attempt for a 5xx or a network error (section 16: 10). */
  retries: number;
  delayMs: number;
}

export const SECTION_16_RETRY: RetryPolicy = { retries: 10, delayMs: 500 };

/**
 * Sends one transfer the way section 16 says a client must: on a 5xx or a network error,
 * retry with the **same** Idempotency-Key, up to `retries` times, `delayMs` apart. A 429
 * waits out `Retry-After` and does not use up a retry (it is the limiter, not a failure).
 * Returns the final answer, or `status: 0` if every attempt failed.
 */
export async function sendWithRetry(
  client: GatewayClient,
  body: TransferBody,
  key: string,
  policy: RetryPolicy = SECTION_16_RETRY,
): Promise<Answer> {
  const started = Date.now();
  let failures = 0;
  let attempts = 0;
  for (;;) {
    attempts++;
    let res: HttpResult | undefined;
    try {
      res = await client.createTransfer(body, key);
    } catch {
      res = undefined; // network error
    }
    if (res !== undefined && res.status === 429) {
      await sleep(Number(res.headers.get('retry-after') ?? '1') * 1000);
      continue;
    }
    if (res !== undefined && res.status < 500) {
      const id = typeof res.body.id === 'string' ? res.body.id : undefined;
      return { status: res.status, id, latencyMs: Date.now() - started, attempts };
    }
    if (++failures > policy.retries) {
      return { status: res?.status ?? 0, id: undefined, latencyMs: Date.now() - started, attempts };
    }
    await sleep(policy.delayMs);
  }
}

export interface RunReport {
  results: InvariantResult[];
  transfers: RunTransfer[];
}

/** Evaluates I1–I6 (and I7 when duplicate samples are given) for one run. */
export async function evaluate(
  stack: ChaosStack,
  baseline: Baseline,
  keyPrefix: string,
  duplicates?: DuplicateSample[],
): Promise<RunReport> {
  const transfers = await loadTransfers(stack.orchDb, { keyPrefix });
  const evidence = await collectEvidence(stack, transfers);
  // I8 (ADR-025): the relay may still be draining; Kafka is up, so it must catch up.
  const ids = transfers.map((t) => t.id);
  await awaitOutboxPublished(stack.orchDb, ids, 120_000);
  const outbox = checkI8(await loadOutboxFacts(stack.orchDb, ids), await outboxCutoff(stack.orchDb), true);
  const results = [
    await checkI1(stack),
    await checkI2(stack, baseline),
    await checkI3(stack, baseline),
    await checkI4(stack, baseline),
    checkI5(evidence),
    checkI6(transfers),
    ...(duplicates === undefined ? [] : [checkI7(duplicates, transfers)]),
    outbox,
  ];
  return { results, transfers };
}

/** A uniformly random element; throws on an empty list. */
export function pickFrom<T>(items: readonly T[], random: () => number): T {
  const item = items[Math.floor(random() * items.length)];
  if (item === undefined) throw new Error('pickFrom: empty list');
  return item;
}

export function countBy<T>(items: readonly T[], key: (item: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) out[key(item)] = (out[key(item)] ?? 0) + 1;
  return out;
}

export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i] ?? 0;
}

/** Sum of `chaos_injected_total` per mode on one bank's /metrics. */
export async function chaosCounts(httpUrl: string): Promise<Record<string, number>> {
  const text = await (await fetch(`${httpUrl}/metrics`)).text();
  const out: Record<string, number> = {};
  for (const line of text.split('\n')) {
    const m = /^chaos_injected_total\{.*mode="([a-z_]+)".*\} (\d+)/.exec(line);
    if (m?.[1] !== undefined) out[m[1]] = (out[m[1]] ?? 0) + Number(m[2]);
  }
  return out;
}

export function diffCounts(after: Record<string, number>, before: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(after)) out[k] = v - (before[k] ?? 0);
  return out;
}
