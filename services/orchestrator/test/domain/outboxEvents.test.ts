import { describe, expect, it } from 'vitest';
import {
  eventPayload,
  eventTypeFor,
  OutboxEventType,
  toMessage,
  type OutboxEvent,
} from '../../src/domain/outboxEvents';
import { ALL_STATES, isTerminal, TransferState } from '../../src/domain/states';
import { makeTransfer } from './fakes';

describe('eventTypeFor (section 19, ADR-025)', () => {
  it.each([
    [TransferState.SUCCESS, OutboxEventType.SUCCEEDED],
    [TransferState.FAILED, OutboxEventType.FAILED],
    [TransferState.REVERSED, OutboxEventType.REVERSED],
    [TransferState.NEEDS_MANUAL_REVIEW, OutboxEventType.NEEDS_MANUAL_REVIEW],
  ])('%s emits %s', (state, type) => {
    expect(eventTypeFor(state)).toBe(type);
  });

  it('every terminal state emits an event, and no other state does', () => {
    for (const state of ALL_STATES) expect(eventTypeFor(state) !== null).toBe(isTerminal(state));
  });
});

describe('eventPayload', () => {
  it('carries money as a string of paise, never a JSON number', () => {
    const payload = eventPayload(makeTransfer({ amount: 9_007_199_254_740_993n, state: TransferState.SUCCESS }));
    expect(payload.amount).toBe('9007199254740993');
    expect((JSON.parse(JSON.stringify(payload)) as { amount: unknown }).amount).toBe('9007199254740993');
  });

  it('names the transfer, its outcome and both parties, and leaves the free-text note out', () => {
    const t = makeTransfer({
      state: TransferState.REVERSED,
      failureCode: 'PAYEE_ACCOUNT_NOT_FOUND',
      note: 'private text',
      updatedAt: new Date('2026-10-07T08:00:00.000Z'),
    });
    const payload = eventPayload(t);
    expect(payload).toEqual({
      transfer_id: t.id,
      client_id: t.clientId,
      state: 'REVERSED',
      failure_code: 'PAYEE_ACCOUNT_NOT_FOUND',
      amount: t.amount.toString(),
      currency: t.currency,
      payer: { bank_id: t.payer.bankId, account_id: t.payer.accountId },
      payee: { bank_id: t.payee.bankId, account_id: t.payee.accountId },
      occurred_at: '2026-10-07T08:00:00.000Z',
    });
    expect(JSON.stringify(payload)).not.toContain('private text');
  });
});

describe('toMessage', () => {
  it('keys by transfer id and carries the event id and type in headers and value', () => {
    const t = makeTransfer({ state: TransferState.SUCCESS });
    const event: OutboxEvent = {
      id: '42',
      aggregateId: t.id,
      eventType: OutboxEventType.SUCCEEDED,
      payload: eventPayload(t),
    };
    const message = toMessage(event);
    expect(message.key).toBe(t.id);
    expect(message.headers).toEqual({ 'event-id': '42', 'event-type': 'transfer.succeeded' });
    expect(JSON.parse(message.value)).toEqual({ event_id: '42', event_type: 'transfer.succeeded', ...event.payload });
  });
});
