import { describe, expect, it } from 'vitest';
import { creditFailureCode, debitFailureCode, FailureCode } from '../../src/domain/failureCodes';

describe('bank error code -> failure code (section 14)', () => {
  it.each([
    ['INSUFFICIENT_FUNDS', FailureCode.INSUFFICIENT_FUNDS],
    ['ACCOUNT_NOT_FOUND', FailureCode.PAYER_ACCOUNT_NOT_FOUND],
    ['ACCOUNT_BLOCKED', FailureCode.PAYER_ACCOUNT_BLOCKED],
    ['REFERENCE_VOIDED', FailureCode.DEBIT_NOT_CONFIRMED],
    ['CURRENCY_MISMATCH', FailureCode.CURRENCY_MISMATCH],
  ])('debit %s -> %s', (bank, failure) => {
    expect(debitFailureCode(bank)).toBe(failure);
  });

  it.each([
    ['ACCOUNT_NOT_FOUND', FailureCode.PAYEE_ACCOUNT_NOT_FOUND],
    ['ACCOUNT_BLOCKED', FailureCode.PAYEE_ACCOUNT_BLOCKED],
    ['REFERENCE_VOIDED', FailureCode.CREDIT_NOT_CONFIRMED],
    ['CURRENCY_MISMATCH', FailureCode.CURRENCY_MISMATCH],
  ])('credit %s -> %s', (bank, failure) => {
    expect(creditFailureCode(bank)).toBe(failure);
  });

  it.each([
    'NOTHING_TO_REVERSE',
    'REFERENCE_CONFLICT',
    'INVALID_REQUEST',
    'BANK_UNAVAILABLE',
    '',
    'toString',
    '__proto__',
  ])('debit %j is not a business answer (null, so the saga treats it as a bug)', (code) => {
    expect(debitFailureCode(code)).toBeNull();
    expect(creditFailureCode(code)).toBeNull();
  });

  it('a credit can never be INSUFFICIENT_FUNDS', () => {
    expect(creditFailureCode('INSUFFICIENT_FUNDS')).toBeNull();
  });

  it('a missing x-error-code trailer maps to nothing', () => {
    expect(debitFailureCode(undefined)).toBeNull();
    expect(creditFailureCode(undefined)).toBeNull();
  });
});
