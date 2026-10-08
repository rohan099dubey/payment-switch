/**
 * Phase 2, item 4 (ADR-028): the committed Grafana dashboard is valid, covers the panels
 * section 19 names, and queries only metrics the services actually define. A renamed
 * metric would otherwise leave an empty panel nobody notices.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../..');
const DASHBOARD = path.join(ROOT, 'observability/grafana/dashboards/payment-switch.json');

interface Panel {
  type: string;
  title: string;
  datasource?: { uid: string };
  targets?: { expr: string; refId: string }[];
  gridPos: { x: number; y: number; w: number; h: number };
}

const dashboard = JSON.parse(readFileSync(DASHBOARD, 'utf8')) as { uid: string; title: string; panels: Panel[] };
const panels = dashboard.panels.filter((p) => p.type !== 'row');
const rows = dashboard.panels.filter((p) => p.type === 'row').map((p) => p.title);

/** Every metric name registered in the services' and common's source (`name: '...'`). */
function definedMetrics(): Set<string> {
  const files = [
    path.join(ROOT, 'packages/common/src/grpc/instrument.ts'),
    ...readdirSync(path.join(ROOT, 'services')).map((s) => path.join(ROOT, 'services', s, 'src/metrics.ts')),
  ];
  const names = new Set<string>();
  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const m of text.matchAll(/name:\s*'([a-z_]+)'/g)) if (m[1] !== undefined) names.add(m[1]);
  }
  return names;
}

const PROMQL_WORDS = new Set([
  'sum',
  'by',
  'rate',
  'histogram_quantile',
  'or',
  'vector',
  'le',
  'job',
  'route',
  'method',
  'status',
  'final_state',
  'step',
  'state',
  'result',
  'reason',
  'target',
  'outcome',
  'mode',
  'operation',
]);

/** Metric names in a PromQL expression: identifiers that are not functions, keywords or labels. */
function metricsIn(expr: string): string[] {
  const withoutStrings = expr.replace(/"[^"]*"/g, '""');
  return [...withoutStrings.matchAll(/[a-z_][a-z0-9_]*/g)]
    .map((m) => m[0])
    .filter((id) => !PROMQL_WORDS.has(id) && id.includes('_'))
    .map((id) => id.replace(/_(bucket|sum|count)$/, ''));
}

describe('Grafana dashboard (section 19 item 4, ADR-028)', () => {
  it('is provisioned under a stable uid and has the five groups section 19 names', () => {
    expect(dashboard.uid).toBe('payment-switch');
    for (const group of ['Throughput', 'Latency', 'In flight and recovery', 'Injected chaos']) {
      expect(rows).toContain(group);
    }
    const titles = panels.map((p) => p.title.toLowerCase());
    for (const word of ['per second', 'latency', 'in flight', 'recovery', 'chaos']) {
      expect(
        titles.some((t) => t.includes(word)),
        word,
      ).toBe(true);
    }
  });

  it('every panel queries Prometheus and has at least one target with a unique refId', () => {
    for (const panel of panels) {
      expect(panel.datasource?.uid, panel.title).toBe('prometheus');
      expect(panel.targets?.length, panel.title).toBeGreaterThan(0);
      const refIds = (panel.targets ?? []).map((t) => t.refId);
      expect(new Set(refIds).size, panel.title).toBe(refIds.length);
    }
  });

  it('queries only metrics the services define', () => {
    const defined = definedMetrics();
    expect(defined.size).toBeGreaterThan(20);
    const unknown = panels
      .flatMap((p) => (p.targets ?? []).flatMap((t) => metricsIn(t.expr)))
      .filter((m) => !defined.has(m));
    expect(unknown).toEqual([]);
  });

  it('panels do not overlap on the grid', () => {
    const cells = new Set<string>();
    for (const p of dashboard.panels) {
      const h = p.type === 'row' ? 1 : p.gridPos.h;
      for (let x = p.gridPos.x; x < p.gridPos.x + p.gridPos.w; x++) {
        for (let y = p.gridPos.y; y < p.gridPos.y + h; y++) {
          const key = `${x},${y}`;
          expect(cells.has(key), `${p.title} overlaps at ${key}`).toBe(false);
          cells.add(key);
        }
      }
    }
  });
});

describe('Jaeger (ADR-028, amendment 1)', () => {
  it('runs the committed configuration, whose in-memory store is bounded', () => {
    const compose = readFileSync(path.join(ROOT, 'docker-compose.yml'), 'utf8');
    const jaeger = /^ {2}jaeger:\r?\n((?: {4}.*\r?\n|\r?\n)*)/m.exec(compose)?.[1] ?? '';
    expect(jaeger).toContain("command: ['--config', '/etc/jaeger/config.yaml']");
    expect(jaeger).toContain('./observability/jaeger/config.yaml:/etc/jaeger/config.yaml:ro');

    // Each transfer is one trace of about 64 spans: upstream's 100,000 traces reached 2.5 GiB.
    const config = readFileSync(path.join(ROOT, 'observability/jaeger/config.yaml'), 'utf8');
    const limits = [...config.matchAll(/max_traces:\s*(\d+)/g)].map((m) => Number(m[1]));
    expect(limits).toEqual([10_000]);
  });
});
