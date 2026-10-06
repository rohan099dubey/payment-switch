/**
 * Compose control for integration and chaos tests (section 16): stop, SIGKILL and start
 * one service, wait for a condition, read logs.
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

/** `docker compose kill`: SIGKILL, no graceful shutdown. A crash, not a stop. */
export async function killService(name: string): Promise<void> {
  await compose('kill', name);
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

/** Waits until an HTTP readiness endpoint answers 200 (e.g. the Gateway's /readyz). */
export async function waitReady(url: string, timeoutMs = 60_000): Promise<void> {
  await waitFor(`${url} ready`, async () => (await fetch(url)).ok, timeoutMs);
}
