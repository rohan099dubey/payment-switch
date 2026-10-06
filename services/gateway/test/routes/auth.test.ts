import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ClientRegistry, secretMatches } from '../../src/plugins/auth';
import { CLIENTS, harness, JWT_SECRET, KEY, validBody } from '../harness';

const b64 = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');

/** Hand-built JWT, so tests control the header, claims and key exactly. */
function jwt(payload: Record<string, unknown>, options: { secret?: string; alg?: string } = {}): string {
  const alg = options.alg ?? 'HS256';
  const head = `${b64({ alg, typ: 'JWT' })}.${b64(payload)}`;
  if (alg === 'none') return `${head}.`;
  return `${head}.${createHmac('sha256', options.secret ?? JWT_SECRET)
    .update(head)
    .digest('base64url')}`;
}

const now = (): number => Math.floor(Date.now() / 1000);

function decode(token: string): { header: Record<string, unknown>; payload: Record<string, unknown> } {
  const [h, p] = token.split('.');
  return {
    header: JSON.parse(Buffer.from(h ?? '', 'base64url').toString()) as Record<string, unknown>,
    payload: JSON.parse(Buffer.from(p ?? '', 'base64url').toString()) as Record<string, unknown>,
  };
}

describe('secretMatches / ClientRegistry (crypto.timingSafeEqual)', () => {
  it('compares secrets of any length without throwing', () => {
    expect(secretMatches('abc', 'abc')).toBe(true);
    expect(secretMatches('abc', 'abcd')).toBe(false);
    expect(secretMatches('', 'x'.repeat(1000))).toBe(false);
  });

  it('verifies only a known client with its own secret', () => {
    const registry = new ClientRegistry(CLIENTS);
    expect(registry.verify('client-a', 'secret-a-very-long-value')).toBe(true);
    expect(registry.verify('client-a', 'secret-b-very-long-value')).toBe(false);
    expect(registry.verify('nobody', 'secret-a-very-long-value')).toBe(false);
    expect(registry.verify('nobody', 'unknown-client-dummy-secret-for-constant-time')).toBe(false);
  });
});

describe('POST /v1/auth/token', () => {
  it('issues an HS256 JWT with sub, iat and exp = iat + JWT_TTL_SECONDS', async () => {
    const { app } = await harness();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/token',
      payload: { client_id: 'client-a', client_secret: 'secret-a-very-long-value' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ access_token: string; token_type: string; expires_in: number }>();
    expect(body.token_type).toBe('Bearer');
    expect(body.expires_in).toBe(900);
    const { header, payload } = decode(body.access_token);
    expect(header.alg).toBe('HS256');
    expect(payload.sub).toBe('client-a');
    expect(typeof payload.iat).toBe('number');
    expect(payload.exp).toBe((payload.iat as number) + 900);
  });

  it.each([
    ['wrong secret', { client_id: 'client-a', client_secret: 'secret-b-very-long-value' }],
    ['unknown client', { client_id: 'mallory', client_secret: 'secret-a-very-long-value' }],
  ])('%s -> 401 UNAUTHENTICATED', async (_name, payload) => {
    const { app } = await harness();
    const res = await app.inject({ method: 'POST', url: '/v1/auth/token', payload });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: { code: 'UNAUTHENTICATED' } });
    expect(res.json<{ access_token?: string }>().access_token).toBeUndefined();
  });

  it.each([
    ['missing secret', { client_id: 'client-a' }],
    ['extra field', { client_id: 'client-a', client_secret: 'x', scope: 'admin' }],
    ['not an object', [1, 2]],
  ])('%s -> 400 VALIDATION_ERROR', async (_name, payload) => {
    const { app } = await harness();
    const res = await app.inject({ method: 'POST', url: '/v1/auth/token', payload });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
  });
});

describe('bearer authentication on /v1/transfers', () => {
  const post = async (
    authorization: string | undefined,
  ): Promise<{ status: number; body: unknown; www: unknown; creates: number }> => {
    const h = await harness();
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/transfers',
      headers: { 'idempotency-key': KEY, ...(authorization === undefined ? {} : { authorization }) },
      payload: validBody(),
    });
    return {
      status: res.statusCode,
      body: res.json(),
      www: res.headers['www-authenticate'],
      creates: h.orchestrator.creates.length,
    };
  };

  it.each([
    ['no Authorization header', undefined],
    ['not a bearer token', 'Basic Y2xpZW50LWE6c2VjcmV0'],
    ['garbage token', 'Bearer not.a.jwt'],
    [
      'wrong signing key',
      `Bearer ${jwt({ sub: 'client-a', iat: now(), exp: now() + 60 }, { secret: 'another-secret-another-secret-123' })}`,
    ],
    ['expired token', `Bearer ${jwt({ sub: 'client-a', iat: now() - 1000, exp: now() - 100 })}`],
    ['alg none', `Bearer ${jwt({ sub: 'client-a', iat: now(), exp: now() + 60 }, { alg: 'none' })}`],
    ['HS512 instead of HS256', `Bearer ${jwt({ sub: 'client-a', iat: now(), exp: now() + 60 }, { alg: 'HS512' })}`],
    ['sub no longer in API_CLIENTS', `Bearer ${jwt({ sub: 'removed-client', iat: now(), exp: now() + 60 })}`],
    ['no sub claim', `Bearer ${jwt({ iat: now(), exp: now() + 60 })}`],
  ])('%s -> 401 UNAUTHENTICATED and the Orchestrator is never called', async (_name, authorization) => {
    const r = await post(authorization);
    expect(r.status).toBe(401);
    expect(r.body).toMatchObject({ error: { code: 'UNAUTHENTICATED' } });
    expect(r.www).toBe('Bearer');
    expect(r.creates).toBe(0);
  });

  it('a hand-built valid token is accepted (the negative cases above are not vacuous)', async () => {
    const r = await post(`Bearer ${jwt({ sub: 'client-a', iat: now(), exp: now() + 60 })}`);
    expect(r.status).toBe(201);
  });

  it('client_id comes from the token sub, never from a header', async () => {
    const h = await harness();
    const token = await h.token('client-b');
    await h.app.inject({
      method: 'POST',
      url: '/v1/transfers',
      headers: {
        authorization: `Bearer ${token}`,
        'idempotency-key': KEY,
        'x-client-id': 'client-a',
        client_id: 'client-a',
      },
      payload: validBody(),
    });
    expect(h.orchestrator.creates[0]?.request.clientId).toBe('client-b');
  });

  it('client_id in the body is an unknown field and is rejected', async () => {
    const h = await harness();
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/transfers',
      headers: { authorization: `Bearer ${await h.token()}`, 'idempotency-key': KEY },
      payload: validBody({ client_id: 'client-b' }),
    });
    expect(res.statusCode).toBe(400);
    expect(h.orchestrator.creates).toHaveLength(0);
  });
});
