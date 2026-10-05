import { backoffMs } from '@switch/common';
import type { OrchestratorConfig } from '../config';

/** Inline retry delays from `withRetry`: full jitter, base 100 ms, cap 800 ms (section 14). */
export const INLINE_RETRY_BASE_MS = 100;
export const INLINE_RETRY_MAX_MS = 800;

/**
 * An inline attempt is not started with less than this much budget left (ADR-010): a
 * call that cannot possibly finish only adds an unknown outcome. Not calling is safe,
 * because the `*_SENT` intent is already committed and recovery makes the call.
 */
export const MIN_ATTEMPT_MS = 100;

/** Timeouts, retry counts and backoff the saga runs with (spec section 14). */
export interface SagaPolicy {
  bankCallTimeoutMs: number;
  ledgerCallTimeoutMs: number;
  /** Total attempts per bank call, first included: `INLINE_BANK_RETRIES + 1`. */
  bankAttempts: number;
  /** Total attempts per ledger call, first included: `INLINE_LEDGER_RETRIES + 1`. */
  ledgerAttempts: number;
  retryBaseMs: number;
  retryMaxMs: number;
  minAttemptMs: number;
  inlineBudgetMs: number;
  leaseMs: number;
  /** Delay before recovery retries a yielded transfer, given its new `attempts` count. */
  recoveryBackoffMs: (attempts: number) => number;
}

export function policyFromConfig(config: OrchestratorConfig, random: () => number = Math.random): SagaPolicy {
  return {
    bankCallTimeoutMs: config.BANK_CALL_TIMEOUT_MS,
    ledgerCallTimeoutMs: config.LEDGER_CALL_TIMEOUT_MS,
    bankAttempts: config.INLINE_BANK_RETRIES + 1,
    ledgerAttempts: config.INLINE_LEDGER_RETRIES + 1,
    retryBaseMs: INLINE_RETRY_BASE_MS,
    retryMaxMs: INLINE_RETRY_MAX_MS,
    minAttemptMs: MIN_ATTEMPT_MS,
    inlineBudgetMs: config.SAGA_INLINE_BUDGET_MS,
    leaseMs: config.LEASE_MS,
    recoveryBackoffMs: (attempts) => backoffMs(attempts, random),
  };
}
