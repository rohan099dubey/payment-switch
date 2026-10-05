import { describe, expect, it } from 'vitest';
import { ChaosEngine, chooseMode, validateChaosSettings, type ChaosSettings } from '../../src/chaos/chaos';

const QUIET: ChaosSettings = {
  down: false,
  latencyMinMs: 0,
  latencyMaxMs: 0,
  rejectRate: 0,
  lateApplyRate: 0,
  lostResponseRate: 0,
  slowMs: 3000,
  seed: 42,
};

const MIXED: ChaosSettings = { ...QUIET, rejectRate: 0.1, lateApplyRate: 0.2, lostResponseRate: 0.3 };

describe('chooseMode — cumulative thresholds in spec order', () => {
  it('maps draws for money RPCs: reject, then late_apply, then lost_response, then normal', () => {
    // Probe just either side of each threshold. Cumulative thresholds are float sums
    // (0.1 + 0.2 = 0.30000000000000004), so exact boundaries can move by ~1e-17.
    expect(chooseMode(0, MIXED, 'money')).toBe('reject');
    expect(chooseMode(0.0999, MIXED, 'money')).toBe('reject');
    expect(chooseMode(0.1001, MIXED, 'money')).toBe('late_apply');
    expect(chooseMode(0.2999, MIXED, 'money')).toBe('late_apply');
    expect(chooseMode(0.3001, MIXED, 'money')).toBe('lost_response');
    expect(chooseMode(0.5999, MIXED, 'money')).toBe('lost_response');
    expect(chooseMode(0.6001, MIXED, 'money')).toBe('normal');
    expect(chooseMode(0.9999, MIXED, 'money')).toBe('normal');
  });

  it('lets Resolve and GetOperation honour only reject_rate', () => {
    expect(chooseMode(0.05, MIXED, 'lookup')).toBe('reject');
    expect(chooseMode(0.15, MIXED, 'lookup')).toBe('normal');
    expect(chooseMode(0.45, MIXED, 'lookup')).toBe('normal');
  });

  it('never injects with all rates zero, and always rejects with reject_rate 1', () => {
    expect(chooseMode(0, QUIET, 'money')).toBe('normal');
    expect(chooseMode(0.9999, { ...QUIET, rejectRate: 1 }, 'money')).toBe('reject');
  });
});

describe('ChaosEngine', () => {
  function modes(engine: ChaosEngine, n: number): string[] {
    return Array.from({ length: n }, () => engine.plan('money').mode);
  }

  it('injects the same failures for the same seed (determinism)', () => {
    expect(modes(new ChaosEngine(MIXED), 500)).toEqual(modes(new ChaosEngine(MIXED), 500));
  });

  it('injects different failures for a different seed', () => {
    expect(modes(new ChaosEngine(MIXED), 50)).not.toEqual(modes(new ChaosEngine({ ...MIXED, seed: 7 }), 50));
  });

  it('reseeds on replace, so replaying the same config replays the same sequence', () => {
    const engine = new ChaosEngine(MIXED);
    const first = modes(engine, 100);
    engine.replace(MIXED);
    expect(modes(engine, 100)).toEqual(first);
  });

  it('keeps latency on its own stream: turning latency on does not change which requests fail', () => {
    const withLatency = new ChaosEngine({ ...MIXED, latencyMinMs: 10, latencyMaxMs: 50 });
    expect(modes(withLatency, 500)).toEqual(modes(new ChaosEngine(MIXED), 500));
  });

  it('hits each rate within a few percent over many draws', () => {
    const counts = { reject: 0, late_apply: 0, lost_response: 0, normal: 0 };
    for (const mode of modes(new ChaosEngine(MIXED), 20_000)) counts[mode as keyof typeof counts]++;
    expect(counts.reject / 20_000).toBeCloseTo(0.1, 1);
    expect(counts.late_apply / 20_000).toBeCloseTo(0.2, 1);
    expect(counts.lost_response / 20_000).toBeCloseTo(0.3, 1);
    expect(counts.normal / 20_000).toBeCloseTo(0.4, 1);
  });

  it('draws latency uniformly within [min, max] inclusive', () => {
    const engine = new ChaosEngine({ ...QUIET, latencyMinMs: 100, latencyMaxMs: 104 });
    const seen = new Set<number>();
    for (let i = 0; i < 2000; i++) seen.add(engine.plan('money').latencyMs);
    expect([...seen].sort()).toEqual([100, 101, 102, 103, 104]);
  });

  it('reports down for every scope, with no latency, whatever the rates say', () => {
    const engine = new ChaosEngine({ ...MIXED, down: true, latencyMinMs: 50, latencyMaxMs: 60 });
    for (let i = 0; i < 50; i++) {
      expect(engine.plan('money')).toMatchObject({ down: true, latencyMs: 0 });
      expect(engine.plan('lookup')).toMatchObject({ down: true, latencyMs: 0 });
    }
  });

  it('returns a copy of its settings, not a live reference', () => {
    const engine = new ChaosEngine(QUIET);
    const settings = engine.settings;
    settings.down = true;
    expect(engine.settings.down).toBe(false);
  });
});

describe('validateChaosSettings', () => {
  const TIMEOUT = 2000;

  it('accepts the quiet default and a full mix summing to exactly 1', () => {
    expect(validateChaosSettings(QUIET, TIMEOUT)).toBeNull();
    expect(
      validateChaosSettings({ ...QUIET, rejectRate: 0.1, lateApplyRate: 0.2, lostResponseRate: 0.7 }, TIMEOUT),
    ).toBeNull();
  });

  it('rejects rates that sum above 1', () => {
    expect(
      validateChaosSettings({ ...QUIET, rejectRate: 0.5, lateApplyRate: 0.3, lostResponseRate: 0.3 }, TIMEOUT),
    ).toMatch(/must be <= 1/);
  });

  it('rejects a rate outside [0, 1] or not finite', () => {
    expect(validateChaosSettings({ ...QUIET, rejectRate: -0.1 }, TIMEOUT)).toMatch(/reject_rate/);
    expect(validateChaosSettings({ ...QUIET, lateApplyRate: 1.5 }, TIMEOUT)).toMatch(/late_apply_rate/);
    expect(validateChaosSettings({ ...QUIET, lostResponseRate: Number.NaN }, TIMEOUT)).toMatch(/lost_response_rate/);
  });

  it('rejects latency_min > latency_max', () => {
    expect(validateChaosSettings({ ...QUIET, latencyMinMs: 50, latencyMaxMs: 10 }, TIMEOUT)).toMatch(/latency_min_ms/);
  });

  it('requires slow_ms > BANK_CALL_TIMEOUT_MS only when a mode that uses it is on', () => {
    expect(validateChaosSettings({ ...QUIET, slowMs: 0 }, TIMEOUT)).toBeNull();
    expect(validateChaosSettings({ ...QUIET, lateApplyRate: 0.5, slowMs: 2000 }, TIMEOUT)).toMatch(/slow_ms/);
    expect(validateChaosSettings({ ...QUIET, lostResponseRate: 0.5, slowMs: 1500 }, TIMEOUT)).toMatch(/slow_ms/);
    expect(validateChaosSettings({ ...QUIET, lateApplyRate: 0.5, slowMs: 2001 }, TIMEOUT)).toBeNull();
  });
});
