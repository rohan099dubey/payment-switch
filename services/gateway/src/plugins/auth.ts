import { createHash, timingSafeEqual } from 'node:crypto';
import fastifyJwt from '@fastify/jwt';
import type { FastifyInstance, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import type { ApiClient } from '../config';
import { ApiError } from './errorHandler';

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: { sub: string };
    user: { sub: string; iat: number; exp: number };
  }
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by `authenticate` from the token's `sub`. Never from the body or a header. */
    clientId?: string;
  }
}

const digest = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest();

/**
 * Constant-time secret comparison (section 5: `crypto.timingSafeEqual`). Both sides are
 * hashed first so the buffers always have equal length: comparing raw secrets would
 * throw on a length mismatch and leak the length through timing.
 */
export function secretMatches(given: string, expected: string): boolean {
  return timingSafeEqual(digest(given), digest(expected));
}

/** Compared against when the client id is unknown, so both paths cost the same. */
const DUMMY_SECRET = 'unknown-client-dummy-secret-for-constant-time';

export class ClientRegistry {
  private readonly byId: ReadonlyMap<string, string>;

  constructor(clients: readonly ApiClient[]) {
    this.byId = new Map(clients.map((c) => [c.clientId, c.clientSecret]));
  }

  has(clientId: string): boolean {
    return this.byId.has(clientId);
  }

  /** True only for a known client with the right secret. Constant time in the secret. */
  verify(clientId: string, clientSecret: string): boolean {
    const expected = this.byId.get(clientId);
    const matches = secretMatches(clientSecret, expected ?? DUMMY_SECRET);
    return expected !== undefined && matches;
  }
}

export interface AuthOptions {
  secret: string;
  ttlSeconds: number;
  clients: ClientRegistry;
}

const unauthenticated = (message: string): ApiError =>
  new ApiError(401, 'UNAUTHENTICATED', message, undefined, { 'www-authenticate': 'Bearer' });

/**
 * HS256 JWTs signed with `JWT_SECRET`, claims `sub`, `iat`, `exp` (section 5). Verification
 * accepts HS256 only, and a token whose `sub` is no longer in `API_CLIENTS` is refused.
 */
export async function registerAuth(app: FastifyInstance, options: AuthOptions): Promise<void> {
  await app.register(fastifyJwt, {
    secret: options.secret,
    // A numeric expiresIn is seconds here (pinned by a unit test: exp = iat + JWT_TTL_SECONDS).
    sign: { algorithm: 'HS256', expiresIn: options.ttlSeconds },
    verify: { algorithms: ['HS256'] },
  });
}

/** `preHandler` for every `/v1/transfers` route: a valid bearer token, or 401. */
export function authenticate(clients: ClientRegistry): preHandlerAsyncHookHandler {
  return async function (this: FastifyInstance, request: FastifyRequest): Promise<void> {
    let sub: unknown;
    try {
      const user = await request.jwtVerify<{ sub: string; iat: number; exp: number }>();
      sub = user.sub;
    } catch {
      throw unauthenticated('a valid bearer token is required');
    }
    if (typeof sub !== 'string' || !clients.has(sub)) throw unauthenticated('a valid bearer token is required');
    request.clientId = sub;
  };
}

export { unauthenticated };
