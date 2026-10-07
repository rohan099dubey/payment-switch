/**
 * Phase 2, item 4 (ARCHITECTURE.md section 19, ADR-028), against the real stack:
 * Prometheus scrapes every service; every committed dashboard query runs; Grafana serves the
 * provisioned dashboard; and one transfer is a single distributed trace across the five
 * services on its path.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BankAdmin } from '../helpers/bankAdmin';
import { DEV_CLIENTS, GatewayClient } from '../helpers/gatewayClient';
import { waitFor } from '../helpers/stack';

const PROMETHEUS = process.env.PROMETHEUS_URL ?? 'http://localhost:9090';
const GRAFANA = process.env.GRAFANA_URL ?? 'http://localhost:3000';
const JAEGER = process.env.JAEGER_URL ?? 'http://localhost:16686';
const DASHBOARD = path.resolve(__dirname, '../../observability/grafana/dashboards/payment-switch.json');

const RUN = randomUUID().slice(0, 8);
const client = GatewayClient.for(DEV_CLIENTS.a);
let banks: BankAdmin;

beforeAll(async () => {
  banks = new BankAdmin();
  await client.accessToken();
});

afterAll(() => {
  banks.close();
});

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

interface Trace {
  traceID: string;
  spans: { spanID: string; operationName: string; processID: string; startTime: number }[];
  processes: Record<string, { serviceName: string }>;
}

describe('observability (section 19 item 4, ADR-028)', () => {
  it('Prometheus scrapes all seven services and every target is up', async () => {
    let targets: { labels: { job: string }; health: string }[] = [];
    await waitFor(
      'every scrape target up',
      async () => {
        const res = await getJson<{ data: { activeTargets: typeof targets } }>(`${PROMETHEUS}/api/v1/targets`);
        targets = res.data.activeTargets;
        return targets.length === 7 && targets.every((t) => t.health === 'up');
      },
      60_000,
    );
    expect(targets.map((t) => t.labels.job).sort()).toEqual([
      'bank-a',
      'bank-b',
      'gateway',
      'ledger',
      'notification',
      'orchestrator',
      'reconciliation',
    ]);
  });

  it('every query on the committed dashboard runs in Prometheus without error', async () => {
    const dashboard = JSON.parse(readFileSync(DASHBOARD, 'utf8')) as {
      panels: { title: string; targets?: { expr: string }[] }[];
    };
    const exprs = dashboard.panels.flatMap((p) => (p.targets ?? []).map((t) => ({ title: p.title, expr: t.expr })));
    expect(exprs.length).toBeGreaterThan(15);
    for (const { title, expr } of exprs) {
      const res = await getJson<{ status: string; error?: string }>(
        `${PROMETHEUS}/api/v1/query?query=${encodeURIComponent(expr)}`,
      );
      expect({ title, status: res.status, error: res.error }).toEqual({ title, status: 'success', error: undefined });
    }
  });

  it('Grafana serves the provisioned dashboard, and its Prometheus datasource is healthy', async () => {
    const health = await getJson<{ database: string }>(`${GRAFANA}/api/health`);
    expect(health.database).toBe('ok');
    const dash = await getJson<{ dashboard: { uid: string; panels: unknown[] } }>(
      `${GRAFANA}/api/dashboards/uid/payment-switch`,
    );
    const committed = JSON.parse(readFileSync(DASHBOARD, 'utf8')) as { panels: unknown[] };
    expect(dash.dashboard.uid).toBe('payment-switch');
    expect(dash.dashboard.panels).toHaveLength(committed.panels.length);
    const ds = await getJson<{ status: string }>(`${GRAFANA}/api/datasources/uid/prometheus/health`);
    expect(ds.status).toBe('OK');
  });

  it(
    'one transfer is one trace across gateway, orchestrator, both banks and the ledger',
    { timeout: 90_000 },
    async () => {
      const payer = `obs-${RUN}-payer`;
      const payee = `obs-${RUN}-payee`;
      await banks.createAccount('bank_a', payer, 10_000n);
      await banks.createAccount('bank_b', payee, 0n);
      const started = Date.now() * 1000; // Jaeger uses microseconds
      const res = await client.createTransfer(
        {
          payer: { bank_id: 'bank_a', account_id: payer },
          payee: { bank_id: 'bank_b', account_id: payee },
          amount: 1000,
          currency: 'INR',
        },
        `obs-${RUN}-key`,
      );
      expect(res.body.state).toBe('SUCCESS');

      const needed = ['gateway', 'orchestrator', 'bank-a', 'bank-b', 'ledger'];
      let found: Trace | undefined;
      await waitFor(
        'the transfer trace to reach Jaeger',
        async () => {
          const traces = await getJson<{ data: Trace[] }>(
            `${JAEGER}/api/traces?service=gateway&start=${started}&limit=50`,
          );
          found = traces.data.find((t) => {
            const services = new Set(Object.values(t.processes).map((p) => p.serviceName));
            return needed.every((s) => services.has(s));
          });
          return found !== undefined;
        },
        60_000,
      );
      if (found === undefined) throw new Error('unreachable');
      const trace = found;
      const ops = trace.spans.map((s) => `${trace.processes[s.processID]?.serviceName}:${s.operationName}`);
      for (const op of [
        'gateway:grpc.switchpay.orchestrator.v1.TransferService/CreateTransfer',
        'orchestrator:grpc.switchpay.bank.v1.BankService/Debit',
        'bank-a:grpc.switchpay.bank.v1.BankService/Debit',
        'orchestrator:grpc.switchpay.ledger.v1.LedgerService/PostJournal',
        'bank-b:grpc.switchpay.bank.v1.BankService/Credit',
      ]) {
        expect(ops).toContain(op);
      }
      // Postgres work is in the same trace (pg instrumentation, only inside requests).
      expect(ops.some((o) => o.startsWith('orchestrator:pg.query'))).toBe(true);
      expect(ops.some((o) => o.startsWith('ledger:pg.query'))).toBe(true);
    },
  );
});
