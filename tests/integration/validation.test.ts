/**
 * M4 acceptance, section 16 `validation`: missing Idempotency-Key, malformed body, same
 * payer and payee, unknown bank, amount above the maximum, missing or expired token.
 * Every rejection uses the standard error envelope and registers nothing.
 */
import { createHmac, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEV_CLIENTS, DEV_JWT_SECRET, GatewayClient, rawRequest, type HttpResult } from '../helpers/gatewayClient';

const ORCH_DB = process.env.ORCHESTRATOR_DATABASE_URL ?? 'postgres://orch:orch@localhost:5433/orchestrator_db';
const RUN = randomUUID().slice(0, 8);
let counter = 0;
const newKey = (): string => `m4v-${RUN}-key-${++counter}`;
const client = GatewayClient.for(DEV_CLIENTS.a);
let db: Pool;

beforeAll(() => {
  db = new Pool({ connectionString: ORCH_DB, max: 2 });
});
afterAll(async () => {
  await db.end();
});

const valid = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  payer: { bank_id: 'bank_a', account_id: 'ACC001' },
  payee: { bank_id: 'bank_b', account_id: 'ACC002' },
  amount: 12_500,
  currency: 'INR',
  ...overrides,
});

async function registered(key: string): Promise<number> {
  const res = await db.query('SELECT 1 FROM transfers WHERE client_id = $1 AND idempotency_key = $2', [
    DEV_CLIENTS.a.id,
    key,
  ]);
  return res.rowCount ?? 0;
}

function expectError(res: HttpResult, status: number, code: string): void {
  expect(res.status).toBe(status);
  expect(res.body).toMatchObject({ error: { code, message: expect.any(String) as unknown } });
  const error = (res.body as { error: { request_id: string } }).error;
  expect(error.request_id).toBe(res.headers.get('x-request-id'));
}

const b64 = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
function signedToken(payload: Record<string, unknown>): string {
  const head = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(payload)}`;
  return `${head}.${createHmac('sha256', DEV_JWT_SECRET).update(head).digest('base64url')}`;
}
const now = (): number => Math.floor(Date.now() / 1000);

describe('validation — Idempotency-Key', () => {
  it('missing -> 400 IDEMPOTENCY_KEY_REQUIRED', async () => {
    expectError(await client.createTransfer(valid(), undefined), 400, 'IDEMPOTENCY_KEY_REQUIRED');
  });

  it('malformed (too short) -> 400 IDEMPOTENCY_KEY_REQUIRED, nothing registered', async () => {
    // Unique per run, so a row left by an earlier (buggy) run can never make this pass or fail.
    const shortKey = RUN.slice(0, 7);
    expectError(await client.createTransfer(valid(), shortKey), 400, 'IDEMPOTENCY_KEY_REQUIRED');
    expect(await registered(shortKey)).toBe(0);
  });
});

describe('validation — body (400 VALIDATION_ERROR, zod details)', () => {
  it.each([
    ['unknown field', valid({ client_id: 'test-client-b' })],
    ['amount above MAX_TRANSFER_AMOUNT', valid({ amount: 10_000_001 })],
    ['fractional amount', valid({ amount: 1.5 })],
    ['currency USD', valid({ currency: 'USD' })],
    ['note over 140 characters', valid({ note: 'x'.repeat(141) })],
    ['missing payer', { payee: { bank_id: 'bank_b', account_id: 'ACC002' }, amount: 1, currency: 'INR' }],
  ])('%s', async (_name, body) => {
    const key = newKey();
    const res = await client.createTransfer(body, key);
    expectError(res, 400, 'VALIDATION_ERROR');
    expect(Array.isArray((res.body as { error: { details: unknown } }).error.details)).toBe(true);
    expect(await registered(key)).toBe(0);
  });

  it('malformed JSON -> 400 VALIDATION_ERROR', async () => {
    expectError(await client.createTransfer('{"payer":', newKey()), 400, 'VALIDATION_ERROR');
  });
});

describe('validation — decided by the Orchestrator, mapped by the Gateway', () => {
  it('same payer and payee -> 400 SAME_ACCOUNT', async () => {
    const key = newKey();
    const res = await client.createTransfer(valid({ payee: { bank_id: 'bank_a', account_id: 'ACC001' } }), key);
    expectError(res, 400, 'SAME_ACCOUNT');
    expect(await registered(key)).toBe(0);
  });

  it('unknown bank -> 400 UNKNOWN_BANK', async () => {
    const key = newKey();
    expectError(
      await client.createTransfer(valid({ payee: { bank_id: 'bank_z', account_id: 'X1' } }), key),
      400,
      'UNKNOWN_BANK',
    );
    expect(await registered(key)).toBe(0);
  });
});

describe('validation — authentication', () => {
  const post = (authorization?: string): Promise<HttpResult> =>
    rawRequest(
      'POST',
      '/v1/transfers',
      { 'idempotency-key': newKey(), ...(authorization === undefined ? {} : { authorization }) },
      valid(),
    );

  it('missing token -> 401 UNAUTHENTICATED with WWW-Authenticate', async () => {
    const res = await post();
    expectError(res, 401, 'UNAUTHENTICATED');
    expect(res.headers.get('www-authenticate')).toBe('Bearer');
  });

  it('expired token -> 401 UNAUTHENTICATED', async () => {
    const token = signedToken({ sub: DEV_CLIENTS.a.id, iat: now() - 2000, exp: now() - 1000 });
    expectError(await post(`Bearer ${token}`), 401, 'UNAUTHENTICATED');
  });

  it('a fresh token signed the same way is accepted (so the expired case is not vacuous)', async () => {
    const token = signedToken({ sub: DEV_CLIENTS.a.id, iat: now(), exp: now() + 60 });
    const res = await rawRequest('GET', `/v1/transfers/${randomUUID()}`, { authorization: `Bearer ${token}` });
    expect(res.status).toBe(404);
  });

  it('bad client credentials -> 401 UNAUTHENTICATED, no token', async () => {
    const res = await rawRequest('POST', '/v1/auth/token', {}, { client_id: DEV_CLIENTS.a.id, client_secret: 'wrong' });
    expectError(res, 401, 'UNAUTHENTICATED');
  });

  it('GET without a token -> 401', async () => {
    expectError(await rawRequest('GET', `/v1/transfers/${randomUUID()}`), 401, 'UNAUTHENTICATED');
  });
});
