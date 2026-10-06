/**
 * Minimal Compose control for integration tests: stop and start one service and wait for
 * a condition. M7 extends this file with `killService` (SIGKILL) for crash recovery.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { sleep } from '@switch/common';

const run = promisify(execFile);

export async function compose(...args: string[]): Promise<string> {
  const { stdout } = await run('docker', ['compose', ...args], { timeout: 120_000 });
  return stdout;
}

export async function stopService(name: string): Promise<void> {
  await compose('stop', name);
}

export async function startService(name: string): Promise<void> {
  await compose('start', name);
}

/** Polls `check` every 250 ms until it returns true, or throws after `timeoutMs`. */
export async function waitFor(what: string, check: () => Promise<boolean>, timeoutMs = 60_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    if (await check().catch(() => false)) return;
    if (Date.now() >= until) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
    await sleep(250);
  }
}

/** Log lines a service wrote since `since` (an ISO timestamp), without the Compose prefix. */
export async function serviceLogsSince(name: string, since: string): Promise<string> {
  return compose('logs', '--no-log-prefix', '--since', since, name);
}
