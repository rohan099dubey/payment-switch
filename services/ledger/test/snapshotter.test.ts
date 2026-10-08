import { ConfigError, createLogger } from '@switch/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadLedgerConfig } from '../src/config';
import type { SnapshotOutcome } from '../src/repo/snapshotRepo';
import { Snapshotter } from '../src/snapshotter';

const silentLogger = createLogger('test', { level: 'silent' });

const created: SnapshotOutcome = { result: 'created', snapshotId: 7n, lastEntryId: 1234n, entriesAdded: 40n };

interface Harness {
  snapshotter: Snapshotter;
  createSnapshot: ReturnType<typeof vi.fn<() => Promise<SnapshotOutcome>>>;
  results: string[];
}

function harness(outcomes: (SnapshotOutcome | Error)[]): Harness {
  const results: string[] = [];
  let calls = 0;
  const createSnapshot = vi.fn((): Promise<SnapshotOutcome> => {
    const next = outcomes[Math.min(calls, outcomes.length - 1)];
    calls++;
    if (next === undefined) return Promise.reject(new Error('no outcome scripted'));
    if (next instanceof Error) return Promise.reject(next);
    return Promise.resolve(next);
  });
  const snapshotter = new Snapshotter({
    createSnapshot,
    logger: silentLogger,
    observe: (r) => results.push(r),
    intervalMs: 1000,
  });
  return { snapshotter, createSnapshot, results };
}

describe('Snapshotter (ADR-029)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('counts every outcome, including a failure, and keeps going after one', async () => {
    const { snapshotter, results } = harness([
      created,
      { result: 'up_to_date', lastEntryId: 1234n },
      { result: 'lock_timeout' },
      new Error('connection reset'),
      created,
    ]);
    for (let i = 0; i < 5; i++) await snapshotter.runOnce();
    expect(results).toEqual(['created', 'up_to_date', 'lock_timeout', 'failed', 'created']);
  });

  it('runs one round per interval, never two at once, and stops cleanly', async () => {
    vi.useFakeTimers();
    let release: () => void = () => undefined;
    let inFlight = 0;
    let maxInFlight = 0;
    const { snapshotter, createSnapshot } = harness([created]);
    createSnapshot.mockImplementation(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      inFlight--;
      return created;
    });

    snapshotter.start();
    expect(createSnapshot).toHaveBeenCalledTimes(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(createSnapshot).toHaveBeenCalledTimes(1);
    // The round is still running: no second round however long it takes.
    await vi.advanceTimersByTimeAsync(5000);
    expect(createSnapshot).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(1000);
    expect(createSnapshot).toHaveBeenCalledTimes(2);
    expect(maxInFlight).toBe(1);

    const stopping = snapshotter.stop();
    release();
    await stopping;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(createSnapshot).toHaveBeenCalledTimes(2);
  });
});

describe('ledger config: snapshot variables (ADR-029)', () => {
  it('defaults to a snapshot every minute with a 200 ms lock timeout', () => {
    const c = loadLedgerConfig({});
    expect(c.SNAPSHOT_INTERVAL_MS).toBe(60_000);
    expect(c.SNAPSHOT_LOCK_TIMEOUT_MS).toBe(200);
  });

  it('rejects a zero interval and a lock timeout above 5 s', () => {
    expect(() => loadLedgerConfig({ SNAPSHOT_INTERVAL_MS: '0' })).toThrow(ConfigError);
    expect(() => loadLedgerConfig({ SNAPSHOT_LOCK_TIMEOUT_MS: '5001' })).toThrow(ConfigError);
  });
});
