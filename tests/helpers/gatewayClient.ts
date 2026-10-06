/**
 * HTTP client for the Gateway, as an API client would use it: client credentials for a
 * cached token, then `createTransfer(body, key)` and `getTransfer(id)` (section 16).
 */
export const GATEWAY_URL = process.env.GATEWAY_URL ?? 'http://localhost:8080';

/** Development credentials from docker-compose.yml (never used outside the local stack). */
export const DEV_CLIENTS = {
  demo: { id: 'demo-client', secret: 'demo-secret' },
  a: { id: 'test-client-a', secret: 'test-secret-a-dev-only' },
  b: { id: 'test-client-b', secret: 'test-secret-b-dev-only' },
  rateLimit: { id: 'test-ratelimit', secret: 'test-secret-rl-dev-only' },
} as const;
export const DEV_JWT_SECRET = process.env.GATEWAY_JWT_SECRET ?? 'dev-only-jwt-secret-change-me-0123456789abcdef';

export interface HttpResult<T = Record<string, unknown>> {
  status: number;
  headers: Headers;
  body: T;
}

async function send<T>(
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: unknown,
): Promise<HttpResult<T>> {
  const res = await fetch(`${GATEWAY_URL}${path}`, {
    method,
    headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = text === '' ? null : JSON.parse(text);
  } catch {
    // Not JSON (e.g. /metrics): keep the text.
  }
  return { status: res.status, headers: res.headers, body: parsed as T };
}

export class GatewayClient {
  private token: { value: string; expiresAt: number } | undefined;

  constructor(
    readonly clientId: string,
    private readonly clientSecret: string,
  ) {}

  static for(client: { id: string; secret: string }): GatewayClient {
    return new GatewayClient(client.id, client.secret);
  }

  async accessToken(): Promise<string> {
    if (this.token !== undefined && Date.now() < this.token.expiresAt - 30_000) return this.token.value;
    const res = await send<{ access_token: string; expires_in: number }>(
      'POST',
      '/v1/auth/token',
      {},
      {
        client_id: this.clientId,
        client_secret: this.clientSecret,
      },
    );
    if (res.status !== 200) throw new Error(`token request failed with ${res.status}`);
    this.token = { value: res.body.access_token, expiresAt: Date.now() + res.body.expires_in * 1000 };
    return this.token.value;
  }

  async createTransfer(
    body: unknown,
    key: string | undefined,
    headers: Record<string, string> = {},
  ): Promise<HttpResult> {
    const auth = { authorization: `Bearer ${await this.accessToken()}` };
    return send(
      'POST',
      '/v1/transfers',
      { ...auth, ...(key === undefined ? {} : { 'idempotency-key': key }), ...headers },
      body,
    );
  }

  async getTransfer(id: string, headers: Record<string, string> = {}): Promise<HttpResult> {
    return send('GET', `/v1/transfers/${encodeURIComponent(id)}`, {
      authorization: `Bearer ${await this.accessToken()}`,
      ...headers,
    });
  }
}

export function rawRequest<T = Record<string, unknown>>(
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: unknown,
): Promise<HttpResult<T>> {
  return send<T>(method, path, headers, body);
}
