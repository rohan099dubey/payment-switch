import { TransferState } from '@switch/proto-gen/orchestrator/v1';
import { describe, expect, it } from 'vitest';
import { counterValue, grpcError, harness, KEY, Status, transfer, validBody, type Harness } from '../harness';

function withoutKey(body: Record<string, unknown>, key: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(body).filter(([k]) => k !== key));
}

interface Sent {
  status: number;
  headers: Record<string, unknown>;
  body: Record<string, unknown>;
}

async function postTransfer(
  h: Harness,
  options: { body?: unknown; key?: string | null; headers?: Record<string, string>; rawBody?: string } = {},
): Promise<Sent> {
  const token = await h.token();
  const headers: Record<string, string> = { authorization: `Bearer ${token}`, ...options.headers };
  if (options.key !== null) headers['idempotency-key'] = options.key ?? KEY;
  const res = await h.app.inject({
    method: 'POST',
    url: '/v1/transfers',
    headers: options.rawBody === undefined ? headers : { 'content-type': 'application/json', ...headers },
    ...(options.rawBody === undefined ? { payload: options.body ?? validBody() } : { payload: options.rawBody }),
  });
  return { status: res.statusCode, headers: res.headers, body: res.json() };
}

describe('POST /v1/transfers — request translation', () => {
  it('sends the Orchestrator exactly the validated body, the key and the token sub', async () => {
    const h = await harness();
    await postTransfer(h);
    expect(h.orchestrator.creates).toHaveLength(1);
    expect(h.orchestrator.creates[0]?.request).toEqual({
      clientId: 'client-a',
      idempotencyKey: KEY,
      payer: { bankId: 'bank_a', accountId: 'ACC001' },
      payee: { bankId: 'bank_b', accountId: 'ACC002' },
      amount: '12500',
      currency: 'INR',
      note: 'rent',
    });
  });

  it('an absent note is sent as ""', async () => {
    const h = await harness();
    const body = validBody();
    delete body.note;
    await postTransfer(h, { body });
    expect(h.orchestrator.creates[0]?.request.note).toBe('');
  });

  it('returns the Transfer resource exactly as section 5 shows it', async () => {
    const h = await harness();
    const res = await postTransfer(h);
    expect(res.body).toEqual({
      id: '0b6f6f0e-4a0b-4c3b-9b59-2f1f6d1a8c11',
      status: 'SUCCEEDED',
      state: 'SUCCESS',
      payer: { bank_id: 'bank_a', account_id: 'ACC001' },
      payee: { bank_id: 'bank_b', account_id: 'ACC002' },
      amount: 12500,
      currency: 'INR',
      note: 'rent',
      failure_code: null,
      failure_message: null,
      created_at: '2026-10-04T10:15:00.000Z',
      updated_at: '2026-10-04T10:15:00.412Z',
    });
  });
});

describe('POST /v1/transfers — status codes (section 5 table)', () => {
  const S = TransferState;
  it.each([
    ['SUCCESS, first', S.TRANSFER_STATE_SUCCESS, false, 201],
    ['SUCCESS, replay', S.TRANSFER_STATE_SUCCESS, true, 200],
    ['FAILED, first', S.TRANSFER_STATE_FAILED, false, 422],
    ['FAILED, replay', S.TRANSFER_STATE_FAILED, true, 422],
    ['REVERSED, first', S.TRANSFER_STATE_REVERSED, false, 422],
    ['REVERSED, replay', S.TRANSFER_STATE_REVERSED, true, 422],
    ['DEBIT_SENT, first', S.TRANSFER_STATE_DEBIT_SENT, false, 202],
    ['CREDIT_SENT, replay', S.TRANSFER_STATE_CREDIT_SENT, true, 202],
    ['REVERSING, first', S.TRANSFER_STATE_REVERSING, false, 202],
    ['NEEDS_MANUAL_REVIEW, first', S.TRANSFER_STATE_NEEDS_MANUAL_REVIEW, false, 202],
  ] as const)('%s -> %i', async (_name, state, replayed, expected) => {
    const h = await harness();
    h.orchestrator.createResult = { transfer: transfer({ state }), replayed };
    const res = await postTransfer(h);
    expect(res.status).toBe(expected);
    expect(res.headers['idempotent-replay']).toBe(replayed ? 'true' : undefined);
    expect(res.headers.location).toBe(
      expected === 202 ? '/v1/transfers/0b6f6f0e-4a0b-4c3b-9b59-2f1f6d1a8c11' : undefined,
    );
  });

  it('a business failure is 422 with failure_code and failure_message', async () => {
    const h = await harness();
    h.orchestrator.createResult = {
      transfer: transfer({
        state: S.TRANSFER_STATE_FAILED,
        failureCode: 'INSUFFICIENT_FUNDS',
        failureMessage: 'insufficient funds',
      }),
      replayed: false,
    };
    const res = await postTransfer(h);
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({
      status: 'FAILED',
      state: 'FAILED',
      failure_code: 'INSUFFICIENT_FUNDS',
      failure_message: 'insufficient funds',
    });
  });

  it.each([
    [S.TRANSFER_STATE_INITIATED, 'PENDING'],
    [S.TRANSFER_STATE_DEBITED, 'PENDING'],
    [S.TRANSFER_STATE_CREDITED, 'PENDING'],
    [S.TRANSFER_STATE_REVERSED, 'REVERSED'],
    [S.TRANSFER_STATE_NEEDS_MANUAL_REVIEW, 'UNDER_REVIEW'],
  ])('state %s has public status %s', async (state, status) => {
    const h = await harness();
    h.orchestrator.createResult = { transfer: transfer({ state }), replayed: false };
    expect((await postTransfer(h)).body.status).toBe(status);
  });
});

describe('POST /v1/transfers — Idempotency-Key', () => {
  it.each([
    ['missing', null],
    ['too short', 'short'],
    ['too long', 'k'.repeat(129)],
    ['bad character', 'key with spaces'],
    ['slash', 'key/0001/abc'],
  ])('%s -> 400 IDEMPOTENCY_KEY_REQUIRED', async (_name, key) => {
    const h = await harness();
    const res = await postTransfer(h, { key });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: { code: 'IDEMPOTENCY_KEY_REQUIRED' } });
    expect(h.orchestrator.creates).toHaveLength(0);
  });

  it.each(['abcdefgh', 'A_b.c:d-0123456789', 'k'.repeat(128), '3f2c1b4e-8a6d-4f7e-9c2b-1a0d5e6f7a8b'])(
    'accepts %s',
    async (key) => {
      const h = await harness();
      expect((await postTransfer(h, { key })).status).toBe(201);
    },
  );
});

describe('POST /v1/transfers — body validation (400 VALIDATION_ERROR, unknown fields rejected)', () => {
  it.each([
    ['unknown top-level field', validBody({ extra: 1 })],
    ['unknown nested field', validBody({ payer: { bank_id: 'bank_a', account_id: 'ACC001', name: 'x' } })],
    ['missing payee', withoutKey(validBody(), 'payee')],
    ['amount as a string', validBody({ amount: '12500' })],
    ['fractional amount', validBody({ amount: 125.5 })],
    ['amount 0', validBody({ amount: 0 })],
    ['negative amount', validBody({ amount: -1 })],
    ['amount above MAX_TRANSFER_AMOUNT', validBody({ amount: 10_000_001 })],
    ['currency USD', validBody({ currency: 'USD' })],
    ['currency lower case', validBody({ currency: 'inr' })],
    ['bank_id upper case', validBody({ payer: { bank_id: 'BANK_A', account_id: 'ACC001' } })],
    ['bank_id too long', validBody({ payer: { bank_id: 'b'.repeat(33), account_id: 'ACC001' } })],
    ['account_id with a space', validBody({ payee: { bank_id: 'bank_b', account_id: 'ACC 002' } })],
    ['account_id too long', validBody({ payee: { bank_id: 'bank_b', account_id: 'a'.repeat(65) } })],
    ['note of 141 characters', validBody({ note: 'n'.repeat(141) })],
    ['note null', validBody({ note: null })],
    ['body is an array', [validBody()]],
  ])('%s', async (_name, body) => {
    const h = await harness();
    const res = await postTransfer(h, { body });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    expect(h.orchestrator.creates).toHaveLength(0);
  });

  it('lists the zod issues in details', async () => {
    const h = await harness();
    const res = await postTransfer(h, { body: validBody({ amount: 0 }) });
    const details = (res.body.error as { details: { path: unknown[] }[] }).details;
    expect(details.some((issue) => issue.path.includes('amount'))).toBe(true);
  });

  it.each([
    ['malformed JSON', '{"payer": '],
    ['empty body', ''],
  ])('%s -> 400 VALIDATION_ERROR in the standard envelope', async (_name, rawBody) => {
    const h = await harness();
    const res = await postTransfer(h, { rawBody });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: { code: 'VALIDATION_ERROR', request_id: expect.any(String) as unknown } });
  });

  it('a non-JSON content type -> 400 VALIDATION_ERROR', async () => {
    const h = await harness();
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/transfers',
      headers: { authorization: `Bearer ${await h.token()}`, 'idempotency-key': KEY, 'content-type': 'text/plain' },
      payload: 'hello',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
  });

  it('a body over the 16 KiB limit -> 400 VALIDATION_ERROR, never reaches the Orchestrator', async () => {
    const h = await harness();
    const res = await postTransfer(h, { rawBody: JSON.stringify(validBody({ note: 'x'.repeat(20_000) })) });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    expect(h.orchestrator.creates).toHaveLength(0);
  });

  it('a 140-character note counts code points (140 emoji are accepted)', async () => {
    const h = await harness();
    expect((await postTransfer(h, { body: validBody({ note: '😀'.repeat(140) }) })).status).toBe(201);
    expect((await postTransfer(h, { body: validBody({ note: '😀'.repeat(141) }) })).status).toBe(400);
  });

  it('amount 1 and MAX_TRANSFER_AMOUNT are accepted', async () => {
    const h = await harness();
    expect((await postTransfer(h, { body: validBody({ amount: 1 }) })).status).toBe(201);
    expect((await postTransfer(h, { body: validBody({ amount: 10_000_000 }) })).status).toBe(201);
  });
});

describe('POST /v1/transfers — Orchestrator errors (section 5 mapping)', () => {
  it.each([
    ['INVALID_ARGUMENT SAME_ACCOUNT', grpcError(Status.INVALID_ARGUMENT, 'SAME_ACCOUNT'), 400, 'SAME_ACCOUNT'],
    ['INVALID_ARGUMENT UNKNOWN_BANK', grpcError(Status.INVALID_ARGUMENT, 'UNKNOWN_BANK'), 400, 'UNKNOWN_BANK'],
    ['INVALID_ARGUMENT, odd trailer', grpcError(Status.INVALID_ARGUMENT, 'not a code!'), 400, 'VALIDATION_ERROR'],
    [
      'ALREADY_EXISTS IDEMPOTENCY_KEY_REUSED',
      grpcError(Status.ALREADY_EXISTS, 'IDEMPOTENCY_KEY_REUSED'),
      409,
      'IDEMPOTENCY_KEY_REUSED',
    ],
    ['ALREADY_EXISTS, other trailer', grpcError(Status.ALREADY_EXISTS, 'SOMETHING'), 500, 'INTERNAL'],
    ['NOT_FOUND on create', grpcError(Status.NOT_FOUND, 'X'), 500, 'INTERNAL'],
    ['UNAVAILABLE', grpcError(Status.UNAVAILABLE, 'X'), 503, 'UPSTREAM_UNAVAILABLE'],
    ['DEADLINE_EXCEEDED', grpcError(Status.DEADLINE_EXCEEDED, 'X'), 504, 'UPSTREAM_TIMEOUT'],
    ['INTERNAL', grpcError(Status.INTERNAL, 'INTERNAL', 'secret stack detail'), 500, 'INTERNAL'],
    ['a non-gRPC error', new Error('socket hang up'), 500, 'INTERNAL'],
  ])('%s -> %i %s', async (_name, error, status, code) => {
    const h = await harness();
    h.orchestrator.createResult = error;
    const res = await postTransfer(h);
    expect(res.status).toBe(status);
    expect(res.body).toMatchObject({ error: { code } });
    if (status >= 500) expect(JSON.stringify(res.body)).not.toContain('secret stack detail');
  });
});

describe('GET /v1/transfers/:id', () => {
  it('returns 200 with the resource, asking with the token sub', async () => {
    const h = await harness();
    h.orchestrator.getResult = transfer({ state: TransferState.TRANSFER_STATE_DEBIT_SENT });
    const res = await h.app.inject({
      method: 'GET',
      url: '/v1/transfers/0b6f6f0e-4a0b-4c3b-9b59-2f1f6d1a8c11',
      headers: { authorization: `Bearer ${await h.token('client-b')}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      id: '0b6f6f0e-4a0b-4c3b-9b59-2f1f6d1a8c11',
      status: 'PENDING',
      state: 'DEBIT_SENT',
    });
    expect(h.orchestrator.gets[0]).toMatchObject({
      transferId: '0b6f6f0e-4a0b-4c3b-9b59-2f1f6d1a8c11',
      clientId: 'client-b',
    });
  });

  it.each([
    ['NOT_FOUND', grpcError(Status.NOT_FOUND, 'TRANSFER_NOT_FOUND'), 404, 'TRANSFER_NOT_FOUND'],
    ['UNAVAILABLE', grpcError(Status.UNAVAILABLE, 'X'), 503, 'UPSTREAM_UNAVAILABLE'],
    ['DEADLINE_EXCEEDED', grpcError(Status.DEADLINE_EXCEEDED, 'X'), 504, 'UPSTREAM_TIMEOUT'],
  ])('%s -> %i %s', async (_name, error, status, code) => {
    const h = await harness();
    h.orchestrator.getResult = error;
    const res = await h.app.inject({
      method: 'GET',
      url: '/v1/transfers/abc',
      headers: { authorization: `Bearer ${await h.token()}` },
    });
    expect(res.statusCode).toBe(status);
    expect(res.json()).toMatchObject({ error: { code } });
  });

  it('requires a token', async () => {
    const h = await harness();
    const res = await h.app.inject({ method: 'GET', url: '/v1/transfers/abc' });
    expect(res.statusCode).toBe(401);
    expect(h.orchestrator.gets).toHaveLength(0);
  });
});

describe('rate limiting (after authentication)', () => {
  it('sets X-RateLimit-Remaining on allowed requests', async () => {
    const h = await harness();
    h.limiter.next = { allowed: true, remaining: 42, retryAfterSeconds: 0 };
    const res = await postTransfer(h);
    expect(res.headers['x-ratelimit-remaining']).toBe('42');
    expect(h.limiter.calls).toEqual(['client-a']);
  });

  it('a rejection is 429 RATE_LIMITED with Retry-After, counted, and never reaches the Orchestrator', async () => {
    const h = await harness();
    h.limiter.next = { allowed: false, remaining: 0, retryAfterSeconds: 3 };
    const res = await postTransfer(h);
    expect(res.status).toBe(429);
    expect(res.body).toMatchObject({ error: { code: 'RATE_LIMITED' } });
    expect(res.headers['retry-after']).toBe('3');
    expect(res.headers['x-ratelimit-remaining']).toBe('0');
    expect(h.orchestrator.creates).toHaveLength(0);
    expect(await counterValue(h.registry, 'rate_limit_rejections_total')).toBe(1);
  });

  it('applies to GET as well', async () => {
    const h = await harness();
    h.limiter.next = { allowed: false, remaining: 0, retryAfterSeconds: 1 };
    const res = await h.app.inject({
      method: 'GET',
      url: '/v1/transfers/abc',
      headers: { authorization: `Bearer ${await h.token()}` },
    });
    expect(res.statusCode).toBe(429);
  });

  it('a limiter failure fails open: the request proceeds, rate_limit_fail_open_total increments, a warning is logged', async () => {
    const h = await harness();
    h.limiter.next = new Error("Stream isn't writeable and enableOfflineQueue options is false");
    const res = await postTransfer(h);
    expect(res.status).toBe(201);
    expect(res.headers['x-ratelimit-remaining']).toBeUndefined();
    expect(await counterValue(h.registry, 'rate_limit_fail_open_total')).toBe(1);
    expect(h.logs.some((l) => l.includes('"level":"warn"') && l.includes('failing open'))).toBe(true);
  });

  it('an unauthenticated request does not consume a token', async () => {
    const h = await harness();
    await h.app.inject({
      method: 'POST',
      url: '/v1/transfers',
      headers: { 'idempotency-key': KEY },
      payload: validBody(),
    });
    expect(h.limiter.calls).toHaveLength(0);
  });
});

describe('request id', () => {
  it('echoes a safe X-Request-Id, forwards it to the Orchestrator, and puts it in error bodies', async () => {
    const h = await harness();
    const id = '3f2c1b4e-8a6d-4f7e-9c2b-1a0d5e6f7a8b';
    const ok = await postTransfer(h, { headers: { 'x-request-id': id } });
    expect(ok.headers['x-request-id']).toBe(id);
    expect(h.orchestrator.creates[0]?.requestId).toBe(id);

    const bad = await postTransfer(h, { headers: { 'x-request-id': id }, key: null });
    expect(bad.headers['x-request-id']).toBe(id);
    expect(bad.body).toMatchObject({ error: { request_id: id } });
  });

  it('generates a UUID when absent, and replaces an unsafe value', async () => {
    const h = await harness();
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    const none = await postTransfer(h);
    expect(none.headers['x-request-id']).toMatch(uuid);
    const unsafe = await postTransfer(h, { headers: { 'x-request-id': 'evil value\n{"level":"fatal"}' } });
    expect(unsafe.headers['x-request-id']).toMatch(uuid);
  });

  it('is echoed on a 404 for an unknown route too', async () => {
    const h = await harness();
    const res = await h.app.inject({ method: 'GET', url: '/nope', headers: { 'x-request-id': 'req-404-test' } });
    expect(res.statusCode).toBe(404);
    expect(res.headers['x-request-id']).toBe('req-404-test');
    expect(res.json()).toMatchObject({ error: { code: 'NOT_FOUND', request_id: 'req-404-test' } });
  });
});

describe('logging never contains tokens, secrets or bodies', () => {
  it('after auth, a transfer and a bad request, no log line has the secret, the token or the note', async () => {
    const h = await harness();
    const token = await h.token();
    await postTransfer(h, { body: validBody({ note: 'very-private-note-text' }) });
    await h.app.inject({
      method: 'POST',
      url: '/v1/auth/token',
      payload: { client_id: 'client-a', client_secret: 'wrong-secret-xyz' },
    });
    h.orchestrator.createResult = grpcError(Status.INTERNAL, 'INTERNAL');
    await postTransfer(h, { body: validBody({ note: 'very-private-note-text' }) });

    const all = h.logs.join('\n');
    expect(h.logs.length).toBeGreaterThan(0);
    expect(all).toContain('request completed');
    for (const secret of [
      token,
      'secret-a-very-long-value',
      'wrong-secret-xyz',
      'very-private-note-text',
      'unit-test-jwt-secret',
    ]) {
      expect(all).not.toContain(secret);
    }
  });

  it('logs one line per request with route, status and client', async () => {
    const h = await harness();
    await postTransfer(h);
    const line = h.logs.map((l) => JSON.parse(l) as Record<string, unknown>).find((l) => l.route === '/v1/transfers');
    expect(line).toMatchObject({ method: 'POST', status: 201, client_id: 'client-a', msg: 'request completed' });
    expect(typeof line?.request_id).toBe('string');
  });
});
