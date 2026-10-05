import { ConfigError } from '@switch/common';
import { describe, expect, it } from 'vitest';
import { chaosSettingsFromConfig, loadBankConfig } from '../src/config';

const BANK_A = {
  BANK_ID: 'bank_a',
  GRPC_PORT: '50061',
  HTTP_PORT: '9111',
  DATABASE_URL: 'postgres://banks:banks@postgres-banks:5432/bank_a',
};

describe('loadBankConfig', () => {
  it('applies the spec section 15 chaos defaults', () => {
    const config = loadBankConfig(BANK_A);
    expect(chaosSettingsFromConfig(config)).toEqual({
      down: false,
      latencyMinMs: 0,
      latencyMaxMs: 0,
      rejectRate: 0,
      lateApplyRate: 0,
      lostResponseRate: 0,
      slowMs: 3000,
      seed: 42,
    });
    expect(config.BANK_CALL_TIMEOUT_MS).toBe(2000);
  });

  it('requires the per-instance variables', () => {
    expect(() => loadBankConfig({})).toThrow(ConfigError);
    try {
      loadBankConfig({});
    } catch (err) {
      const message = (err as ConfigError).message;
      for (const name of ['BANK_ID', 'GRPC_PORT', 'HTTP_PORT', 'DATABASE_URL']) expect(message).toContain(name);
    }
  });

  it('parses CHAOS_DOWN strictly', () => {
    expect(loadBankConfig({ ...BANK_A, CHAOS_DOWN: 'true' }).CHAOS_DOWN).toBe(true);
    expect(() => loadBankConfig({ ...BANK_A, CHAOS_DOWN: 'yes' })).toThrow(ConfigError);
  });

  it('enforces CHAOS_SLOW_MS > BANK_CALL_TIMEOUT_MS at startup (spec section 14)', () => {
    expect(() => loadBankConfig({ ...BANK_A, CHAOS_SLOW_MS: '2000' })).toThrow(/CHAOS_SLOW_MS/);
    expect(() => loadBankConfig({ ...BANK_A, CHAOS_SLOW_MS: '4000', BANK_CALL_TIMEOUT_MS: '5000' })).toThrow(
      /CHAOS_SLOW_MS/,
    );
    expect(loadBankConfig({ ...BANK_A, CHAOS_SLOW_MS: '2001' }).CHAOS_SLOW_MS).toBe(2001);
  });

  it('rejects chaos rates that sum above 1 and an inverted latency range', () => {
    expect(() => loadBankConfig({ ...BANK_A, CHAOS_REJECT_RATE: '0.6', CHAOS_LATE_APPLY_RATE: '0.6' })).toThrow(
      /must be <= 1/,
    );
    expect(() => loadBankConfig({ ...BANK_A, CHAOS_LATENCY_MIN_MS: '10', CHAOS_LATENCY_MAX_MS: '5' })).toThrow(
      /CHAOS_LATENCY_MIN_MS/,
    );
  });

  it('rejects a BANK_ID that is not lower_snake_case', () => {
    expect(() => loadBankConfig({ ...BANK_A, BANK_ID: 'Bank-A' })).toThrow(/BANK_ID/);
  });
});
