/**
 * Section 16, crash recovery test:
 * 1. Both banks at latency 200–400 ms, so transfers are slow enough to be caught mid-flight.
 * 2. 200 transfers sent concurrently.
 * 3. After about 1 s, `docker compose kill orchestrator`; 3 s later, start it again.
 * 4. Clear chaos; poll every transfer until terminal (90 s).
 * 5. I1–I6 hold.
 */
import { randomUUID } from 'node:crypto';
import { sleep } from '@switch/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mulberry32 } from '../../services/mockBank/src/chaos/prng';
import {
  awaitAllTerminal,
  countBy,
  createAccounts,
  evaluate,
  openStack,
  pickFrom,
  quiesce,
  type Answer,
  type ChaosStack,
  type TransferBody,
} from '../helpers/chaosRun';
import { formatResults, snapshotBaseline } from '../helpers/invariants';
import { killService, startService, waitReady } from '../helpers/stack';

const RUN = `crash-${randomUUID().slice(0, 8)}`;
const TRANSFERS = 200;
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

describe('crash recovery (section 16)', () => {
  it('200 in-flight transfers survive an Orchestrator SIGKILL; I1–I6 hold', { timeout: 300_000 }, async () => {
    await quiesce(stack);
    const accounts = await createAccounts(stack, RUN, 10, 1_000_000n);
    const baseline = await snapshotBaseline(stack, accounts);
    for (const c of stack.clients) await c.accessToken();

    // 1. Slow banks.
    for (const bank of ['bank_a', 'bank_b'] as const) {
      await stack.banks.setChaos(bank, {
        down: false,
        latencyMinMs: 200,
        latencyMaxMs: 400,
        rejectRate: 0,
        lateApplyRate: 0,
        lostResponseRate: 0,
        slowMs: 3000,
        seed: 42,
      });
    }

    // 2. 200 concurrent transfers between random distinct test accounts.
    const random = mulberry32(7);
    const pick = (): (typeof accounts)[number] => pickFrom(accounts, random);
    const sends: Promise<Answer>[] = [];
    for (let i = 0; i < TRANSFERS; i++) {
      const payer = pick();
      let payee = pick();
      while (payee === payer) payee = pick();
      const body: TransferBody = {
        payer: { bank_id: payer.bank, account_id: payer.accountId },
        payee: { bank_id: payee.bank, account_id: payee.accountId },
        amount: 1 + Math.floor(random() * 50_000),
        currency: 'INR',
      };
      const client = stack.clients[i % stack.clients.length];
      if (client === undefined) throw new Error('no client');
      const started = Date.now();
      sends.push(
        client.createTransfer(body, `${RUN}-${i}`).then(
          (r) => ({
            status: r.status,
            id: typeof r.body.id === 'string' ? r.body.id : undefined,
            latencyMs: Date.now() - started,
            attempts: 1,
          }),
          () => ({ status: 0, id: undefined, latencyMs: Date.now() - started, attempts: 1 }),
        ),
      );
    }

    // 3. Kill the Orchestrator mid-flight, restart it 3 s later.
    await sleep(1000);
    await killService('orchestrator');
    await sleep(3000);
    await startService('orchestrator');
    const answers = await Promise.all(sends);

    // 4. Clear chaos; everything that was registered must finish.
    await stack.banks.clearChaos('bank_a');
    await stack.banks.clearChaos('bank_b');
    await awaitAllTerminal(stack, RUN, 90_000);

    // 5. Invariants.
    const report = await evaluate(stack, baseline, RUN);
    const summary = {
      sent: TRANSFERS,
      http: countBy(answers, (a) => String(a.status)),
      registered: report.transfers.length,
      final: countBy(report.transfers, (t) => t.state),
    };
    console.log(`crash recovery ${RUN}: ${JSON.stringify(summary)}\n${formatResults(report.results)}`);

    // The kill must actually have caught transfers mid-flight, or the test proves nothing.
    expect(answers.filter((a) => a.status === 0 || a.status >= 500).length).toBeGreaterThan(0);
    expect(report.transfers.length).toBeGreaterThan(0);
    // ...and the recovery worker must actually have finished some of them.
    const recovered = await stack.orchDb.query<{ n: number }>(
      `SELECT count(DISTINCT e.transfer_id)::int AS n FROM transfer_events e JOIN transfers t ON t.id = e.transfer_id
        WHERE t.idempotency_key LIKE $1 || '%' AND e.detail->>'driver' = 'recovery'`,
      [RUN],
    );
    console.log(`transfers finished by recovery: ${recovered.rows[0]?.n}`);
    expect(recovered.rows[0]?.n).toBeGreaterThan(0);
    for (const r of report.results) expect(r.problems, `${r.id}: ${r.summary}`).toEqual([]);
  });
});
