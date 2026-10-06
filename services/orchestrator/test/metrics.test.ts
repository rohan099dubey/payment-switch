import { Registry } from 'prom-client';
import { describe, expect, it } from 'vitest';
import { NON_TERMINAL_STATES, TransferState } from '../src/domain/states';
import { createOrchestratorMetrics, recoveryObserver, sagaObserver } from '../src/metrics';
import { makeTransfer } from './domain/fakes';

function scrape(): { text: () => Promise<string>; metrics: ReturnType<typeof createOrchestratorMetrics> } {
  const registry = new Registry();
  const metrics = createOrchestratorMetrics(registry);
  return { metrics, text: () => registry.metrics() };
}

describe('orchestrator metrics (section 17)', () => {
  it('a manual review increments manual_review_total{reason} and transfers_total{final_state}', async () => {
    const { metrics, text } = scrape();
    const observer = sagaObserver(metrics);
    observer.terminal(
      makeTransfer({ state: TransferState.NEEDS_MANUAL_REVIEW, failureCode: 'RECOVERY_EXHAUSTED' }),
      42,
    );
    observer.terminal(makeTransfer({ state: TransferState.SUCCESS }), 0.2);
    const body = await text();
    expect(body).toMatch(/^manual_review_total\{reason="RECOVERY_EXHAUSTED"\} 1$/m);
    expect(body).toMatch(/^transfers_total\{final_state="NEEDS_MANUAL_REVIEW"\} 1$/m);
    expect(body).toMatch(/^transfers_total\{final_state="SUCCESS"\} 1$/m);
    expect(body).toMatch(/^transfer_duration_seconds_count\{final_state="SUCCESS"\} 1$/m);
    // Only the manual review counts as one: a SUCCESS never touches manual_review_total.
    expect(body.match(/^manual_review_total\{/gm)).toHaveLength(1);
  });

  it('recovery_runs_total{result} and transfers_in_flight{state} come from the recovery observer', async () => {
    const { metrics, text } = scrape();
    const observer = recoveryObserver(metrics);
    observer.run('resolved_voided');
    observer.run('resolved_voided');
    observer.run('exhausted');
    observer.inFlight(new Map(NON_TERMINAL_STATES.map((s) => [s, s === TransferState.DEBIT_SENT ? 3 : 0])));
    const body = await text();
    expect(body).toMatch(/^recovery_runs_total\{result="resolved_voided"\} 2$/m);
    expect(body).toMatch(/^recovery_runs_total\{result="exhausted"\} 1$/m);
    expect(body).toMatch(/^transfers_in_flight\{state="DEBIT_SENT"\} 3$/m);
    expect(body).toMatch(/^transfers_in_flight\{state="REVERSING"\} 0$/m);

    // A state that empties drops back to 0.
    observer.inFlight(new Map(NON_TERMINAL_STATES.map((s) => [s, 0])));
    expect(await text()).toMatch(/^transfers_in_flight\{state="DEBIT_SENT"\} 0$/m);
  });
});
