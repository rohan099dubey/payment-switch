import { Metadata, type CallOptions, type ClientUnaryCall, type ServiceError } from '@grpc/grpc-js';

export const REQUEST_ID_HEADER = 'x-request-id';

/** The 4-argument overload every generated unary client method has. */
export type UnaryMethod<Req, Res> = (
  request: Req,
  metadata: Metadata,
  options: Partial<CallOptions>,
  callback: (error: ServiceError | null, response: Res) => void,
) => ClientUnaryCall;

export interface CallOptionsInput {
  timeoutMs: number;
  requestId?: string;
}

/**
 * Promisified unary call that always carries a deadline (spec section 14: no call may
 * run without one) and propagates the request id as `x-request-id` metadata.
 *
 * Pass a bound method: `callUnary(client.debit.bind(client), req, { timeoutMs })`.
 */
export function callUnary<Req, Res>(
  fn: UnaryMethod<Req, Res>,
  request: Req,
  { timeoutMs, requestId }: CallOptionsInput,
): Promise<Res> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return Promise.reject(new RangeError(`callUnary: timeoutMs must be a positive number, got ${timeoutMs}`));
  }
  const metadata = new Metadata();
  if (requestId !== undefined) metadata.set(REQUEST_ID_HEADER, requestId);
  const deadline = new Date(Date.now() + timeoutMs);

  return new Promise<Res>((resolve, reject) => {
    fn(request, metadata, { deadline }, (error, response) => {
      if (error) reject(error);
      else resolve(response);
    });
  });
}
