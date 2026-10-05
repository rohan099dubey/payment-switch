import { Writable } from 'node:stream';
import { Metadata, status as Status, type ServerUnaryCall, type sendUnaryData } from '@grpc/grpc-js';
import { Registry } from 'prom-client';
import { describe, expect, it } from 'vitest';
import { REQUEST_ID_HEADER } from '../../src/grpc/call';
import { errorCodeOf, GrpcError, makeGrpcError } from '../../src/grpc/errors';
import { createInstrument, type UnaryHandler } from '../../src/grpc/instrument';
import { createLogger } from '../../src/logger';

function setup(): {
  lines: Record<string, unknown>[];
  registry: Registry;
  instrument: ReturnType<typeof createInstrument>;
} {
  const lines: Record<string, unknown>[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _enc, done) {
      lines.push(JSON.parse(chunk.toString('utf8')) as Record<string, unknown>);
      done();
    },
  });
  const logger = createLogger('test', { level: 'debug', destination });
  const registry = new Registry();
  return { lines, registry, instrument: createInstrument({ logger, registry }) };
}

function invoke<Req, Res>(
  wrapped: (call: ServerUnaryCall<Req, Res>, callback: sendUnaryData<Res>) => void,
  request: Req,
  requestId?: string,
): Promise<{ err: unknown; value: Res | null | undefined }> {
  const metadata = new Metadata();
  if (requestId !== undefined) metadata.set(REQUEST_ID_HEADER, requestId);
  const call = { request, metadata } as unknown as ServerUnaryCall<Req, Res>;
  return new Promise((resolve) => {
    wrapped(call, (err, value) => {
      resolve({ err, value });
    });
  });
}

describe('instrument', () => {
  it('passes the response through and records OK metrics', async () => {
    const { registry, instrument } = setup();
    const handler: UnaryHandler<{ n: number }, { doubled: number }> = (req) => Promise.resolve({ doubled: req.n * 2 });
    const { err, value } = await invoke(instrument('Double', handler), { n: 21 });
    expect(err).toBeNull();
    expect(value).toEqual({ doubled: 42 });
    const metrics = await registry.metrics();
    expect(metrics).toContain('grpc_requests_total{method="Double",code="OK"} 1');
    expect(metrics).toContain('grpc_request_duration_seconds_count{method="Double"} 1');
  });

  it('uses the incoming x-request-id, or generates one', async () => {
    const { instrument } = setup();
    const ids: string[] = [];
    const handler: UnaryHandler<null, null> = (_req, ctx) => {
      ids.push(ctx.requestId);
      return Promise.resolve(null);
    };
    const wrapped = instrument('Echo', handler);
    await invoke(wrapped, null, 'req-abc');
    await invoke(wrapped, null);
    expect(ids[0]).toBe('req-abc');
    expect(ids[1]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('binds request_id and method on handler log lines', async () => {
    const { lines, instrument } = setup();
    const handler: UnaryHandler<null, null> = (_req, ctx) => {
      ctx.logger.info('inside');
      return Promise.resolve(null);
    };
    await invoke(instrument('Echo', handler), null, 'req-xyz');
    const inside = lines.find((line) => line.msg === 'inside');
    expect(inside).toMatchObject({ service: 'test', request_id: 'req-xyz', method: 'Echo', level: 'info' });
  });

  it('passes a GrpcError through unchanged, trailer included', async () => {
    const { registry, instrument } = setup();
    const handler: UnaryHandler<null, null> = () =>
      Promise.reject(makeGrpcError(Status.FAILED_PRECONDITION, 'INSUFFICIENT_FUNDS', 'balance too low'));
    const { err } = await invoke(instrument('Debit', handler), null);
    expect(err).toBeInstanceOf(GrpcError);
    expect((err as GrpcError).code).toBe(Status.FAILED_PRECONDITION);
    expect(errorCodeOf(err)).toBe('INSUFFICIENT_FUNDS');
    expect(await registry.metrics()).toContain('grpc_requests_total{method="Debit",code="FAILED_PRECONDITION"} 1');
  });

  it('maps an unexpected error to INTERNAL without leaking its message', async () => {
    const { lines, registry, instrument } = setup();
    const handler: UnaryHandler<null, null> = () => Promise.reject(new Error('password=hunter2 in a stack trace'));
    const { err } = await invoke(instrument('Debit', handler), null);
    expect(err).toBeInstanceOf(GrpcError);
    expect((err as GrpcError).code).toBe(Status.INTERNAL);
    expect(errorCodeOf(err)).toBe('INTERNAL');
    expect((err as GrpcError).details).toBe('internal error');
    expect(await registry.metrics()).toContain('grpc_requests_total{method="Debit",code="INTERNAL"} 1');
    expect(lines.some((line) => line.level === 'error')).toBe(true);
  });
});

describe('createLogger redaction', () => {
  it('never writes secrets or bodies', () => {
    const written: string[] = [];
    const destination = new Writable({
      write(chunk: Buffer, _enc, done) {
        written.push(chunk.toString('utf8'));
        done();
      },
    });
    const logger = createLogger('redact', { destination });
    logger.info(
      { client_secret: 's3cret', token: 'eyJ', body: { amount: 1 }, req: { headers: { authorization: 'Bearer x' } } },
      'hello',
    );
    expect(written).toHaveLength(1);
    const text = written.join('');
    expect(text).not.toContain('s3cret');
    expect(text).not.toContain('eyJ');
    expect(text).not.toContain('Bearer x');
    expect(text).not.toContain('"amount"');
    expect(text).toContain('[REDACTED]');
  });
});
