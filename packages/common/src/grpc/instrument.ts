import { randomUUID } from 'node:crypto';
import { status as Status, type handleUnaryCall, type Metadata } from '@grpc/grpc-js';
import { Counter, Histogram, type Registry } from 'prom-client';
import { withContext, type Logger } from '../logger';
import { REQUEST_ID_HEADER } from './call';
import { GrpcError, makeGrpcError } from './errors';

export interface HandlerContext {
  requestId: string;
  logger: Logger;
  metadata: Metadata;
}

/** A unary handler written as an async function: return the response or throw a `GrpcError`. */
export type UnaryHandler<Req, Res> = (request: Req, ctx: HandlerContext) => Promise<Res>;

export type Instrument = <Req, Res>(name: string, handler: UnaryHandler<Req, Res>) => handleUnaryCall<Req, Res>;

export interface InstrumentDeps {
  logger: Logger;
  registry: Registry;
}

/**
 * Builds `instrument(name, handler)`, which wraps every server handler with: request id
 * (from `x-request-id` or freshly generated), a child logger, `grpc_requests_total` and
 * `grpc_request_duration_seconds`, and error mapping. A thrown `GrpcError` reaches the
 * client unchanged; anything else is logged and becomes `INTERNAL` without leaking its
 * message.
 */
export function createInstrument({ logger, registry }: InstrumentDeps): Instrument {
  const requests = new Counter({
    name: 'grpc_requests_total',
    help: 'gRPC requests handled, by method and status code',
    labelNames: ['method', 'code'] as const,
    registers: [registry],
  });
  const duration = new Histogram({
    name: 'grpc_request_duration_seconds',
    help: 'gRPC handler latency in seconds',
    labelNames: ['method'] as const,
    registers: [registry],
  });

  return <Req, Res>(name: string, handler: UnaryHandler<Req, Res>): handleUnaryCall<Req, Res> =>
    (call, callback) => {
      const started = process.hrtime.bigint();
      const headerId = call.metadata.get(REQUEST_ID_HEADER)[0];
      const requestId = typeof headerId === 'string' && headerId !== '' ? headerId : randomUUID();
      const log = withContext(logger, { request_id: requestId }).child({ method: name });

      const finish = (code: Status): number => {
        const seconds = Number(process.hrtime.bigint() - started) / 1e9;
        requests.inc({ method: name, code: Status[code] });
        duration.observe({ method: name }, seconds);
        return Math.round(seconds * 1000);
      };

      handler(call.request, { requestId, logger: log, metadata: call.metadata }).then(
        (response) => {
          const durationMs = finish(Status.OK);
          log.debug({ code: 'OK', duration_ms: durationMs }, 'rpc completed');
          callback(null, response);
        },
        (err: unknown) => {
          if (err instanceof GrpcError) {
            const durationMs = finish(err.code);
            log.info({ code: Status[err.code], error_code: err.errorCode, duration_ms: durationMs }, 'rpc rejected');
            callback(err);
            return;
          }
          const durationMs = finish(Status.INTERNAL);
          log.error({ err, duration_ms: durationMs }, 'rpc failed with an unexpected error');
          callback(makeGrpcError(Status.INTERNAL, 'INTERNAL', 'internal error'));
        },
      );
    };
}
