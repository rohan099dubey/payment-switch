import { Metadata, status as Status } from '@grpc/grpc-js';

export const ERROR_CODE_TRAILER = 'x-error-code';

export type ErrorClass = 'DEFINITE_FAILURE' | 'UNKNOWN_OUTCOME' | 'BUG';
export type CallTarget = 'bank' | 'ledger';

/**
 * A gRPC error carrying a status code, an `x-error-code` trailer and a message. Thrown
 * by handlers; `instrument()` passes it to the client unchanged.
 */
export class GrpcError extends Error {
  readonly details: string;
  readonly metadata: Metadata;

  constructor(
    readonly code: Status,
    readonly errorCode: string,
    message: string,
  ) {
    super(message);
    this.name = 'GrpcError';
    this.details = message;
    this.metadata = new Metadata();
    this.metadata.set(ERROR_CODE_TRAILER, errorCode);
  }
}

export function makeGrpcError(code: Status, errorCode: string, message: string): GrpcError {
  return new GrpcError(code, errorCode, message);
}

interface GrpcLikeError {
  code: Status;
  metadata?: unknown;
}

/** True for errors produced by grpc-js (a numeric, known status code). */
export function isGrpcError(err: unknown): err is GrpcLikeError {
  if (typeof err !== 'object' || err === null) return false;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'number' && Number.isInteger(code) && code >= 0 && code <= 16;
}

/** Reads the `x-error-code` trailer, or `undefined` if absent. */
export function errorCodeOf(err: unknown): string | undefined {
  if (!isGrpcError(err) || !(err.metadata instanceof Metadata)) return undefined;
  const value = err.metadata.get(ERROR_CODE_TRAILER)[0];
  if (value === undefined) return undefined;
  return typeof value === 'string' ? value : value.toString('utf8');
}

const ALWAYS_BUG: ReadonlySet<Status> = new Set([
  Status.UNIMPLEMENTED,
  Status.PERMISSION_DENIED,
  Status.UNAUTHENTICATED,
]);

/**
 * Decides what an error from a downstream call means (spec section 14). The same status
 * means different things from a bank and from the ledger, hence `target`.
 *
 * Anything not explicitly listed as a definite failure or a bug is `UNKNOWN_OUTCOME`:
 * money may or may not have moved, and `Resolve` can always settle it. That includes
 * every non-gRPC error (socket reset, DNS failure) and `OK` arriving as an error.
 */
export function classify(err: unknown, target: CallTarget): ErrorClass {
  if (!isGrpcError(err)) return 'UNKNOWN_OUTCOME';
  const code = err.code;
  const errorCode = errorCodeOf(err);

  if (ALWAYS_BUG.has(code)) return 'BUG';

  if (target === 'bank') {
    switch (code) {
      case Status.FAILED_PRECONDITION:
        return errorCode === 'NOTHING_TO_REVERSE' ? 'BUG' : 'DEFINITE_FAILURE';
      case Status.NOT_FOUND:
        return 'DEFINITE_FAILURE';
      case Status.INVALID_ARGUMENT:
        return errorCode === 'CURRENCY_MISMATCH' ? 'DEFINITE_FAILURE' : 'BUG';
      default:
        return 'UNKNOWN_OUTCOME';
    }
  }

  switch (code) {
    case Status.INVALID_ARGUMENT:
    case Status.NOT_FOUND:
    case Status.FAILED_PRECONDITION:
    case Status.ALREADY_EXISTS:
      return 'BUG';
    default:
      return 'UNKNOWN_OUTCOME';
  }
}
