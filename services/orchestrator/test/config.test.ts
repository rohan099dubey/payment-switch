import { hostname } from 'node:os';
import { ConfigError } from '@switch/common';
import { describe, expect, it } from 'vitest';
import { loadOrchestratorConfig } from '../src/config';
import { policyFromConfig } from '../src/domain/policy';

describe('orchestrator config (section 15)', () => {
  it('defaults every variable to the spec value', () => {
    const c = loadOrchestratorConfig({});
    expect(c).toMatchObject({
      GRPC_PORT: 50051,
      HTTP_PORT: 9101,
      DATABASE_URL: 'postgres://orch:orch@postgres-orchestrator:5432/orchestrator_db',
      LEDGER_ADDR: 'ledger:50052',
      MAX_TRANSFER_AMOUNT: 10_000_000n,
      BANK_CALL_TIMEOUT_MS: 2000,
      LEDGER_CALL_TIMEOUT_MS: 2000,
      INLINE_BANK_RETRIES: 2,
      INLINE_LEDGER_RETRIES: 2,
      SAGA_INLINE_BUDGET_MS: 8000,
      REPLAY_WAIT_MS: 2000,
      LEASE_MS: 15_000,
      RECOVERY_POLL_MS: 1000,
      RECOVERY_BATCH: 20,
      RECOVERY_CONCURRENCY: 5,
      RESOLVE_AFTER_ATTEMPTS: 3,
      MAX_RECOVERY_ATTEMPTS: 20,
      INSTANCE_ID: hostname(),
    });
    expect([...c.BANK_ENDPOINTS]).toEqual([
      ['bank_a', 'bank-a:50061'],
      ['bank_b', 'bank-b:50062'],
    ]);
  });

  it('outbox relay settings (ADR-025): KAFKA_BROKERS is a host:port list, OUTBOX_POLL_MS defaults to 500', () => {
    const c = loadOrchestratorConfig({});
    expect(c.KAFKA_BROKERS).toEqual(['kafka:9092']);
    expect(c.OUTBOX_POLL_MS).toBe(500);
    expect(loadOrchestratorConfig({ KAFKA_BROKERS: 'a:9092, b:9093' }).KAFKA_BROKERS).toEqual(['a:9092', 'b:9093']);
    expect(() => loadOrchestratorConfig({ KAFKA_BROKERS: 'kafka' })).toThrow(ConfigError);
    expect(() => loadOrchestratorConfig({ KAFKA_BROKERS: 'a:9092,' })).toThrow(ConfigError);
    expect(() => loadOrchestratorConfig({ OUTBOX_POLL_MS: '0' })).toThrow(ConfigError);
  });

  it('treats an empty INSTANCE_ID (as in .env.example) as the hostname', () => {
    expect(loadOrchestratorConfig({ INSTANCE_ID: '' }).INSTANCE_ID).toBe(hostname());
    expect(loadOrchestratorConfig({ INSTANCE_ID: 'orch-2' }).INSTANCE_ID).toBe('orch-2');
  });

  it('parses BANK_ENDPOINTS with any number of banks', () => {
    const c = loadOrchestratorConfig({ BANK_ENDPOINTS: 'bank_a=localhost:1, bank_c=10.0.0.3:50063' });
    expect(Object.fromEntries(c.BANK_ENDPOINTS)).toEqual({ bank_a: 'localhost:1', bank_c: '10.0.0.3:50063' });
  });

  it.each([
    ['a duplicate bank', 'bank_a=a:1,bank_a=b:2'],
    ['a missing address', 'bank_a'],
    ['an address without a port', 'bank_a=bank-a'],
    ['a bad bank id', 'Bank-A=bank-a:1'],
    ['two equals signs', 'bank_a=x=y:1'],
  ])('rejects BANK_ENDPOINTS with %s', (_name, value) => {
    expect(() => loadOrchestratorConfig({ BANK_ENDPOINTS: value })).toThrow(ConfigError);
  });

  it('enforces SAGA_INLINE_BUDGET_MS < ORCHESTRATOR_TIMEOUT_MS at startup (section 14)', () => {
    expect(() => loadOrchestratorConfig({ SAGA_INLINE_BUDGET_MS: '10000' })).toThrow(
      /SAGA_INLINE_BUDGET_MS must be smaller/,
    );
    expect(() => loadOrchestratorConfig({ SAGA_INLINE_BUDGET_MS: '9000', ORCHESTRATOR_TIMEOUT_MS: '9000' })).toThrow(
      ConfigError,
    );
    expect(loadOrchestratorConfig({ SAGA_INLINE_BUDGET_MS: '9999' }).SAGA_INLINE_BUDGET_MS).toBe(9999);
  });

  it('refuses a lease shorter than the inline budget, and a replay wait past the Gateway timeout', () => {
    expect(() => loadOrchestratorConfig({ LEASE_MS: '8000' })).toThrow(/LEASE_MS/);
    expect(() => loadOrchestratorConfig({ REPLAY_WAIT_MS: '10000' })).toThrow(/REPLAY_WAIT_MS/);
  });

  it.each([
    ['MAX_TRANSFER_AMOUNT', '0'],
    ['MAX_TRANSFER_AMOUNT', '1.5'],
    ['INLINE_BANK_RETRIES', '-1'],
    ['BANK_CALL_TIMEOUT_MS', '0'],
    ['GRPC_PORT', '70000'],
    ['LEDGER_ADDR', 'ledger'],
  ])('rejects %s=%s', (key, value) => {
    expect(() => loadOrchestratorConfig({ [key]: value })).toThrow(ConfigError);
  });

  it('turns retry counts into total attempts for withRetry', () => {
    const policy = policyFromConfig(loadOrchestratorConfig({ INLINE_BANK_RETRIES: '0', INLINE_LEDGER_RETRIES: '4' }));
    expect(policy.bankAttempts).toBe(1);
    expect(policy.ledgerAttempts).toBe(5);
    expect(policy.retryBaseMs).toBe(100);
    expect(policy.retryMaxMs).toBe(800);
  });

  it('recovery backoff is min(1000 * 2^attempts, 60000) plus up to 20% jitter', () => {
    const policy = policyFromConfig(loadOrchestratorConfig({}), () => 0);
    expect(policy.recoveryBackoffMs(1)).toBe(2000);
    expect(policy.recoveryBackoffMs(10)).toBe(60_000);
  });
});
