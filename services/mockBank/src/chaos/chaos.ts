import { mulberry32 } from './prng';

/** Chaos configuration (spec section 8). Lives in memory: it is test config, not business state. */
export interface ChaosSettings {
  down: boolean;
  latencyMinMs: number;
  latencyMaxMs: number;
  rejectRate: number;
  lateApplyRate: number;
  lostResponseRate: number;
  slowMs: number;
  seed: number;
}

/**
 * Which RPCs a plan is for. `money` (Debit, Credit, ReverseDebit) honours every mode;
 * `lookup` (Resolve, GetOperation) honours only down, latency and reject_rate. Admin RPCs
 * never ask for a plan: they are exempt.
 */
export type ChaosScope = 'money' | 'lookup';

export type ChaosMode = 'normal' | 'reject' | 'late_apply' | 'lost_response';

export interface ChaosPlan {
  down: boolean;
  latencyMs: number;
  mode: ChaosMode;
  slowMs: number;
}

/** Tolerance for rates that sum to 1 in decimal but not in binary floating point (0.1 + 0.2 + 0.7). */
const RATE_SUM_EPSILON = 1e-9;

/** Returns a reason the settings are invalid, or null. */
export function validateChaosSettings(settings: ChaosSettings, bankCallTimeoutMs: number): string | null {
  const rates: [string, number][] = [
    ['reject_rate', settings.rejectRate],
    ['late_apply_rate', settings.lateApplyRate],
    ['lost_response_rate', settings.lostResponseRate],
  ];
  for (const [name, rate] of rates) {
    if (!Number.isFinite(rate) || rate < 0 || rate > 1) return `${name} must be between 0 and 1, got ${rate}`;
  }
  const sum = settings.rejectRate + settings.lateApplyRate + settings.lostResponseRate;
  if (sum > 1 + RATE_SUM_EPSILON) return `reject_rate + late_apply_rate + lost_response_rate must be <= 1, got ${sum}`;

  for (const [name, value] of [
    ['latency_min_ms', settings.latencyMinMs],
    ['latency_max_ms', settings.latencyMaxMs],
    ['slow_ms', settings.slowMs],
    ['seed', settings.seed],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) return `${name} must be a non-negative integer, got ${value}`;
  }
  if (settings.latencyMinMs > settings.latencyMaxMs) {
    return `latency_min_ms (${settings.latencyMinMs}) must be <= latency_max_ms (${settings.latencyMaxMs})`;
  }
  // A "late" apply or "lost" response is only late if the client has already timed out.
  if ((settings.lateApplyRate > 0 || settings.lostResponseRate > 0) && settings.slowMs <= bankCallTimeoutMs) {
    return `slow_ms (${settings.slowMs}) must exceed BANK_CALL_TIMEOUT_MS (${bankCallTimeoutMs}) when late_apply_rate or lost_response_rate is set`;
  }
  return null;
}

/**
 * Maps one uniform draw `u` in [0, 1) to a mode using cumulative thresholds in the order
 * reject_rate, late_apply_rate, lost_response_rate; anything above is normal.
 */
export function chooseMode(u: number, settings: ChaosSettings, scope: ChaosScope): ChaosMode {
  if (u < settings.rejectRate) return 'reject';
  if (scope === 'lookup') return 'normal';
  if (u < settings.rejectRate + settings.lateApplyRate) return 'late_apply';
  if (u < settings.rejectRate + settings.lateApplyRate + settings.lostResponseRate) return 'lost_response';
  return 'normal';
}

/**
 * Holds the current settings and two seeded PRNG streams: one for the mode (exactly one
 * draw per request that is not short-circuited by `down`) and one for latency. Keeping
 * latency on its own stream means turning latency on does not change which requests
 * fail. Replacing the settings reseeds both streams.
 */
export class ChaosEngine {
  private current: ChaosSettings;
  private modeRandom: () => number;
  private latencyRandom: () => number;

  constructor(settings: ChaosSettings) {
    this.current = { ...settings };
    this.modeRandom = mulberry32(settings.seed);
    this.latencyRandom = mulberry32((settings.seed ^ 0x9e3779b9) >>> 0);
  }

  get settings(): ChaosSettings {
    return { ...this.current };
  }

  replace(settings: ChaosSettings): void {
    this.current = { ...settings };
    this.modeRandom = mulberry32(settings.seed);
    this.latencyRandom = mulberry32((settings.seed ^ 0x9e3779b9) >>> 0);
  }

  /** Synchronous, so draws happen in request-arrival order before any await. */
  plan(scope: ChaosScope): ChaosPlan {
    const s = this.current;
    if (s.down) return { down: true, latencyMs: 0, mode: 'normal', slowMs: s.slowMs };
    const span = s.latencyMaxMs - s.latencyMinMs;
    const latencyMs = s.latencyMaxMs > 0 ? s.latencyMinMs + Math.floor(this.latencyRandom() * (span + 1)) : 0;
    const mode = chooseMode(this.modeRandom(), s, scope);
    return { down: false, latencyMs, mode, slowMs: s.slowMs };
  }
}
