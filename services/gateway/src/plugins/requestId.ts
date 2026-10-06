import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { FastifyInstance } from 'fastify';

export const REQUEST_ID_HEADER = 'x-request-id';

/**
 * A client-supplied `X-Request-Id` is kept only if it is a short, log-safe token (a UUID
 * always is); anything else is replaced by a fresh UUID (ADR-019), so a header can never
 * inject text into log lines or into the Orchestrator's metadata.
 */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/** Fastify `genReqId`: the request id is the client's, if safe, else a new UUID. */
export function requestIdFrom(req: IncomingMessage): string {
  const header = req.headers[REQUEST_ID_HEADER];
  return typeof header === 'string' && SAFE_REQUEST_ID.test(header) ? header : randomUUID();
}

/** Echoes the request id on every response, errors and 404s included. */
export function registerRequestId(app: FastifyInstance): void {
  app.addHook('onRequest', (request, reply, done) => {
    void reply.header(REQUEST_ID_HEADER, request.id);
    done();
  });
}
