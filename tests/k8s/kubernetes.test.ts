/**
 * Phase 2, item 6 (ADR-030): the stack on Kubernetes (kind) behaves like the Compose stack.
 * Needs `npm run k8s:up`; run with `npm run test:k8s`. The invariant checks are the same
 * code as the chaos tests, pointed at the cluster through port-forwards (forwards.ts).
 *
 * 1. Every pod is ready.
 * 2. Network policies: a service reaches its own database and not another's (ADR-007).
 * 3. SUCCESS, replay, FAILED and REVERSED through the Gateway's NodePort.
 * 4. Two Orchestrator replicas; the one holding the most leases is SIGKILLed mid-flight
 *    and its pod deleted, so the replacement is a new instance. Another instance finishes its transfers through
 *    lease expiry and recovery, and I1-I10 hold.
 * 5. `npm run invariants`, unscoped, on the whole cluster.
 */
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { promisify } from 'node:util';
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
import { DEV_CLIENTS, GatewayClient, type HttpResult } from '../helpers/gatewayClient';
import { formatResults, snapshotBaseline } from '../helpers/invariants';
import { crashPod, execIn, pods } from '../helpers/kube';
import { waitFor } from '../helpers/stack';

const RUN = `k8s-${randomUUID().slice(0, 8)}`;
const TRANSFERS = 200;
const TERMINAL = new Set(['SUCCESS', 'FAILED', 'REVERSED', 'NEEDS_MANUAL_REVIEW']);
let stack: ChaosStack;

beforeAll(() => {
  stack = openStack();
});

afterAll(async () => {
  await stack.banks.clearChaos('bank_a').catch(() => undefined);
  await stack.banks.clearChaos('bank_b').catch(() => undefined);
  await stack.close();
});

/** Polls GET /v1/transfers/{id} until the transfer is terminal. */
async function awaitHttpTerminal(client: GatewayClient, created: HttpResult, timeoutMs = 60_000): Promise<HttpResult> {
  const id = created.body.id;
  if (typeof id !== 'string') throw new Error(`no transfer id in ${JSON.stringify(created.body)}`);
  let latest = created;
  const until = Date.now() + timeoutMs;
  while (!TERMINAL.has(String(latest.body.state))) {
    if (Date.now() > until) throw new Error(`transfer ${id} still ${String(latest.body.state)}`);
    await sleep(200);
    latest = await client.getTransfer(id);
  }
  return latest;
}

describe('the stack on Kubernetes (ADR-030)', () => {
  it('runs every workload with all pods ready, including two Orchestrators', async () => {
    const all = (await pods()).filter((p) => !p.deleting);
    const notReady = all.filter((p) => p.phase !== 'Running' || !p.ready).map((p) => `${p.name} (${p.phase})`);
    expect(notReady).toEqual([]);
    const byApp = countBy(all, (p) => p.app);
    expect(byApp).toMatchObject({ orchestrator: 2, gateway: 2, 'bank-a': 1, 'bank-b': 1, kafka: 1 });
  });

  it('lets a service reach its own database and no other (network policies, ADR-007)', async () => {
    const [orchestrator] = await pods('orchestrator');
    const [ledger] = await pods('ledger');
    const [gateway] = await pods('gateway');
    if (orchestrator === undefined || ledger === undefined || gateway === undefined) throw new Error('missing pods');
    const reach = (pod: string, host: string, port = 5432): Promise<number> =>
      execIn(pod, `nc -z -w 3 ${host} ${String(port)}`);

    // Controls: the owners connect.
    expect(await reach(orchestrator.name, 'postgres-orchestrator')).toBe(0);
    expect(await reach(ledger.name, 'postgres-ledger')).toBe(0);
    // Everyone else is dropped.
    expect(await reach(orchestrator.name, 'postgres-ledger')).not.toBe(0);
    expect(await reach(orchestrator.name, 'postgres-banks')).not.toBe(0);
    expect(await reach(ledger.name, 'postgres-orchestrator')).not.toBe(0);
    expect(await reach(gateway.name, 'postgres-orchestrator')).not.toBe(0);
    // The Gateway calls the Orchestrator, never a bank or the Ledger directly.
    expect(await reach(gateway.name, 'orchestrator', 50051)).toBe(0);
    expect(await reach(gateway.name, 'bank-a', 50061)).not.toBe(0);
    expect(await reach(gateway.name, 'ledger', 50052)).not.toBe(0);
  });

  it('answers SUCCESS, a replay, FAILED and REVERSED through the Gateway NodePort', async () => {
    const client = GatewayClient.for(DEV_CLIENTS.a);
    const a = `${RUN}-happy-a`;
    const b = `${RUN}-happy-b`;
    await stack.banks.createAccount('bank_a', a, 100_000n);
    await stack.banks.createAccount('bank_b', b, 0n);
    const transfer = (payer: string, payee: string, amount: number): TransferBody => ({
      payer: { bank_id: 'bank_a', account_id: payer },
      payee: { bank_id: 'bank_b', account_id: payee },
      amount,
      currency: 'INR',
    });

    const created = await client.createTransfer(transfer(a, b, 12_500), `${RUN}-ok`);
    expect([201, 202]).toContain(created.status);
    const done = await awaitHttpTerminal(client, created);
    expect(done.body.state).toBe('SUCCESS');

    const replay = await client.createTransfer(transfer(a, b, 12_500), `${RUN}-ok`);
    expect(replay.status).toBe(200);
    expect(replay.headers.get('idempotent-replay')).toBe('true');
    expect(replay.body.id).toBe(created.body.id);

    const broke = await client.createTransfer(transfer(a, b, 10_000_000), `${RUN}-nsf`);
    expect((await awaitHttpTerminal(client, broke)).body.state).toBe('FAILED');

    const missing = await client.createTransfer(transfer(a, `${RUN}-no-such-payee`, 1_000), `${RUN}-rev`);
    expect((await awaitHttpTerminal(client, missing)).body.state).toBe('REVERSED');

    expect(await stack.banks.balance('bank_a', a)).toBe(100_000n - 12_500n);
    expect(await stack.banks.balance('bank_b', b)).toBe(12_500n);
  });

  it(
    'survives a SIGKILL of one of two Orchestrators mid-flight; the other instance takes over; I1-I10 hold',
    { timeout: 420_000 },
    async () => {
      await quiesce(stack);
      const accounts = await createAccounts(stack, RUN, 10, 1_000_000n);
      const baseline = await snapshotBaseline(stack, accounts);
      for (const c of stack.clients) await c.accessToken();

      // Slow banks, so the kill lands while transfers hold leases (section 16 crash test).
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

      const random = mulberry32(11);
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

      // Kill the Orchestrator that holds the most of this run's leases right now.
      await sleep(1000);
      const holders = await stack.orchDb.query<{ instance: string; n: number }>(
        `SELECT split_part(lease_owner, ':', 1) AS instance, count(*)::int AS n FROM transfers
          WHERE idempotency_key LIKE $1 || '%' AND lease_owner IS NOT NULL
          GROUP BY 1 ORDER BY 2 DESC`,
        [RUN],
      );
      const victim = holders.rows[0]?.instance;
      if (victim === undefined) throw new Error('no transfer of this run holds a lease: the kill would prove nothing');
      const orchestrators = (await pods('orchestrator')).map((p) => p.name);
      expect(orchestrators).toContain(victim);
      await crashPod(victim, 'orchestrator');
      const answers = await Promise.all(sends);

      await stack.banks.clearChaos('bank_a');
      await stack.banks.clearChaos('bank_b');
      await awaitAllTerminal(stack, RUN, 180_000);
      // The Deployment replaces the killed pod.
      await waitFor(
        'two ready Orchestrators again',
        async () => (await pods('orchestrator')).filter((p) => p.ready && !p.deleting).length === 2,
        180_000,
      );

      const report = await evaluate(stack, baseline, RUN);
      const takeover = await stack.orchDb.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM transfers t
          WHERE t.idempotency_key LIKE $1 || '%'
            AND EXISTS (SELECT 1 FROM transfer_events e WHERE e.transfer_id = t.id
                         AND split_part(e.detail->>'lease_owner', ':', 1) = $2)
            AND (SELECT split_part(e.detail->>'lease_owner', ':', 1) FROM transfer_events e
                  WHERE e.transfer_id = t.id AND e.detail->>'lease_owner' IS NOT NULL ORDER BY e.id DESC LIMIT 1) <> $2`,
        [RUN, victim],
      );
      const recovered = await stack.orchDb.query<{ n: number }>(
        `SELECT count(DISTINCT e.transfer_id)::int AS n FROM transfer_events e JOIN transfers t ON t.id = e.transfer_id
          WHERE t.idempotency_key LIKE $1 || '%' AND e.detail->>'driver' = 'recovery'`,
        [RUN],
      );
      console.log(
        `k8s crash ${RUN}: ${JSON.stringify({
          sent: TRANSFERS,
          killed: victim,
          leasesHeld: holders.rows,
          http: countBy(answers, (a) => String(a.status)),
          registered: report.transfers.length,
          final: countBy(report.transfers, (t) => t.state),
          finishedByAnotherInstance: takeover.rows[0]?.n,
          finishedByRecovery: recovered.rows[0]?.n,
        })}\n${formatResults(report.results)}`,
      );

      // The crash must have caught requests mid-flight, or the test proves nothing.
      expect(answers.filter((a) => a.status === 0 || a.status >= 500).length).toBeGreaterThan(0);
      expect(report.transfers.length).toBeGreaterThan(0);
      expect(takeover.rows[0]?.n).toBeGreaterThan(0);
      expect(recovered.rows[0]?.n).toBeGreaterThan(0);
      for (const r of report.results) expect(r.problems, `${r.id}: ${r.summary}`).toEqual([]);
    },
  );

  it('passes npm run invariants, unscoped, on the whole cluster', { timeout: 300_000 }, async () => {
    const root = path.resolve(__dirname, '..', '..');
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'), path.join(root, 'scripts', 'checkInvariants.ts')],
      { cwd: root, env: process.env, timeout: 280_000, maxBuffer: 16 * 1024 * 1024 },
    );
    console.log(stdout);
    expect(stdout).not.toMatch(/^FAIL/m);
  });
});
