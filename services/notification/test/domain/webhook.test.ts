import { describe, expect, it } from 'vitest';
import type { TransferEvent } from '../../src/domain/events';
import { FLAKY_FAILURES, mulberry32, SimulatedWebhook } from '../../src/domain/webhook';

const event = (payeeAccountId: string): TransferEvent => ({
  eventId: '1',
  eventType: 'transfer.succeeded',
  transferId: '3826712e-725b-44ea-a8cf-5f41a346c6b2',
  payeeAccountId,
  raw: '{}',
});

const noSleep = (): Promise<void> => Promise.resolve();

describe('SimulatedWebhook (ADR-026)', () => {
  it('succeeds for an ordinary payee when the failure rate is 0', async () => {
    const hook = new SimulatedWebhook({ failureRate: 0, seed: 42, latencyMs: 0 }, noSleep);
    for (let attempt = 1; attempt <= 5; attempt++)
      await expect(hook.deliver(event('ACC002'), attempt)).resolves.toBeUndefined();
  });

  it('whfail- payees fail on every attempt', async () => {
    const hook = new SimulatedWebhook({ failureRate: 0, seed: 42, latencyMs: 0 }, noSleep);
    for (let attempt = 1; attempt <= 5; attempt++)
      await expect(hook.deliver(event('whfail-x'), attempt)).rejects.toThrow('500');
  });

  it(`whflaky- payees fail the first ${FLAKY_FAILURES} attempts, then succeed`, async () => {
    const hook = new SimulatedWebhook({ failureRate: 0, seed: 42, latencyMs: 0 }, noSleep);
    await expect(hook.deliver(event('whflaky-x'), 1)).rejects.toThrow('503');
    await expect(hook.deliver(event('whflaky-x'), 2)).rejects.toThrow('503');
    await expect(hook.deliver(event('whflaky-x'), 3)).resolves.toBeUndefined();
  });

  it('a failure rate of 1 fails everything; the same seed gives the same sequence', async () => {
    const always = new SimulatedWebhook({ failureRate: 1, seed: 7, latencyMs: 0 }, noSleep);
    await expect(always.deliver(event('ACC002'), 1)).rejects.toThrow('failure rate');
    const a = mulberry32(99);
    const b = mulberry32(99);
    const seqA = Array.from({ length: 5 }, a);
    expect(Array.from({ length: 5 }, b)).toEqual(seqA);
    for (const x of seqA) expect(x >= 0 && x < 1).toBe(true);
  });

  it('waits the configured latency per attempt', async () => {
    const waits: number[] = [];
    const hook = new SimulatedWebhook({ failureRate: 0, seed: 1, latencyMs: 25 }, (ms) => {
      waits.push(ms);
      return Promise.resolve();
    });
    await hook.deliver(event('ACC002'), 1);
    expect(waits).toEqual([25]);
  });
});
