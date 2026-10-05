import { status as Status } from '@grpc/grpc-js';
import { makeGrpcError, sleep, type GrpcError, type Instrument } from '@switch/common';
import {
  OperationStatus,
  OperationType,
  type Account as ProtoAccount,
  type BankServiceServer,
  type ChaosConfig,
  type MoneyOperationResponse,
} from '@switch/proto-gen/bank/v1';
import type { Pool } from 'pg';
import {
  validateChaosSettings,
  type ChaosEngine,
  type ChaosPlan,
  type ChaosScope,
  type ChaosSettings,
} from '../chaos/chaos';
import type { BankMetrics } from '../metrics';
import { createAccount, getAccount, type Account, type AccountStatus } from '../repo/accountsRepo';
import {
  applyMoneyOperation,
  getOperation,
  resolveOperation,
  reverseDebit,
  type MoneyOutcome,
  type OperationKind,
  type RejectionCode,
} from '../repo/operationsRepo';

/**
 * `x-error-code` values (spec section 8 table, plus the ADR-016 codes for cases the spec
 * leaves unnamed: malformed requests, duplicate accounts, bad chaos config, chaos UNAVAILABLE).
 */
export const BankErrorCode = {
  INSUFFICIENT_FUNDS: 'INSUFFICIENT_FUNDS',
  ACCOUNT_BLOCKED: 'ACCOUNT_BLOCKED',
  ACCOUNT_NOT_FOUND: 'ACCOUNT_NOT_FOUND',
  REFERENCE_VOIDED: 'REFERENCE_VOIDED',
  NOTHING_TO_REVERSE: 'NOTHING_TO_REVERSE',
  REFERENCE_CONFLICT: 'REFERENCE_CONFLICT',
  CURRENCY_MISMATCH: 'CURRENCY_MISMATCH',
  INVALID_REQUEST: 'INVALID_REQUEST',
  ACCOUNT_ALREADY_EXISTS: 'ACCOUNT_ALREADY_EXISTS',
  CHAOS_CONFIG_INVALID: 'CHAOS_CONFIG_INVALID',
  BANK_UNAVAILABLE: 'BANK_UNAVAILABLE',
} as const;

const REJECTION_STATUS: Record<RejectionCode, Status> = {
  INSUFFICIENT_FUNDS: Status.FAILED_PRECONDITION,
  ACCOUNT_BLOCKED: Status.FAILED_PRECONDITION,
  ACCOUNT_NOT_FOUND: Status.NOT_FOUND,
  REFERENCE_VOIDED: Status.FAILED_PRECONDITION,
  NOTHING_TO_REVERSE: Status.FAILED_PRECONDITION,
  REFERENCE_CONFLICT: Status.INVALID_ARGUMENT,
  CURRENCY_MISMATCH: Status.INVALID_ARGUMENT,
};

const CURRENCY = /^[A-Z]{3}$/;
const INTEGER = /^-?\d+$/;
const INT64_MAX = 9_223_372_036_854_775_807n;

export interface HandlerDeps {
  pool: Pool;
  chaos: ChaosEngine;
  metrics: BankMetrics;
  instrument: Instrument;
  bankCallTimeoutMs: number;
}

export function createBankHandlers(deps: HandlerDeps): BankServiceServer {
  const { pool, chaos, metrics, instrument, bankCallTimeoutMs } = deps;

  /**
   * Applies the chaos plan around `work`. The plan is drawn synchronously on arrival.
   * The bank never checks whether the client cancelled: a late apply landing after the
   * client gave up is exactly the case being tested.
   */
  async function withChaos<T>(scope: ChaosScope, work: () => Promise<T>): Promise<T> {
    const plan: ChaosPlan = chaos.plan(scope);
    if (plan.down) {
      metrics.chaosInjected.inc({ mode: 'down' });
      throw unavailable('bank is down (chaos)');
    }
    if (plan.latencyMs > 0) {
      metrics.chaosInjected.inc({ mode: 'latency' });
      await sleep(plan.latencyMs);
    }
    if (plan.mode === 'reject') {
      metrics.chaosInjected.inc({ mode: 'reject' });
      throw unavailable('request rejected (chaos)');
    }
    if (plan.mode === 'late_apply') {
      metrics.chaosInjected.inc({ mode: 'late_apply' });
      await sleep(plan.slowMs);
      return work();
    }
    if (plan.mode === 'lost_response') {
      metrics.chaosInjected.inc({ mode: 'lost_response' });
      try {
        return await work();
      } finally {
        await sleep(plan.slowMs);
      }
    }
    return work();
  }

  function finishMoney(operation: OperationKind, outcome: MoneyOutcome): MoneyOperationResponse {
    if (outcome.status === 'rejected') {
      metrics.bankOperations.inc({ operation, result: outcome.code });
      throw makeGrpcError(REJECTION_STATUS[outcome.code], outcome.code, rejectionMessage(outcome.code));
    }
    const op = outcome.operation;
    metrics.bankOperations.inc({ operation, result: op.replayed ? 'REPLAYED' : 'APPLIED' });
    return {
      bankTxnId: op.bankTxnId,
      status: OperationStatus.OPERATION_STATUS_APPLIED,
      balanceAfter: op.balanceAfter.toString(),
      appliedAt: op.appliedAt,
    };
  }

  const moneyHandler = (kind: 'DEBIT' | 'CREDIT'): BankServiceServer['debit'] =>
    instrument(kind === 'DEBIT' ? 'Debit' : 'Credit', (request) =>
      withChaos('money', async () => {
        const amount = parsePositiveAmount(request.amount);
        if (request.referenceId === '' || request.accountId === '' || amount === null) {
          throw invalid('reference_id, account_id and a positive int64 amount are required');
        }
        if (!CURRENCY.test(request.currency)) throw invalid(`currency must be 3 upper-case letters`);
        const outcome = await applyMoneyOperation(pool, kind, {
          referenceId: request.referenceId,
          accountId: request.accountId,
          amount,
          currency: request.currency,
        });
        return finishMoney(kind, outcome);
      }),
    );

  return {
    debit: moneyHandler('DEBIT'),
    credit: moneyHandler('CREDIT'),

    reverseDebit: instrument('ReverseDebit', (request) =>
      withChaos('money', async () => {
        if (request.referenceId === '') throw invalid('reference_id is required');
        return finishMoney('REVERSE_DEBIT', await reverseDebit(pool, request.referenceId));
      }),
    ),

    resolve: instrument('Resolve', (request) =>
      withChaos('lookup', async () => {
        if (request.referenceId === '') throw invalid('reference_id is required');
        const kind = toOperationKind(request.operation);
        if (kind !== 'DEBIT' && kind !== 'CREDIT') throw invalid('Resolve takes DEBIT or CREDIT only');
        const status = await resolveOperation(pool, request.referenceId, kind);
        metrics.bankOperations.inc({ operation: 'RESOLVE', result: status });
        return {
          status:
            status === 'APPLIED' ? OperationStatus.OPERATION_STATUS_APPLIED : OperationStatus.OPERATION_STATUS_VOIDED,
        };
      }),
    ),

    getOperation: instrument('GetOperation', (request) =>
      withChaos('lookup', async () => {
        if (request.referenceId === '') throw invalid('reference_id is required');
        const kind = toOperationKind(request.operation);
        if (kind === null) throw invalid('operation must be DEBIT, CREDIT or REVERSE_DEBIT');
        const found = await getOperation(pool, request.referenceId, kind);
        return {
          status:
            found.status === 'APPLIED'
              ? OperationStatus.OPERATION_STATUS_APPLIED
              : found.status === 'VOIDED'
                ? OperationStatus.OPERATION_STATUS_VOIDED
                : OperationStatus.OPERATION_STATUS_NOT_FOUND,
          accountId: found.accountId ?? '',
          amount: (found.amount ?? 0n).toString(),
        };
      }),
    ),

    // Admin and test support: exempt from chaos.
    createAccount: instrument('CreateAccount', async (request) => {
      const openingBalance = parseNonNegativeAmount(request.openingBalance);
      if (request.accountId === '' || request.holderName === '' || openingBalance === null) {
        throw invalid('account_id, holder_name and a non-negative opening_balance are required');
      }
      const currency = request.currency === '' ? 'INR' : request.currency;
      if (!CURRENCY.test(currency)) throw invalid('currency must be 3 upper-case letters');
      const status = request.status === '' ? 'ACTIVE' : request.status;
      if (status !== 'ACTIVE' && status !== 'BLOCKED') throw invalid('status must be ACTIVE or BLOCKED');

      const created = await createAccount(pool, {
        accountId: request.accountId,
        holderName: request.holderName,
        openingBalance,
        currency,
        status: status satisfies AccountStatus,
      });
      if (created === null) {
        throw makeGrpcError(
          Status.ALREADY_EXISTS,
          BankErrorCode.ACCOUNT_ALREADY_EXISTS,
          `account ${request.accountId} already exists`,
        );
      }
      return toProtoAccount(created);
    }),

    getAccount: instrument('GetAccount', async (request) => {
      const account = await getAccount(pool, request.accountId);
      if (account === null) {
        throw makeGrpcError(
          Status.NOT_FOUND,
          BankErrorCode.ACCOUNT_NOT_FOUND,
          `account ${request.accountId} not found`,
        );
      }
      return toProtoAccount(account);
    }),

    setChaosConfig: instrument('SetChaosConfig', (request) => {
      const settings = fromProtoChaos(request);
      const problem = validateChaosSettings(settings, bankCallTimeoutMs);
      if (problem !== null) {
        return Promise.reject(makeGrpcError(Status.INVALID_ARGUMENT, BankErrorCode.CHAOS_CONFIG_INVALID, problem));
      }
      chaos.replace(settings);
      return Promise.resolve(toProtoChaos(chaos.settings));
    }),

    getChaosConfig: instrument('GetChaosConfig', () => Promise.resolve(toProtoChaos(chaos.settings))),
  };
}

function parsePositiveAmount(value: string): bigint | null {
  const amount = parseNonNegativeAmount(value);
  return amount === null || amount === 0n ? null : amount;
}

function parseNonNegativeAmount(value: string): bigint | null {
  if (!INTEGER.test(value)) return null;
  const amount = BigInt(value);
  return amount < 0n || amount > INT64_MAX ? null : amount;
}

function toOperationKind(operation: OperationType): OperationKind | null {
  switch (operation) {
    case OperationType.OPERATION_TYPE_DEBIT:
      return 'DEBIT';
    case OperationType.OPERATION_TYPE_CREDIT:
      return 'CREDIT';
    case OperationType.OPERATION_TYPE_REVERSE_DEBIT:
      return 'REVERSE_DEBIT';
    default:
      return null;
  }
}

function toProtoAccount(account: Account): ProtoAccount {
  return {
    accountId: account.accountId,
    holderName: account.holderName,
    balance: account.balance.toString(),
    currency: account.currency,
    status: account.status,
  };
}

function fromProtoChaos(config: ChaosConfig): ChaosSettings {
  return {
    down: config.down,
    latencyMinMs: config.latencyMinMs,
    latencyMaxMs: config.latencyMaxMs,
    rejectRate: config.rejectRate,
    lateApplyRate: config.lateApplyRate,
    lostResponseRate: config.lostResponseRate,
    slowMs: config.slowMs,
    seed: config.seed,
  };
}

function toProtoChaos(settings: ChaosSettings): ChaosConfig {
  return { ...settings };
}

function invalid(message: string): GrpcError {
  return makeGrpcError(Status.INVALID_ARGUMENT, BankErrorCode.INVALID_REQUEST, message);
}

function unavailable(message: string): GrpcError {
  return makeGrpcError(Status.UNAVAILABLE, BankErrorCode.BANK_UNAVAILABLE, message);
}

function rejectionMessage(code: RejectionCode): string {
  switch (code) {
    case 'INSUFFICIENT_FUNDS':
      return 'insufficient funds';
    case 'ACCOUNT_BLOCKED':
      return 'account is blocked';
    case 'ACCOUNT_NOT_FOUND':
      return 'account not found';
    case 'CURRENCY_MISMATCH':
      return 'currency does not match the account';
    case 'REFERENCE_VOIDED':
      return 'reference was voided by Resolve; the operation was never applied';
    case 'REFERENCE_CONFLICT':
      return 'reference already used with different parameters';
    case 'NOTHING_TO_REVERSE':
      return 'no applied debit to reverse for this reference';
  }
}
