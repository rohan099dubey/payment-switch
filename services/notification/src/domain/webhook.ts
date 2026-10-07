import type { TransferEvent } from './events';

/** Where an event is delivered. A real HTTP client would implement this port (ADR-026). */
export interface WebhookPort {
  /** Resolves on success; rejects with the delivery error. `attempt` starts at 1. */
  deliver: (event: TransferEvent, attempt: number) => Promise<void>;
}

/** Payee account ids that make the simulated merchant fail on every attempt. */
export const ALWAYS_FAIL_PREFIX = 'whfail-';
/** Payee account ids that make it fail the first `FLAKY_FAILURES` attempts, then succeed. */
export const FLAKY_PREFIX = 'whflaky-';
export const FLAKY_FAILURES = 2;

export interface SimulatedWebhookSettings {
  /** Probability in [0, 1] that an otherwise healthy delivery fails. */
  failureRate: number;
  seed: number;
  /** Simulated round trip, per attempt. */
  latencyMs: number;
}

/** mulberry32, as in the mock banks' chaos engine: the same seed gives the same sequence. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class WebhookError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebhookError';
  }
}

/**
 * The simulated merchant endpoint (section 19: "a simulated webhook call"). Deterministic
 * rules by payee account id let tests force failures through the public API; a seeded
 * failure rate serves chaos runs. The random draw happens on every attempt, so a given
 * seed and message order replay the same outcomes.
 */
export class SimulatedWebhook implements WebhookPort {
  private readonly random: () => number;

  constructor(
    private readonly settings: SimulatedWebhookSettings,
    private readonly sleep: (ms: number) => Promise<void>,
  ) {
    this.random = mulberry32(settings.seed);
  }

  async deliver(event: TransferEvent, attempt: number): Promise<void> {
    const draw = this.random();
    if (this.settings.latencyMs > 0) await this.sleep(this.settings.latencyMs);
    if (event.payeeAccountId.startsWith(ALWAYS_FAIL_PREFIX)) {
      throw new WebhookError('merchant endpoint returned 500 (simulated: always fails)');
    }
    if (event.payeeAccountId.startsWith(FLAKY_PREFIX) && attempt <= FLAKY_FAILURES) {
      throw new WebhookError(`merchant endpoint returned 503 (simulated: flaky, attempt ${attempt})`);
    }
    if (draw < this.settings.failureRate) {
      throw new WebhookError('merchant endpoint timed out (simulated failure rate)');
    }
  }
}
