/**
 * HTTP client for the Gateway, as an API client would use it: client credentials for a
 * cached token, then `createTransfer(body, key)` and `getTransfer(id)` (section 16).
 */
import http from 'node:http';

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

/**
 * Above the Gateway's own 10 s Orchestrator deadline, so a slow but answered request is
 * never cut off; a request with no answer at all fails instead of hanging the test.
 */
const REQUEST_TIMEOUT_MS = 20_000;
const TRANSPORT_ATTEMPTS = 3;

/**
 * A network error with no HTTP response is retried, as the README tells every API client
 * to do: it is safe by design, because a transfer is retried with the same
 * `Idempotency-Key`. On Docker Desktop for Windows, a burst of new connections to a
 * published port occasionally never reaches the container: in one run, 445 of 450
 * requests arrived at the Gateway (ADR-021, 2026-10-07 amendment). Every HTTP response,
 * 4xx or 5xx, is returned as is and never retried here.
 */
async function send<T>(
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: unknown,
): Promise<HttpResult<T>> {
  let res: Response | undefined;
  for (let attempt = 1; res === undefined; attempt++) {
    try {
      res = await fetch(`${GATEWAY_URL}${path}`, {
        method,
        headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers },
        ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      if (attempt >= TRANSPORT_ATTEMPTS) throw err;
      const reason = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      process.stderr.write(`gateway ${method} ${path}: no HTTP response (${reason}); retry ${attempt} of 2\n`);
    }
  }
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

  /**
   * `count` authenticated requests at once, over at most `connections` keep-alive
   * connections, with no body and no retry (a lost request fails the caller's test). A
   * burst test needs its requests to reach the Gateway faster than the bucket refills, so
   * it uses the cheapest request the limiter sees and keeps connection setup out of the
   * way: one new connection per request makes the arrival rate depend on Docker's
   * published-port proxy (ADR-019, amendment 2).
   */
  async burstOverPool(method: string, path: string, count: number, connections: number): Promise<HttpResult[]> {
    const authorization = `Bearer ${await this.accessToken()}`;
    const agent = new http.Agent({ keepAlive: true, maxSockets: connections });
    const url = new URL(GATEWAY_URL);
    const one = (): Promise<HttpResult> =>
      new Promise((resolve, reject) => {
        const req = http.request(
          {
            agent,
            host: url.hostname,
            port: url.port,
            method,
            path,
            headers: { authorization },
            timeout: REQUEST_TIMEOUT_MS,
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (chunk: Buffer) => chunks.push(chunk));
            res.on('end', () => {
              const headers = new Headers();
              for (const [name, value] of Object.entries(res.headers)) {
                if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
              }
              const text = Buffer.concat(chunks).toString('utf8');
              resolve({
                status: res.statusCode ?? 0,
                headers,
                body: (text === '' ? null : JSON.parse(text)) as Record<string, unknown>,
              });
            });
            res.on('error', reject);
          },
        );
        req.on('timeout', () => req.destroy(new Error(`no response within ${REQUEST_TIMEOUT_MS} ms`)));
        req.on('error', reject);
        req.end();
      });
    try {
      return await Promise.all(Array.from({ length: count }, one));
    } finally {
      agent.destroy();
    }
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
