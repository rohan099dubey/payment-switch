import { ConfigError } from '@switch/common';
import { describe, expect, it } from 'vitest';
import { loadGatewayConfig } from '../src/config';

const required = {
  JWT_SECRET: 'x'.repeat(32),
  API_CLIENTS: '[{"client_id":"demo-client","client_secret":"demo-secret"}]',
};

describe('gateway config (section 15)', () => {
  it('defaults every optional variable to the spec value', () => {
    expect(loadGatewayConfig(required)).toMatchObject({
      HTTP_PORT: 8080,
      JWT_TTL_SECONDS: 900,
      REDIS_URL: 'redis://redis:6379',
      RATE_LIMIT_RPS: 100,
      RATE_LIMIT_BURST: 200,
      ORCHESTRATOR_ADDR: 'orchestrator:50051',
      ORCHESTRATOR_TIMEOUT_MS: 10_000,
      MAX_TRANSFER_AMOUNT: 10_000_000,
      API_CLIENTS: [{ clientId: 'demo-client', clientSecret: 'demo-secret' }],
    });
  });

  it('requires JWT_SECRET of at least 32 characters, with no default', () => {
    expect(() => loadGatewayConfig({ API_CLIENTS: required.API_CLIENTS })).toThrow(ConfigError);
    expect(() => loadGatewayConfig({ ...required, JWT_SECRET: 'x'.repeat(31) })).toThrow(/at least 32/);
  });

  it.each([
    ['missing', undefined],
    ['not JSON', 'demo:secret'],
    ['an empty array', '[]'],
    ['an object', '{"client_id":"a","client_secret":"b"}'],
    ['an empty secret', '[{"client_id":"a","client_secret":""}]'],
    ['an unknown field', '[{"client_id":"a","client_secret":"b","role":"admin"}]'],
    ['a client id with a colon', '[{"client_id":"a:b","client_secret":"b"}]'],
    ['duplicate client ids', '[{"client_id":"a","client_secret":"b"},{"client_id":"a","client_secret":"c"}]'],
  ])('rejects API_CLIENTS that is %s', (_name, value) => {
    const env: NodeJS.ProcessEnv = { JWT_SECRET: required.JWT_SECRET };
    if (value !== undefined) env.API_CLIENTS = value;
    expect(() => loadGatewayConfig(env)).toThrow(ConfigError);
  });

  it('never echoes the secret values in the error', () => {
    try {
      loadGatewayConfig({
        JWT_SECRET: 'short-but-secret',
        API_CLIENTS: '[{"client_id":"a","client_secret":"hunter2"}',
      });
    } catch (err) {
      expect(String(err)).not.toContain('short-but-secret');
      expect(String(err)).not.toContain('hunter2');
      return;
    }
    throw new Error('expected a ConfigError');
  });

  it.each([
    ['RATE_LIMIT_RPS', '0'],
    ['RATE_LIMIT_BURST', '-5'],
    ['ORCHESTRATOR_TIMEOUT_MS', '0'],
    ['ORCHESTRATOR_ADDR', 'orchestrator'],
    ['MAX_TRANSFER_AMOUNT', '9007199254740993'],
    ['HTTP_PORT', '0'],
  ])('rejects %s=%s', (key, value) => {
    expect(() => loadGatewayConfig({ ...required, [key]: value })).toThrow(ConfigError);
  });
});
