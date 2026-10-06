/**
 * Section 16, invariant test: the proof the project works.
 *
 * Env (defaults from the spec): TRANSFER_COUNT=10000 (CI 1000), CONCURRENCY=100,
 * ACCOUNTS_PER_BANK=20, OPENING_BALANCE=1000000. TEST_SEED picks the generated workload
 * (payers, payees, amounts, ghosts, duplicates); the bank chaos seed stays 42 per the spec.
 *
 * 1. Create the test accounts on both banks and take the baseline snapshot.
 * 2. Both banks: latency 5–50 ms, reject 0.05, late_apply 0.02, lost_response 0.03,
 *    slow_ms 3000, seed 42.
 * 3. Seeded workload: random distinct payer and payee among all test accounts, amount 1 to
 *    50000 paise; 5 % to a non-existent payee (forces reversals); 5 % sent as concurrent
 *    duplicates of a request.
 * 4. Run at CONCURRENCY. At 25, 50 and 75 % of progress, kill the Orchestrator and restart
 *    it 2 s later. The client retries any 5xx or network error with the same key, up to
 *    10 times, 500 ms apart.
 * 5. When every request has an answer, clear chaos and poll every transfer until terminal
 *    (180 s).
 * 6. I1–I7 hold, zero manual review; print the summary.
 */
import { randomUUID } from 'node:crypto';
import { sleep } from '@switch/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mulberry32 } from '../../services/mockBank/src/chaos/prng';
import {
  awaitAllTerminal,
  chaosCounts,
  countBy,
  createAccounts,
  diffCounts,
  evaluate,
  openStack,
  pickFrom,
  percentile,
  quiesce,
  sendWithRetry,
  type Answer,
  type ChaosStack,
  type TransferBody,
} from '../helpers/chaosRun';
import { formatResults, mapLimit, snapshotBaseline, type DuplicateSample } from '../helpers/invariants';
import { killService, startService, waitReady } from '../helpers/stack';

const env = (name: string, fallback: number): number => {
  const raw = process.env[name];
  const value = raw === undefined || raw === '' ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer, got ${raw}`);
  return value;
};

const TRANSFER_COUNT = env('TRANSFER_COUNT', 10_000);
const CONCURRENCY = env('CONCURRENCY', 100);
const ACCOUNTS_PER_BANK = env('ACCOUNTS_PER_BANK', 20);
const OPENING_BALANCE = BigInt(env('OPENING_BALANCE', 1_000_000));
const TEST_SEED = env('TEST_SEED', 1);

const RUN = `inv-s${TEST_SEED}-${randomUUID().slice(0, 8)}`;
const BANK_HTTP = { bank_a: 'http://localhost:9111', bank_b: 'http://localhost:9112' } as const;
let stack: ChaosStack;

beforeAll(() => {
  stack = openStack();
});

afterAll(async () => {
  await stack.banks.clearChaos('bank_a').catch(() => undefined);
  await stack.banks.clearChaos('bank_b').catch(() => undefined);
  await startService('orchestrator');
  await waitReady('http://localhost:8080/readyz', 90_000);
  await stack.close();
});

interface Job {
  index: number;
  key: string;
  clientIndex: number;
  body: TransferBody;
  duplicate: boolean;
  ghost: boolean;
}

describe(`invariant test (section 16): ${TRANSFER_COUNT} transfers, seed ${TEST_SEED}`, () => {
  it('I1–I7 hold under chaos and Orchestrator kills; zero manual review', { timeout: 3_600_000 }, async () => {
    const startedAt = Date.now();

    // 1. Accounts and baseline (with nothing else in flight).
    await quiesce(stack);
    const accounts = await createAccounts(stack, RUN, ACCOUNTS_PER_BANK, OPENING_BALANCE);
    const baseline = await snapshotBaseline(stack, accounts);
    for (const c of stack.clients) await c.accessToken();

    // 2. Chaos, exactly as section 16 specifies.
    const chaosBefore = { bank_a: await chaosCounts(BANK_HTTP.bank_a), bank_b: await chaosCounts(BANK_HTTP.bank_b) };
    for (const bank of ['bank_a', 'bank_b'] as const) {
      await stack.banks.setChaos(bank, {
        down: false,
        latencyMinMs: 5,
        latencyMaxMs: 50,
        rejectRate: 0.05,
        lateApplyRate: 0.02,
        lostResponseRate: 0.03,
        slowMs: 3000,
        seed: 42,
      });
    }

    // 3. The seeded workload.
    const random = mulberry32(TEST_SEED);
    const pick = (): (typeof accounts)[number] => pickFrom(accounts, random);
    const jobs: Job[] = [];
    for (let i = 0; i < TRANSFER_COUNT; i++) {
      const payer = pick();
      let payee = pick();
      while (payee === payer) payee = pick();
      const ghost = random() < 0.05;
      const duplicate = random() < 0.05;
      const ghostBank = random() < 0.5 ? 'bank_a' : 'bank_b';
      jobs.push({
        index: i,
        key: `${RUN}-${i}`,
        clientIndex: i % stack.clients.length,
        duplicate,
        ghost,
        body: {
          payer: { bank_id: payer.bank, account_id: payer.accountId },
          payee: ghost
            ? { bank_id: ghostBank, account_id: `${RUN}-ghost` }
            : { bank_id: payee.bank, account_id: payee.accountId },
          amount: 1 + Math.floor(random() * 50_000),
          currency: 'INR',
        },
      });
    }

    // 4. Run at CONCURRENCY with three Orchestrator kills.
    const answers: { job: Job; answer: Answer }[] = [];
    const duplicates = new Map<string, DuplicateSample>();
    let done = 0;
    const killAt = [0.25, 0.5, 0.75].map((f) => Math.floor(f * TRANSFER_COUNT));
    const kills: Promise<void>[] = [];
    const killAndRestart = async (): Promise<void> => {
      await killService('orchestrator');
      await sleep(2000);
      await startService('orchestrator');
    };

    await mapLimit(jobs, CONCURRENCY, async (job) => {
      const client = stack.clients[job.clientIndex];
      if (client === undefined) throw new Error('no client');
      if (job.duplicate) {
        // The same request twice, at the same moment: the unique index must arbitrate.
        const [a, b] = await Promise.all([
          sendWithRetry(client, job.body, job.key),
          sendWithRetry(client, job.body, job.key),
        ]);
        answers.push({ job, answer: a }, { job, answer: b });
        duplicates.set(job.key, {
          idempotencyKey: job.key,
          responseIds: [a.id, b.id].filter((x): x is string => x !== undefined),
        });
      } else {
        answers.push({ job, answer: await sendWithRetry(client, job.body, job.key) });
      }
      done++;
      if (done === killAt[0]) {
        killAt.shift();
        kills.push(killAndRestart());
      }
    });
    await Promise.all(kills);
    const sendSeconds = (Date.now() - startedAt) / 1000;

    // A request still failing (5xx or network) after its 10 retries ran into an Orchestrator
    // restart longer than its retry window (Docker Desktop alone needs ~1.7 s to start the
    // container). The README tells clients to keep retrying with the same key, so it is
    // sent again below, after the outages: it must then get an answer, and the same
    // transfer if one was registered (ADR-021).
    const failed = (a: Answer): boolean => a.status === 0 || a.status >= 500;
    const gaveUp = answers.filter((x) => failed(x.answer));

    // 5. Clear chaos; everything must finish.
    await stack.banks.clearChaos('bank_a');
    await stack.banks.clearChaos('bank_b');
    await awaitAllTerminal(stack, RUN, 180_000);

    const resent: { job: Job; answer: Answer }[] = [];
    for (const { job } of gaveUp) {
      const client = stack.clients[job.clientIndex];
      if (client === undefined) throw new Error('no client');
      const answer = await sendWithRetry(client, job.body, job.key);
      resent.push({ job, answer });
      // I7 also covers resends: a late retry must return the stored transfer.
      if (answer.id !== undefined) {
        const sample = duplicates.get(job.key) ?? { idempotencyKey: job.key, responseIds: [] };
        sample.responseIds.push(answer.id);
        duplicates.set(job.key, sample);
      }
    }
    const unanswered = resent.filter((x) => failed(x.answer));
    // A resend may have registered a transfer that never existed: let it finish too.
    await awaitAllTerminal(stack, RUN, 180_000);

    // 6. Invariants and summary.
    const report = await evaluate(stack, baseline, RUN, [...duplicates.values()]);
    const latencies = answers.map((x) => x.answer.latencyMs).sort((x, y) => x - y);
    const recovery = await stack.orchDb.query<{ transfers: number; events: number }>(
      `SELECT count(DISTINCT e.transfer_id)::int AS transfers, count(*)::int AS events
         FROM transfer_events e JOIN transfers t ON t.id = e.transfer_id
        WHERE t.idempotency_key LIKE $1 || '%' AND e.detail->>'driver' = 'recovery'`,
      [RUN],
    );
    const summary = {
      run: RUN,
      seed: TEST_SEED,
      transfers: TRANSFER_COUNT,
      concurrency: CONCURRENCY,
      requests: answers.length,
      duplicateKeys: duplicates.size,
      ghostPayees: jobs.filter((j) => j.ghost).length,
      http: countBy(answers, (x) => String(x.answer.status)),
      retriedRequests: answers.filter((x) => x.answer.attempts > 1).length,
      gaveUpAfterRetries: gaveUp.length,
      resentLater: countBy(resent, (x) => String(x.answer.status)),
      unanswered: unanswered.length,
      finalStates: countBy(report.transfers, (t) => t.state),
      failureCodes: countBy(
        report.transfers.filter((t) => t.failureCode !== null),
        (t) => t.failureCode ?? '',
      ),
      chaosInjected: {
        bank_a: diffCounts(await chaosCounts(BANK_HTTP.bank_a), chaosBefore.bank_a),
        bank_b: diffCounts(await chaosCounts(BANK_HTTP.bank_b), chaosBefore.bank_b),
      },
      recovery: recovery.rows[0],
      latencyMs: { p50: percentile(latencies, 50), p95: percentile(latencies, 95), max: latencies.at(-1) },
      sendSeconds,
      totalSeconds: (Date.now() - startedAt) / 1000,
    };
    console.log(`\ninvariant run summary\n${JSON.stringify(summary, null, 2)}\n${formatResults(report.results)}\n`);

    expect(unanswered, 'every request must have an answer').toEqual([]);
    expect(report.transfers.length).toBeGreaterThan(0);
    for (const r of report.results) expect(r.problems, `${r.id}: ${r.summary}`).toEqual([]);
    expect(report.transfers.filter((t) => t.state === 'NEEDS_MANUAL_REVIEW')).toEqual([]);
  });
});
