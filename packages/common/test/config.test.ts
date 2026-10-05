import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ConfigError, loadConfig } from '../src/config';

const schema = z.object({
  GRPC_PORT: z.coerce.number().int().positive().default(50052),
  DATABASE_URL: z.url(),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

describe('loadConfig', () => {
  it('parses, coerces and applies defaults', () => {
    const config = loadConfig(schema, { DATABASE_URL: 'postgres://u:p@h:5432/db', GRPC_PORT: '6000' });
    expect(config).toEqual({ GRPC_PORT: 6000, DATABASE_URL: 'postgres://u:p@h:5432/db', LOG_LEVEL: 'info' });
  });

  it('fails fast with every problem named in one readable error', () => {
    let caught: unknown;
    try {
      loadConfig(schema, { GRPC_PORT: 'abc', LOG_LEVEL: 'loud' });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    const err = caught as ConfigError;
    expect(err.issues).toHaveLength(3);
    expect(err.message).toMatch(/^Invalid configuration:/);
    expect(err.message).toContain('GRPC_PORT');
    expect(err.message).toContain('DATABASE_URL');
    expect(err.message).toContain('LOG_LEVEL');
  });
});
