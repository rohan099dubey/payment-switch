import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/** An error the Gateway answers with: HTTP status, upper-case `code`, safe message. */
export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
    readonly headers: Readonly<Record<string, string>> = {},
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface ErrorBody {
  error: { code: string; message: string; request_id: string; details?: unknown };
}

export function errorBody(request: FastifyRequest, code: string, message: string, details?: unknown): ErrorBody {
  return { error: { code, message, request_id: request.id, ...(details === undefined ? {} : { details }) } };
}

function isFastifyClientError(err: unknown): err is FastifyError & { statusCode: number } {
  if (!(err instanceof Error)) return false;
  const statusCode = (err as { statusCode?: unknown }).statusCode;
  return typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500;
}

/**
 * Every error leaves as `{ error: { code, message, request_id } }` (section 5). Fastify's
 * own client errors (malformed JSON, wrong content type, body too large) are an invalid
 * body, so 400 `VALIDATION_ERROR` (ADR-019). Anything unexpected is a 500 whose message
 * never leaks internals.
 */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err: unknown, request: FastifyRequest, reply: FastifyReply) => {
    if (err instanceof ApiError) {
      if (err.statusCode >= 500) request.log.error({ err, code: err.code }, 'request failed');
      void reply
        .headers(err.headers)
        .code(err.statusCode)
        .send(errorBody(request, err.code, err.message, err.details));
      return;
    }
    if (isFastifyClientError(err)) {
      void reply.code(400).send(errorBody(request, 'VALIDATION_ERROR', `invalid request: ${err.message}`));
      return;
    }
    request.log.error({ err }, 'unexpected error');
    void reply.code(500).send(errorBody(request, 'INTERNAL', 'internal error'));
  });

  app.setNotFoundHandler((request, reply) => {
    void reply
      .code(404)
      .send(errorBody(request, 'NOT_FOUND', `no route for ${request.method} ${request.url.split('?')[0] ?? ''}`));
  });
}
