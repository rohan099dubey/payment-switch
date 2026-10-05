import { canonicalJson, sha256Hex } from '@switch/common';
import type { CreateTransferRequest } from '@switch/proto-gen/orchestrator/v1';
import { describe, expect, it } from 'vitest';
import { transferRequestHash, validateCreateTransfer } from '../../src/domain/validate';

const limits = { knownBank: (id: string) => id === 'bank_a' || id === 'bank_b', maxAmount: 10_000_000n };

function request(overrides: Partial<CreateTransferRequest> = {}): CreateTransferRequest {
  return {
    clientId: 'client-1',
    idempotencyKey: 'key-1',
    payer: { bankId: 'bank_a', accountId: 'A1' },
    payee: { bankId: 'bank_b', accountId: 'B1' },
    amount: '12500',
    currency: 'INR',
    note: '',
    ...overrides,
  };
}

function errorCodeOf(overrides: Partial<CreateTransferRequest>): string {
  const result = validateCreateTransfer(request(overrides), limits);
  return result.ok ? 'OK' : result.errorCode;
}

describe('validateCreateTransfer (section 6, step 1)', () => {
  it('accepts a valid request and converts the amount to bigint', () => {
    const result = validateCreateTransfer(request({ note: 'rent' }), limits);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.transfer).toMatchObject({
      clientId: 'client-1',
      idempotencyKey: 'key-1',
      payer: { bankId: 'bank_a', accountId: 'A1' },
      payee: { bankId: 'bank_b', accountId: 'B1' },
      amount: 12_500n,
      currency: 'INR',
      note: 'rent',
    });
    expect(result.transfer.requestHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('stores an empty note as NULL', () => {
    const result = validateCreateTransfer(request(), limits);
    expect(result.ok && result.transfer.note).toBeNull();
  });

  it.each([
    ['empty client_id', { clientId: '' }],
    ['empty idempotency_key', { idempotencyKey: '' }],
    ['missing payer', { payer: undefined }],
    ['missing payee', { payee: undefined }],
    ['empty payer account', { payer: { bankId: 'bank_a', accountId: '' } }],
    ['empty payee bank', { payee: { bankId: '', accountId: 'B1' } }],
  ])('%s -> INVALID_REQUEST', (_name, overrides) => {
    expect(errorCodeOf(overrides)).toBe('INVALID_REQUEST');
  });

  it('same bank and account -> SAME_ACCOUNT', () => {
    expect(errorCodeOf({ payee: { bankId: 'bank_a', accountId: 'A1' } })).toBe('SAME_ACCOUNT');
  });

  it('same account id at different banks is two different accounts', () => {
    expect(errorCodeOf({ payee: { bankId: 'bank_b', accountId: 'A1' } })).toBe('OK');
  });

  it('two accounts at the same bank are allowed', () => {
    expect(errorCodeOf({ payee: { bankId: 'bank_a', accountId: 'A2' } })).toBe('OK');
  });

  it.each([
    ['payer', { payer: { bankId: 'bank_z', accountId: 'A1' } }],
    ['payee', { payee: { bankId: 'bank_z', accountId: 'B1' } }],
  ])('unknown %s bank -> UNKNOWN_BANK', (_name, overrides) => {
    expect(errorCodeOf(overrides)).toBe('UNKNOWN_BANK');
  });

  it.each(['0', '-1', '10000001', '9223372036854775807', '1.5', '', 'abc', '1e3', ' 1'])(
    'amount %j -> INVALID_AMOUNT',
    (amount) => {
      expect(errorCodeOf({ amount })).toBe('INVALID_AMOUNT');
    },
  );

  it.each(['1', '10000000'])('amount %s is within 1..MAX_TRANSFER_AMOUNT', (amount) => {
    expect(errorCodeOf({ amount })).toBe('OK');
  });

  it.each(['USD', 'inr', '', 'INRR'])('currency %j -> UNSUPPORTED_CURRENCY', (currency) => {
    expect(errorCodeOf({ currency })).toBe('UNSUPPORTED_CURRENCY');
  });

  it('checks in the spec order: same account before unknown bank before amount before currency', () => {
    expect(errorCodeOf({ payee: { bankId: 'bank_a', accountId: 'A1' }, amount: '0', currency: 'USD' })).toBe(
      'SAME_ACCOUNT',
    );
    expect(errorCodeOf({ payee: { bankId: 'bank_z', accountId: 'B1' }, amount: '0', currency: 'USD' })).toBe(
      'UNKNOWN_BANK',
    );
    expect(errorCodeOf({ amount: '0', currency: 'USD' })).toBe('INVALID_AMOUNT');
  });
});

describe('transferRequestHash (section 6, step 2)', () => {
  const body = {
    payer: { bankId: 'bank_a', accountId: 'A1' },
    payee: { bankId: 'bank_b', accountId: 'B1' },
    amount: 12_500n,
    currency: 'INR',
    note: 'rent',
  };

  it('is sha256 of canonical JSON of {payer, payee, amount, currency, note}', () => {
    const expected = sha256Hex(
      canonicalJson({
        payer: { bank_id: 'bank_a', account_id: 'A1' },
        payee: { bank_id: 'bank_b', account_id: 'B1' },
        amount: 12_500n,
        currency: 'INR',
        note: 'rent',
      }),
    );
    expect(transferRequestHash(body)).toBe(expected);
  });

  it('treats an absent note as ""', () => {
    expect(transferRequestHash({ ...body, note: null })).toBe(transferRequestHash({ ...body, note: '' }));
    expect(transferRequestHash({ ...body, note: undefined })).toBe(transferRequestHash({ ...body, note: '' }));
  });

  it.each([
    ['amount', { amount: 12_501n }],
    ['note', { note: 'Rent' }],
    ['payer account', { payer: { bankId: 'bank_a', accountId: 'A2' } }],
    ['payee bank', { payee: { bankId: 'bank_a', accountId: 'B1' } }],
  ])('changes when the %s changes', (_name, change) => {
    expect(transferRequestHash({ ...body, ...change })).not.toBe(transferRequestHash(body));
  });

  it('does not depend on client_id or the idempotency key (they are the lookup key, not the body)', () => {
    const a = validateCreateTransfer(request({ clientId: 'x', idempotencyKey: 'k1' }), limits);
    const b = validateCreateTransfer(request({ clientId: 'y', idempotencyKey: 'k2' }), limits);
    expect(a.ok && b.ok && a.transfer.requestHash === b.transfer.requestHash).toBe(true);
  });
});
