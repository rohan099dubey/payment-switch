/**
 * Phase 2, items 4 and 6 (ADR-028, ADR-030): tracing, metrics and dashboards on Kubernetes.
 * The checks of tests/integration/observability.test.ts, adapted to replicas: Prometheus
 * finds every pod (not one target per service), every dashboard query runs, Grafana serves
 * the provisioned dashboard, and a transfer is still one trace across five services, even
 * with two Gateways and two Orchestrators behind Services.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BankAdmin } from '../helpers/bankAdmin';
import { DEV_CLIENTS, GatewayClient } from '../helpers/gatewayClient';
import { pods } from '../helpers/kube';
import { waitFor } from '../helpers/stack';

const PROMETHEUS = process.env.PROMETHEUS_URL ?? 'http://127.0.0.1:29090';
const GRAFANA = process.env.GRAFANA_URL ?? 'http://127.0.0.1:23000';
const JAEGER = process.env.JAEGER_URL ?? 'http://127.0.0.1:26686';
const DASHBOARD = path.resolve(__dirname, '../../observability/grafana/dashboards/payment-switch.json');
const SERVICES = ['bank-a', 'bank-b', 'gateway', 'ledger', 'notification', 'orchestrator', 'reconciliation'];

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

interface Target {
  labels: { job: string; instance: string };
  health: string;
}

interface Trace {
  spans: { operationName: string; processID: string }[];
  processes: Record<string, { serviceName: string }>;
}

describe('observability on Kubernetes (ADR-028, ADR-030)', () => {
  it('Prometheus scrapes every pod of the seven services, each target up', { timeout: 120_000 }, async () => {
    const running = (await pods()).filter((p) => SERVICES.includes(p.app) && p.ready && !p.deleting);
    let targets: Target[] = [];
    await waitFor(
      'one healthy target per running service pod',
      async () => {
        const res = await getJson<{ data: { activeTargets: Target[] } }>(`${PROMETHEUS}/api/v1/targets`);
        targets = res.data.activeTargets;
        const instances = targets.map((t) => t.labels.instance).sort();
        return (
          JSON.stringify(instances) === JSON.stringify(running.map((p) => p.name).sort()) &&
          targets.every((t) => t.health === 'up')
        );
      },
      90_000,
    );
    expect([...new Set(targets.map((t) => t.labels.job))].sort()).toEqual(SERVICES);
    // Replicas are separate targets: two Orchestrators, two Gateways.
    expect(targets.filter((t) => t.labels.job === 'orchestrator')).toHaveLength(2);
    expect(targets.filter((t) => t.labels.job === 'gateway')).toHaveLength(2);
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
    expect((await getJson<{ database: string }>(`${GRAFANA}/api/health`)).database).toBe('ok');
    const dash = await getJson<{ dashboard: { uid: string; panels: unknown[] } }>(
      `${GRAFANA}/api/dashboards/uid/payment-switch`,
    );
    const committed = JSON.parse(readFileSync(DASHBOARD, 'utf8')) as { panels: unknown[] };
    expect(dash.dashboard.panels).toHaveLength(committed.panels.length);
    const ds = await getJson<{ status: string }>(`${GRAFANA}/api/datasources/uid/prometheus/health`);
    expect(ds.status).toBe('OK');
  });

  it(
    'one transfer is one trace across gateway, orchestrator, both banks and the ledger',
    { timeout: 90_000 },
    async () => {
      const payer = `k8s-obs-${RUN}-payer`;
      const payee = `k8s-obs-${RUN}-payee`;
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
        `k8s-obs-${RUN}-key`,
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
      expect(ops).toContain('gateway:grpc.switchpay.orchestrator.v1.TransferService/CreateTransfer');
      expect(ops).toContain('bank-a:grpc.switchpay.bank.v1.BankService/Debit');
      expect(ops).toContain('bank-b:grpc.switchpay.bank.v1.BankService/Credit');
      expect(ops.some((o) => o.startsWith('ledger:pg.query'))).toBe(true);
    },
  );
});
