import { describe, expect, it } from 'vitest';
import { parseMessage } from '../../src/domain/events';
import { loadNotificationConfig } from '../../src/config';
import { ConfigError } from '@switch/common';

const TRANSFER = '3826712e-725b-44ea-a8cf-5f41a346c6b2';
const value = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    event_id: '42',
    event_type: 'transfer.reversed',
    transfer_id: TRANSFER,
    payee: { bank_id: 'bank_b', account_id: 'ACC009' },
    ...overrides,
  });

describe('parseMessage (the ADR-025 wire format)', () => {
  it('accepts a well-formed event and keeps the raw value for forwarding', () => {
    const raw = value();
    expect(parseMessage({ key: TRANSFER, value: raw, headers: { 'event-id': '42' } })).toEqual({
      ok: true,
      event: { eventId: '42', eventType: 'transfer.reversed', transferId: TRANSFER, payeeAccountId: 'ACC009', raw },
    });
  });

  it.each([
    ['event-id 0', { 'event-id': '0' }, value({ event_id: '0' }), TRANSFER],
    ['a non-numeric event-id', { 'event-id': 'abc' }, value({ event_id: 'abc' }), TRANSFER],
    ['a null value', { 'event-id': '42' }, null, TRANSFER],
    ['an array value', { 'event-id': '42' }, '[]', TRANSFER],
    ['an unknown event type', { 'event-id': '42' }, value({ event_type: 'payment.done' }), TRANSFER],
    ['a malformed transfer id', { 'event-id': '42' }, value({ transfer_id: 'nope' }), 'nope'],
    ['no payee', { 'event-id': '42' }, value({ payee: undefined }), TRANSFER],
  ])('rejects %s', (_name, headers, raw, key) => {
    expect(parseMessage({ key, value: raw, headers }).ok).toBe(false);
  });
});

describe('notification config (ADR-026)', () => {
  it('defaults', () => {
    expect(loadNotificationConfig({})).toMatchObject({
      HTTP_PORT: 9103,
      KAFKA_BROKERS: ['kafka:9092'],
      WEBHOOK_RETRY_BASE_MS: 200,
      WEBHOOK_FAILURE_RATE: 0,
      WEBHOOK_SEED: 42,
      WEBHOOK_LATENCY_MS: 0,
    });
  });

  it('rejects a failure rate outside [0, 1] and a malformed broker', () => {
    expect(() => loadNotificationConfig({ WEBHOOK_FAILURE_RATE: '1.5' })).toThrow(ConfigError);
    expect(() => loadNotificationConfig({ KAFKA_BROKERS: 'kafka' })).toThrow(ConfigError);
  });
});
