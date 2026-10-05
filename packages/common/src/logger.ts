import pino from 'pino';

export type Logger = pino.Logger;

/**
 * Keys that must never reach a log line (spec section 17: no tokens, secrets or full
 * request bodies). Matched at the top level and one level down.
 */
const SECRET_KEYS = [
  'authorization',
  'password',
  'secret',
  'client_secret',
  'token',
  'access_token',
  'jwt',
  'JWT_SECRET',
  'API_CLIENTS',
];

const REDACT_PATHS = [
  ...SECRET_KEYS,
  ...SECRET_KEYS.map((key) => `*.${key}`),
  'req.headers.authorization',
  'req.body',
  'request.body',
  'body',
];

export interface LoggerOptions {
  level?: string;
  destination?: pino.DestinationStream;
}

/** JSON to stdout, with `service` on every line. */
export function createLogger(serviceName: string, options: LoggerOptions = {}): Logger {
  const config: pino.LoggerOptions = {
    level: options.level ?? 'info',
    base: { service: serviceName },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
  };
  return options.destination ? pino(config, options.destination) : pino(config);
}

export interface LogContext {
  request_id?: string;
  transfer_id?: string;
}

/** Child logger carrying `request_id` and/or `transfer_id` on every line. */
export function withContext(logger: Logger, context: LogContext): Logger {
  const bindings: LogContext = {};
  if (context.request_id !== undefined) bindings.request_id = context.request_id;
  if (context.transfer_id !== undefined) bindings.transfer_id = context.transfer_id;
  return logger.child(bindings);
}
