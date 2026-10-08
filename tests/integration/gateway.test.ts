/**
 * M4 acceptance, operational behaviour of the Gateway against the real stack: the Redis
 * token bucket (429 + Retry-After), failing open when Redis is down (ADR-006), `/readyz`,
 * metrics, and no secrets in log lines.
 *
 * Stops and restarts `redis` and `orchestrator` through docker compose, and always
 * restores them. Integration files run one at a time, so no other file sees the outage.
 */
import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { BankAdmin } from '../helpers/bankAdmin';
import { DEV_CLIENTS, GatewayClient, rawRequest } from '../helpers/gatewayClient';
import { serviceLogsSince, startService, stopService, waitFor } from '../helpers/stack';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
const RUN = randomUUID().slice(0, 8);
let counter = 0;
const newKey = (): string => `m4g-${RUN}-key-${++counter}`;
const banks = new BankAdmin();

afterAll(async () => {
  // Whatever happened above, leave the stack up.
  await startService('redis');
  await startService('orchestrator');
  await waitFor('gateway ready', async () => (await rawRequest('GET', '/readyz')).status === 200, 90_000);
  banks.close();
});

async function metric(name: string): Promise<number> {
  const res = await rawRequest<string>('GET', '/metrics');
  const line = res.body.split('\n').find((l) => l.startsWith(`${name} `));
  return line === undefined ? 0 : Number(line.split(' ')[1]);
}

const ready = async (): Promise<number> => (await rawRequest('GET', '/readyz')).status;

describe('the token bucket script in Redis (tokenBucket.lua)', () => {
  it('allows a burst, then denies with a retry-after, and refills at the configured rate', async () => {
    const redis = new Redis(REDIS_URL);
    try {
      const lua = readFileSync(path.resolve(__dirname, '../../services/gateway/src/lua/tokenBucket.lua'), 'utf8');
      const key = `rl:m4-script-test-${RUN}`;
      const take = async (): Promise<number[]> => (await redis.eval(lua, 1, key, 2, 3)) as number[];
      // rate 2/s, burst 3: three immediate takes succeed, the fourth is denied.
      expect((await take())[0]).toBe(1);
      expect((await take())[0]).toBe(1);
      expect(await take()).toEqual([1, 0, 0]);
      const denied = await take();
      expect(denied[0]).toBe(0);
      expect(denied[2]).toBeGreaterThan(0);
      expect(denied[2]).toBeLessThanOrEqual(500);
      await new Promise((r) => setTimeout(r, 600));
      expect((await take())[0]).toBe(1);
      // The bucket expires once it would be full again (burst / rate + 1 s).
      expect(await redis.pttl(key)).toBeLessThanOrEqual(2500);
      expect(await redis.pttl(key)).toBeGreaterThan(0);
    } finally {
      redis.disconnect();
    }
  });
});

describe('rate limiting through the Gateway', () => {
  it(
    'beyond the burst, requests get 429 RATE_LIMITED with Retry-After and X-RateLimit-Remaining: 0',
    { timeout: 90_000 },
    async () => {
      const client = GatewayClient.for(DEV_CLIENTS.rateLimit);
      await client.accessToken();
      const before = await metric('rate_limit_rejections_total');
      const failOpenBefore = await metric('rate_limit_fail_open_total');

      const started = Date.now();
      // 450 requests over 16 keep-alive connections: they arrive as fast as the Gateway
      // answers, not as fast as Docker accepts new connections (ADR-019, amendment 2).
      const results = await client.getTransfersOverPool(
        Array.from({ length: 450 }, () => randomUUID()),
        16,
      );
      const elapsedS = (Date.now() - started) / 1000;

      const limited = results.filter((r) => r.status === 429);
      const passed = results.filter((r) => r.status === 404);
      expect(limited.length + passed.length).toBe(results.length);
      expect(limited.length).toBeGreaterThan(0);
      // burst 200 plus 100/s refill while the calls ran, plus a little slack.
      expect(passed.length).toBeLessThanOrEqual(200 + Math.ceil(100 * elapsedS) + 5);
      for (const r of limited) {
        expect(r.body).toMatchObject({ error: { code: 'RATE_LIMITED' } });
        expect(Number(r.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
        expect(r.headers.get('x-ratelimit-remaining')).toBe('0');
      }
      for (const r of passed) expect(r.headers.get('x-ratelimit-remaining')).toMatch(/^\d+$/);
      expect(await metric('rate_limit_rejections_total')).toBe(before + limited.length);
      // Redis is healthy, so a burst must never be let through by the fail-open path
      // (ADR-019 amendment: a too-short command timeout once did exactly that on CI).
      expect(await metric('rate_limit_fail_open_total')).toBe(failOpenBefore);
    },
  );

  it('buckets are per client: another client is unaffected', async () => {
    const res = await GatewayClient.for(DEV_CLIENTS.demo).getTransfer(randomUUID());
    expect(res.status).toBe(404);
  });
});

describe('a Redis outage fails open (ADR-006)', () => {
  it('transfers still succeed, rate_limit_fail_open_total increments, a warning is logged, /readyz is 503', async () => {
    const payer = `m4g-${RUN}-payer`;
    const payee = `m4g-${RUN}-payee`;
    await banks.createAccount('bank_a', payer, 100_000n);
    await banks.createAccount('bank_b', payee, 0n);
    const client = GatewayClient.for(DEV_CLIENTS.a);
    await client.accessToken();
    const before = await metric('rate_limit_fail_open_total');
    const since = new Date().toISOString();

    await stopService('redis');
    try {
      await waitFor('readyz 503', async () => (await ready()) === 503, 15_000);
      const res = await client.createTransfer(
        {
          payer: { bank_id: 'bank_a', account_id: payer },
          payee: { bank_id: 'bank_b', account_id: payee },
          amount: 1000,
          currency: 'INR',
        },
        newKey(),
      );
      expect(res.status).toBe(201);
      expect(res.headers.get('x-ratelimit-remaining')).toBeNull();
      const get = await client.getTransfer(res.body.id as string);
      expect(get.status).toBe(200);
      expect(await metric('rate_limit_fail_open_total')).toBeGreaterThanOrEqual(before + 2);
      const logs = await serviceLogsSince('gateway', since);
      expect(logs).toMatch(/"level":"warn".*failing open/);
    } finally {
      await startService('redis');
    }
    await waitFor('readyz 200 after Redis returns', async () => (await ready()) === 200, 30_000);
    expect(await banks.balance('bank_b', payee)).toBe(1000n);
  });
});

describe('/healthz and /readyz', () => {
  it('/healthz is 200 and /readyz is 200 with everything up', async () => {
    expect((await rawRequest('GET', '/healthz')).status).toBe(200);
    expect(await ready()).toBe(200);
  });

  it('/readyz is 503 while the Orchestrator is down (calls get 503 or 504, never 500), 200 again after', async () => {
    const client = GatewayClient.for(DEV_CLIENTS.demo);
    await client.accessToken();
    await stopService('orchestrator');
    try {
      await waitFor('readyz 503', async () => (await ready()) === 503, 15_000);
      expect((await rawRequest('GET', '/healthz')).status).toBe(200);
      // Which status grpc-js reports depends on the channel's state: with the container gone
      // its DNS name stops resolving, so the call usually waits out its 3 s deadline (504)
      // rather than failing fast (503). Both mean "retry with the same key" (section 5).
      const res = await client.getTransfer(randomUUID());
      const expected: Record<number, string> = { 503: 'UPSTREAM_UNAVAILABLE', 504: 'UPSTREAM_TIMEOUT' };
      expect(Object.keys(expected)).toContain(String(res.status));
      expect(res.body).toMatchObject({ error: { code: expected[res.status] } });
    } finally {
      await startService('orchestrator');
    }
    await waitFor('readyz 200 after the Orchestrator returns', async () => (await ready()) === 200, 60_000);
  });
});

describe('metrics and logs', () => {
  it('exposes the section 17 Gateway metrics with route templates', async () => {
    const body = (await rawRequest<string>('GET', '/metrics')).body;
    expect(body).toMatch(/^http_requests_total\{method="POST",route="\/v1\/transfers",status="201"\} \d+/m);
    expect(body).toMatch(/^http_requests_total\{method="GET",route="\/v1\/transfers\/:id",status="429"\} \d+/m);
    expect(body).toMatch(/^http_request_duration_seconds_count\{method="POST",route="\/v1\/auth\/token"\} \d+/m);
    expect(body).toMatch(/^rate_limit_rejections_total \d+/m);
    expect(body).toMatch(/^rate_limit_fail_open_total \d+/m);
  });

  it('no token, client secret or request body ever appears in the Gateway log', async () => {
    const since = new Date(Date.now() - 1000).toISOString();
    const client = GatewayClient.for(DEV_CLIENTS.b);
    const token = await client.accessToken();
    const note = `private-note-${RUN}`;
    await client.createTransfer(
      {
        payer: { bank_id: 'bank_a', account_id: 'NOPE1' },
        payee: { bank_id: 'bank_b', account_id: 'NOPE2' },
        amount: 5,
        currency: 'INR',
        note,
      },
      newKey(),
    );
    await client.createTransfer({ bogus: note }, newKey());
    await rawRequest('POST', '/v1/auth/token', {}, { client_id: DEV_CLIENTS.b.id, client_secret: `wrong-${RUN}` });

    const logs = await serviceLogsSince('gateway', since);
    expect(logs).toContain('request completed');
    for (const secret of [token, DEV_CLIENTS.b.secret, `wrong-${RUN}`, note, 'dev-only-jwt-secret']) {
      expect(logs).not.toContain(secret);
    }
  });
});
