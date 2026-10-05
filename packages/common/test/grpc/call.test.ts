import { Metadata, status as Status, type CallOptions, type ClientUnaryCall, type ServiceError } from '@grpc/grpc-js';
import { describe, expect, it } from 'vitest';
import { callUnary, REQUEST_ID_HEADER } from '../../src/grpc/call';

interface Captured {
  metadata?: Metadata;
  options?: Partial<CallOptions>;
}

function fakeMethod(
  captured: Captured,
  outcome: { error: ServiceError | null; response: string },
): (
  request: string,
  metadata: Metadata,
  options: Partial<CallOptions>,
  callback: (error: ServiceError | null, response: string) => void,
) => ClientUnaryCall {
  return (_request, metadata, options, callback) => {
    captured.metadata = metadata;
    captured.options = options;
    callback(outcome.error, outcome.response);
    return {} as ClientUnaryCall;
  };
}

describe('callUnary', () => {
  it('sets a deadline timeoutMs in the future and the x-request-id metadata', async () => {
    const captured: Captured = {};
    const before = Date.now();
    const result = await callUnary(fakeMethod(captured, { error: null, response: 'pong' }), 'ping', {
      timeoutMs: 2000,
      requestId: 'req-1',
    });
    expect(result).toBe('pong');
    const deadline = captured.options?.deadline;
    expect(deadline).toBeInstanceOf(Date);
    const ms = (deadline as Date).getTime() - before;
    expect(ms).toBeGreaterThanOrEqual(2000);
    expect(ms).toBeLessThan(2100);
    expect(captured.metadata?.get(REQUEST_ID_HEADER)).toEqual(['req-1']);
  });

  it('omits x-request-id when none is given', async () => {
    const captured: Captured = {};
    await callUnary(fakeMethod(captured, { error: null, response: 'x' }), 'x', { timeoutMs: 10 });
    expect(captured.metadata?.get(REQUEST_ID_HEADER)).toEqual([]);
  });

  it('rejects with the service error', async () => {
    const error: ServiceError = Object.assign(new Error('down'), {
      code: Status.UNAVAILABLE,
      details: 'down',
      metadata: new Metadata(),
    });
    await expect(callUnary(fakeMethod({}, { error, response: '' }), 'x', { timeoutMs: 10 })).rejects.toBe(error);
  });

  it('refuses to make a call without a positive deadline', async () => {
    const captured: Captured = {};
    const method = fakeMethod(captured, { error: null, response: 'x' });
    await expect(callUnary(method, 'x', { timeoutMs: 0 })).rejects.toThrow(RangeError);
    await expect(callUnary(method, 'x', { timeoutMs: -5 })).rejects.toThrow(RangeError);
    await expect(callUnary(method, 'x', { timeoutMs: Number.POSITIVE_INFINITY })).rejects.toThrow(RangeError);
    expect(captured.options).toBeUndefined();
  });
});
