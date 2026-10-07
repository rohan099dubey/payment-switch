/**
 * M8 acceptance: every metric in ARCHITECTURE.md section 17 is exposed by its service, on
 * that service's HTTP port, with the specified type and labels. `instrument()` adds the
 * two gRPC metrics to every gRPC service.
 */
import { describe, expect, it } from 'vitest';

interface Expected {
  name: string;
  type: 'counter' | 'histogram' | 'gauge';
  labels: string[];
}

const GRPC: Expected[] = [
  { name: 'grpc_requests_total', type: 'counter', labels: ['method', 'code'] },
  { name: 'grpc_request_duration_seconds', type: 'histogram', labels: ['method'] },
];

const SERVICES: { service: string; url: string; metrics: Expected[] }[] = [
  {
    service: 'gateway',
    url: process.env.GATEWAY_URL ?? 'http://localhost:8080',
    metrics: [
      { name: 'http_requests_total', type: 'counter', labels: ['method', 'route', 'status'] },
      { name: 'http_request_duration_seconds', type: 'histogram', labels: ['method', 'route'] },
      { name: 'rate_limit_rejections_total', type: 'counter', labels: [] },
      { name: 'rate_limit_fail_open_total', type: 'counter', labels: [] },
    ],
  },
  {
    service: 'orchestrator',
    url: process.env.ORCHESTRATOR_HTTP_URL ?? 'http://localhost:9101',
    metrics: [
      ...GRPC,
      { name: 'transfers_total', type: 'counter', labels: ['final_state'] },
      { name: 'transfer_duration_seconds', type: 'histogram', labels: ['final_state'] },
      { name: 'saga_step_duration_seconds', type: 'histogram', labels: ['step'] },
      { name: 'downstream_calls_total', type: 'counter', labels: ['target', 'operation', 'outcome'] },
      { name: 'recovery_runs_total', type: 'counter', labels: ['result'] },
      { name: 'transfers_in_flight', type: 'gauge', labels: ['state'] },
      { name: 'manual_review_total', type: 'counter', labels: ['reason'] },
      // Phase 2, item 1 (ADR-025): the outbox relay.
      { name: 'outbox_published_total', type: 'counter', labels: [] },
      { name: 'outbox_publish_failures_total', type: 'counter', labels: [] },
      { name: 'outbox_unpublished', type: 'gauge', labels: [] },
    ],
  },
  {
    // Phase 2, item 2 (ADR-026): a pure Kafka consumer, so no gRPC metrics.
    service: 'notification',
    url: process.env.NOTIFICATION_HTTP_URL ?? 'http://localhost:9103',
    metrics: [
      { name: 'notifications_total', type: 'counter', labels: ['outcome'] },
      { name: 'webhook_attempts_total', type: 'counter', labels: ['result'] },
    ],
  },
  {
    // Phase 2, item 3 (ADR-027).
    service: 'reconciliation',
    url: process.env.RECONCILIATION_HTTP_URL ?? 'http://localhost:9104',
    metrics: [
      ...GRPC,
      { name: 'reconciliation_runs_total', type: 'counter', labels: ['result'] },
      { name: 'reconciliation_breaks_seen_total', type: 'counter', labels: ['type'] },
      { name: 'reconciliation_open_breaks', type: 'gauge', labels: [] },
    ],
  },
  {
    service: 'ledger',
    url: process.env.LEDGER_HTTP_URL ?? 'http://localhost:9102',
    metrics: [...GRPC, { name: 'journals_posted_total', type: 'counter', labels: ['kind', 'replayed'] }],
  },
  ...(['a', 'b'] as const).map((b) => ({
    service: `bank-${b}`,
    url:
      b === 'a'
        ? (process.env.BANK_A_HTTP_URL ?? 'http://localhost:9111')
        : (process.env.BANK_B_HTTP_URL ?? 'http://localhost:9112'),
    metrics: [
      ...GRPC,
      { name: 'bank_operations_total', type: 'counter' as const, labels: ['operation', 'result'] },
      { name: 'chaos_injected_total', type: 'counter' as const, labels: ['mode'] },
    ],
  })),
];

/** Label names used by a metric's samples (`_bucket`'s `le` excluded). */
function labelsOf(body: string, name: string): Set<string> {
  const labels = new Set<string>();
  const sample = new RegExp(`^${name}(?:_bucket|_sum|_count)?\\{([^}]*)\\}`, 'gm');
  for (const m of body.matchAll(sample)) {
    for (const pair of (m[1] ?? '').split(',')) {
      const key = pair.split('=')[0];
      if (key !== undefined && key !== '' && key !== 'le' && key !== 'bank_id') labels.add(key);
    }
  }
  return labels;
}

describe('section 17 metrics', () => {
  for (const { service, url, metrics } of SERVICES) {
    describe(service, () => {
      it.each(metrics.map((m) => [m.name, m] as const))('exposes %s', async (_name, m) => {
        const body = await (await fetch(`${url}/metrics`)).text();
        expect(body).toContain(`# TYPE ${m.name} ${m.type}`);
        const seen = labelsOf(body, m.name);
        // Every label a sample carries must be one the spec lists (no unbounded extras).
        for (const label of seen) expect(m.labels).toContain(label);
        // And when samples exist, they carry exactly the specified labels.
        if (seen.size > 0) expect([...seen].sort()).toEqual([...m.labels].sort());
      });
    });
  }
});
