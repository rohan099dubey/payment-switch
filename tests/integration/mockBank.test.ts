/**
 * M2 acceptance: both Mock Bank instances over real gRPC, plus raw SQL against
 * `bank_a` / `bank_b`. Needs the stack: `npm run stack:up`.
 *
 * Account and reference ids are unique per run. Chaos config is in-memory per instance,
 * so every test restores the startup config afterwards.
 */
import { randomUUID } from 'node:crypto';
import { status as Status } from '@grpc/grpc-js';
import { callUnary, errorCodeOf, makeClient, sleep } from '@switch/common';
import {
  BankServiceClient,
  OperationStatus,
  OperationType,
  type Account,
  type ChaosConfig,
  type GetOperationResponse,
  type MoneyOperationRequest,
  type MoneyOperationResponse,
  type ResolveResponse,
} from '@switch/proto-gen/bank/v1';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

const TIMEOUT_MS = 10_000;
/** Chaos tests: a client deadline well below SLOW_MS, so late and lost responses really are late. */
const SHORT_DEADLINE_MS = 1_000;
const SLOW_MS = 2_100;

const RUN = randomUUID().slice(0, 8);
let counter = 0;
const uniqueId = (prefix: string): string => `m2-${RUN}-${prefix}-${++counter}`;

interface Bank {
  client: BankServiceClient;
  db: Pool;
  http: string;
  startupChaos: ChaosConfig;
}

const banks: Record<'a' | 'b', Bank> = {} as Record<'a' | 'b', Bank>;

beforeAll(async () => {
  const setup = {
    a: {
      addr: process.env.BANK_A_GRPC_ADDR ?? 'localhost:50061',
      db: process.env.BANK_A_DATABASE_URL ?? 'postgres://banks:banks@localhost:5435/bank_a',
      http: process.env.BANK_A_HTTP_URL ?? 'http://localhost:9111',
    },
    b: {
      addr: process.env.BANK_B_GRPC_ADDR ?? 'localhost:50062',
      db: process.env.BANK_B_DATABASE_URL ?? 'postgres://banks:banks@localhost:5435/bank_b',
      http: process.env.BANK_B_HTTP_URL ?? 'http://localhost:9112',
    },
  };
  for (const key of ['a', 'b'] as const) {
    const client = makeClient(BankServiceClient, setup[key].addr);
    const startupChaos = await callUnary(client.getChaosConfig.bind(client), {}, { timeoutMs: TIMEOUT_MS });
    banks[key] = {
      client,
      db: new Pool({ connectionString: setup[key].db, max: 4 }),
      http: setup[key].http,
      startupChaos,
    };
  }
});

afterEach(async () => {
  for (const bank of Object.values(banks)) await api(bank).setChaos(bank.startupChaos);
});

afterAll(async () => {
  for (const bank of Object.values(banks)) {
    bank.client.close();
    await bank.db.end();
  }
});

interface BankApi {
  debit: (req: MoneyOperationRequest) => Promise<MoneyOperationResponse>;
  credit: (req: MoneyOperationRequest) => Promise<MoneyOperationResponse>;
  reverse: (referenceId: string) => Promise<MoneyOperationResponse>;
  resolve: (referenceId: string, operation: OperationType) => Promise<ResolveResponse>;
  getOperation: (referenceId: string, operation: OperationType) => Promise<GetOperationResponse>;
  createAccount: (
    accountId: string,
    openingBalance: bigint,
    extra?: { currency?: string; status?: string },
  ) => Promise<Account>;
  getAccount: (accountId: string) => Promise<Account>;
  setChaos: (config: ChaosConfig) => Promise<ChaosConfig>;
  getChaos: () => Promise<ChaosConfig>;
}

function api(bank: Bank, timeoutMs = TIMEOUT_MS): BankApi {
  const c = bank.client;
  const opts = { timeoutMs };
  return {
    debit: (req: MoneyOperationRequest) => callUnary(c.debit.bind(c), req, opts),
    credit: (req: MoneyOperationRequest) => callUnary(c.credit.bind(c), req, opts),
    reverse: (referenceId: string) => callUnary(c.reverseDebit.bind(c), { referenceId }, opts),
    resolve: (referenceId: string, operation: OperationType) =>
      callUnary(c.resolve.bind(c), { referenceId, operation }, opts),
    getOperation: (referenceId: string, operation: OperationType) =>
      callUnary(c.getOperation.bind(c), { referenceId, operation }, opts),
    createAccount: (accountId, openingBalance, extra = {}) =>
      callUnary(
        c.createAccount.bind(c),
        {
          accountId,
          holderName: `Holder ${accountId}`,
          openingBalance: openingBalance.toString(),
          currency: extra.currency ?? '',
          status: extra.status ?? '',
        },
        opts,
      ),
    getAccount: (accountId: string) => callUnary(c.getAccount.bind(c), { accountId }, opts),
    setChaos: (config: ChaosConfig) => callUnary(c.setChaosConfig.bind(c), config, opts),
    getChaos: () => callUnary(c.getChaosConfig.bind(c), {}, opts),
  };
}

const A = (timeoutMs?: number): BankApi => api(banks.a, timeoutMs);
const B = (timeoutMs?: number): BankApi => api(banks.b, timeoutMs);

const DEBIT = OperationType.OPERATION_TYPE_DEBIT;
const CREDIT = OperationType.OPERATION_TYPE_CREDIT;
const REVERSE = OperationType.OPERATION_TYPE_REVERSE_DEBIT;

async function newAccount(balance: bigint, extra: { currency?: string; status?: string } = {}): Promise<string> {
  const accountId = uniqueId('acct');
  await A().createAccount(accountId, balance, extra);
  return accountId;
}

function money(referenceId: string, accountId: string, amount: bigint, currency = 'INR'): MoneyOperationRequest {
  return { referenceId, accountId, amount: amount.toString(), currency };
}

async function balanceOf(accountId: string): Promise<bigint> {
  return BigInt((await A().getAccount(accountId)).balance);
}

async function caught(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('expected the call to fail');
    },
    (err: unknown) => err,
  );
}

async function expectGrpcError(promise: Promise<unknown>, code: Status, errorCode?: string): Promise<void> {
  const err = await caught(promise);
  expect((err as { code?: unknown }).code).toBe(code);
  if (errorCode !== undefined) expect(errorCodeOf(err)).toBe(errorCode);
}

async function operationRows(referenceId: string): Promise<number> {
  const { rows } = await banks.a.db.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM operations WHERE reference_id = $1',
    [referenceId],
  );
  return rows[0]?.n ?? -1;
}

const quietChaos = (overrides: Partial<ChaosConfig>): ChaosConfig => ({ ...banks.a.startupChaos, ...overrides });

describe('idempotent money operations', () => {
  it('Debit replays the original result and moves the balance once', async () => {
    const account = await newAccount(10_000n);
    const ref = uniqueId('ref');
    const first = await A().debit(money(ref, account, 2_500n));
    const second = await A().debit(money(ref, account, 2_500n));

    expect(first).toMatchObject({ status: OperationStatus.OPERATION_STATUS_APPLIED, balanceAfter: '7500' });
    expect(second.bankTxnId).toBe(first.bankTxnId);
    expect(second.appliedAt).toEqual(first.appliedAt);
    expect(second.status).toBe(OperationStatus.OPERATION_STATUS_APPLIED);
    expect(await balanceOf(account)).toBe(7_500n);
    expect(await operationRows(ref)).toBe(1);
  });

  it('Credit replays the original result and moves the balance once', async () => {
    const account = await newAccount(1_000n);
    const ref = uniqueId('ref');
    const first = await A().credit(money(ref, account, 500n));
    const second = await A().credit(money(ref, account, 500n));
    expect(first.balanceAfter).toBe('1500');
    expect(second.bankTxnId).toBe(first.bankTxnId);
    expect(await balanceOf(account)).toBe(1_500n);
  });

  it('ReverseDebit replays the original result and refunds once', async () => {
    const account = await newAccount(5_000n);
    const ref = uniqueId('ref');
    await A().debit(money(ref, account, 1_200n));
    const first = await A().reverse(ref);
    const second = await A().reverse(ref);
    expect(first.balanceAfter).toBe('5000');
    expect(second.bankTxnId).toBe(first.bankTxnId);
    expect(await balanceOf(account)).toBe(5_000n);
    expect(await operationRows(ref)).toBe(2);
  });

  it('20 concurrent identical Debits apply once', async () => {
    const account = await newAccount(10_000n);
    const ref = uniqueId('ref');
    const results = await Promise.all(Array.from({ length: 20 }, () => A().debit(money(ref, account, 300n))));
    expect(new Set(results.map((r) => r.bankTxnId)).size).toBe(1);
    expect(await balanceOf(account)).toBe(9_700n);
  });

  it('the same reference with different parameters is REFERENCE_CONFLICT', async () => {
    const account = await newAccount(10_000n);
    const other = await newAccount(10_000n);
    const ref = uniqueId('ref');
    await A().debit(money(ref, account, 100n));
    await expectGrpcError(A().debit(money(ref, account, 101n)), Status.INVALID_ARGUMENT, 'REFERENCE_CONFLICT');
    await expectGrpcError(A().debit(money(ref, other, 100n)), Status.INVALID_ARGUMENT, 'REFERENCE_CONFLICT');
    expect(await balanceOf(account)).toBe(9_900n);
    expect(await balanceOf(other)).toBe(10_000n);
  });
});

describe('business rejections', () => {
  it('insufficient funds is FAILED_PRECONDITION and leaves no operation row', async () => {
    const account = await newAccount(100n);
    const ref = uniqueId('ref');
    await expectGrpcError(A().debit(money(ref, account, 101n)), Status.FAILED_PRECONDITION, 'INSUFFICIENT_FUNDS');
    expect(await operationRows(ref)).toBe(0);
    expect(await balanceOf(account)).toBe(100n);
    // Not recorded, so the same reference can still succeed later.
    await A().debit(money(ref, account, 100n));
    expect(await balanceOf(account)).toBe(0n);
  });

  it('a missing account is NOT_FOUND / ACCOUNT_NOT_FOUND for Debit and Credit', async () => {
    const missing = uniqueId('missing');
    const ref = uniqueId('ref');
    await expectGrpcError(A().debit(money(ref, missing, 1n)), Status.NOT_FOUND, 'ACCOUNT_NOT_FOUND');
    await expectGrpcError(A().credit(money(ref, missing, 1n)), Status.NOT_FOUND, 'ACCOUNT_NOT_FOUND');
    await expectGrpcError(A().getAccount(missing), Status.NOT_FOUND, 'ACCOUNT_NOT_FOUND');
    expect(await operationRows(ref)).toBe(0);
  });

  it('a blocked account is FAILED_PRECONDITION / ACCOUNT_BLOCKED for Debit and Credit', async () => {
    const account = await newAccount(1_000n, { status: 'BLOCKED' });
    await expectGrpcError(
      A().debit(money(uniqueId('ref'), account, 1n)),
      Status.FAILED_PRECONDITION,
      'ACCOUNT_BLOCKED',
    );
    await expectGrpcError(
      A().credit(money(uniqueId('ref'), account, 1n)),
      Status.FAILED_PRECONDITION,
      'ACCOUNT_BLOCKED',
    );
    expect(await balanceOf(account)).toBe(1_000n);
  });

  it('a currency mismatch is INVALID_ARGUMENT / CURRENCY_MISMATCH for Debit and Credit', async () => {
    const account = await newAccount(1_000n, { currency: 'USD' });
    await expectGrpcError(A().debit(money(uniqueId('ref'), account, 1n)), Status.INVALID_ARGUMENT, 'CURRENCY_MISMATCH');
    await expectGrpcError(
      A().credit(money(uniqueId('ref'), account, 1n)),
      Status.INVALID_ARGUMENT,
      'CURRENCY_MISMATCH',
    );
  });

  it('ReverseDebit without an applied debit is NOTHING_TO_REVERSE', async () => {
    await expectGrpcError(A().reverse(uniqueId('ref')), Status.FAILED_PRECONDITION, 'NOTHING_TO_REVERSE');
  });

  it('ReverseDebit refunds even when the account is now BLOCKED', async () => {
    const account = await newAccount(2_000n);
    const ref = uniqueId('ref');
    await A().debit(money(ref, account, 700n));
    await banks.a.db.query(`UPDATE accounts SET status = 'BLOCKED' WHERE account_id = $1`, [account]);
    const refund = await A().reverse(ref);
    expect(refund.balanceAfter).toBe('2000');
    expect((await A().getAccount(account)).status).toBe('BLOCKED');
  });

  it('malformed requests are INVALID_ARGUMENT / INVALID_REQUEST', async () => {
    const account = await newAccount(100n);
    await expectGrpcError(A().debit(money(uniqueId('ref'), account, 0n)), Status.INVALID_ARGUMENT, 'INVALID_REQUEST');
    await expectGrpcError(A().debit(money('', account, 1n)), Status.INVALID_ARGUMENT, 'INVALID_REQUEST');
    await expectGrpcError(
      A().debit(money(uniqueId('ref'), account, 1n, 'inr')),
      Status.INVALID_ARGUMENT,
      'INVALID_REQUEST',
    );
    await expectGrpcError(A().createAccount(account, 1n), Status.ALREADY_EXISTS, 'ACCOUNT_ALREADY_EXISTS');
  });
});

describe('concurrency', () => {
  it('50 concurrent debits against funds for 10 produce exactly 10 successes', async () => {
    const account = await newAccount(1_000n);
    const results = await Promise.allSettled(
      Array.from({ length: 50 }, () => A().debit(money(uniqueId('ref'), account, 100n))),
    );
    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(ok).toHaveLength(10);
    expect(failed).toHaveLength(40);
    for (const f of failed) expect(errorCodeOf(f.reason)).toBe('INSUFFICIENT_FUNDS');
    expect(await balanceOf(account)).toBe(0n);
    const { rows } = await banks.a.db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM operations WHERE account_id = $1 AND operation = 'DEBIT'`,
      [account],
    );
    expect(rows[0]?.n).toBe(10);
  });
});

describe('Resolve', () => {
  it('a tombstone beats a later Debit: REFERENCE_VOIDED, balance untouched, answer stable', async () => {
    const account = await newAccount(1_000n);
    const ref = uniqueId('ref');
    expect((await A().resolve(ref, DEBIT)).status).toBe(OperationStatus.OPERATION_STATUS_VOIDED);
    await expectGrpcError(A().debit(money(ref, account, 100n)), Status.FAILED_PRECONDITION, 'REFERENCE_VOIDED');
    expect(await balanceOf(account)).toBe(1_000n);
    expect((await A().getOperation(ref, DEBIT)).status).toBe(OperationStatus.OPERATION_STATUS_VOIDED);
    expect((await A().resolve(ref, DEBIT)).status).toBe(OperationStatus.OPERATION_STATUS_VOIDED);
    await expectGrpcError(A().reverse(ref), Status.FAILED_PRECONDITION, 'NOTHING_TO_REVERSE');
  });

  it('a tombstone beats a later Credit too', async () => {
    const account = await newAccount(1_000n);
    const ref = uniqueId('ref');
    expect((await A().resolve(ref, CREDIT)).status).toBe(OperationStatus.OPERATION_STATUS_VOIDED);
    await expectGrpcError(A().credit(money(ref, account, 100n)), Status.FAILED_PRECONDITION, 'REFERENCE_VOIDED');
    expect(await balanceOf(account)).toBe(1_000n);
  });

  it('a committed Debit beats Resolve: APPLIED, and the answer stays APPLIED', async () => {
    const account = await newAccount(1_000n);
    const ref = uniqueId('ref');
    await A().debit(money(ref, account, 250n));
    expect((await A().resolve(ref, DEBIT)).status).toBe(OperationStatus.OPERATION_STATUS_APPLIED);
    expect((await A().resolve(ref, DEBIT)).status).toBe(OperationStatus.OPERATION_STATUS_APPLIED);
    expect(await balanceOf(account)).toBe(750n);
  });

  it('racing Debit against Resolve: the primary key picks exactly one winner every time', async () => {
    // Two separate channels, and the send order alternates, so the two calls genuinely
    // overlap in Postgres. On one channel the server takes them in send order and Debit
    // always wins, which would leave the tombstone branch untested. Measured split with
    // this setup: debit-first 96/4, resolve-first 22/78 (scratch probe, session 1).
    const resolver = makeClient(BankServiceClient, process.env.BANK_A_GRPC_ADDR ?? 'localhost:50061');
    const resolve = (ref: string): Promise<ResolveResponse> =>
      callUnary(resolver.resolve.bind(resolver), { referenceId: ref, operation: DEBIT }, { timeoutMs: TIMEOUT_MS });
    try {
      const account = await newAccount(100_000n);
      // Warm the second channel: a cold one pays connection setup, so its first calls
      // always arrive late and the tombstone never wins.
      await resolve(uniqueId('warmup'));
      const outcomes = await Promise.all(
        Array.from({ length: 60 }, async (_, i) => {
          const ref = uniqueId('race');
          const debit = (): Promise<MoneyOperationResponse> => A().debit(money(ref, account, 10n));
          const [debitResult, resolved] =
            i % 2 === 0
              ? await Promise.allSettled([debit(), resolve(ref)])
              : await Promise.allSettled([resolve(ref), debit()]).then(([r, d]) => [d, r] as const);
          if (resolved.status !== 'fulfilled') throw new Error('Resolve must not fail');
          return { debit: debitResult, resolvedStatus: resolved.value.status };
        }),
      );

      let applied = 0;
      let voided = 0;
      for (const o of outcomes) {
        if (o.debit.status === 'fulfilled') {
          applied++;
          expect(o.resolvedStatus).toBe(OperationStatus.OPERATION_STATUS_APPLIED);
        } else {
          voided++;
          expect(o.resolvedStatus).toBe(OperationStatus.OPERATION_STATUS_VOIDED);
          expect(errorCodeOf(o.debit.reason)).toBe('REFERENCE_VOIDED');
        }
      }
      // Both branches must actually have been exercised.
      expect(applied).toBeGreaterThan(0);
      expect(voided).toBeGreaterThan(0);
      expect(await balanceOf(account)).toBe(100_000n - 10n * BigInt(applied));
    } finally {
      resolver.close();
    }
  });

  it('Resolve accepts only DEBIT or CREDIT', async () => {
    await expectGrpcError(A().resolve(uniqueId('ref'), REVERSE), Status.INVALID_ARGUMENT, 'INVALID_REQUEST');
  });

  it('GetOperation reports NOT_FOUND for an unknown reference', async () => {
    const op = await A().getOperation(uniqueId('ref'), DEBIT);
    expect(op).toEqual({ status: OperationStatus.OPERATION_STATUS_NOT_FOUND, accountId: '', amount: '0' });
  });
});

describe('chaos engine', () => {
  it('down: money RPCs and lookups return UNAVAILABLE; admin RPCs keep working', async () => {
    const account = await newAccount(1_000n);
    await A().setChaos(quietChaos({ down: true }));
    const ref = uniqueId('ref');
    for (const call of [
      A().debit(money(ref, account, 1n)),
      A().credit(money(ref, account, 1n)),
      A().reverse(ref),
      A().resolve(ref, DEBIT),
      A().getOperation(ref, DEBIT),
    ]) {
      await expectGrpcError(call, Status.UNAVAILABLE, 'BANK_UNAVAILABLE');
    }
    expect((await A().getAccount(account)).balance).toBe('1000');
    await A().createAccount(uniqueId('acct'), 1n);
    expect((await A().getChaos()).down).toBe(true);
    expect(await operationRows(ref)).toBe(0);
  });

  it('reject_rate: rejected requests never touch the database, and the same seed rejects the same requests', async () => {
    const account = await newAccount(1_000_000n);
    const runPattern = async (): Promise<{ pattern: boolean[]; refs: string[] }> => {
      await A().setChaos(quietChaos({ rejectRate: 0.5, seed: 7 }));
      const refs: string[] = [];
      const pattern: boolean[] = [];
      for (let i = 0; i < 40; i++) {
        const ref = uniqueId('rej');
        refs.push(ref);
        const result = await A()
          .debit(money(ref, account, 1n))
          .then(
            () => false,
            (err: unknown) => {
              expect((err as { code?: unknown }).code).toBe(Status.UNAVAILABLE);
              return true;
            },
          );
        pattern.push(result);
      }
      await A().setChaos(banks.a.startupChaos);
      return { pattern, refs };
    };

    const first = await runPattern();
    const rejected = first.pattern.filter(Boolean).length;
    expect(rejected).toBeGreaterThan(8);
    expect(rejected).toBeLessThan(32);
    for (const [i, ref] of first.refs.entries()) {
      const op = await A().getOperation(ref, DEBIT);
      expect(op.status).toBe(
        first.pattern[i] ? OperationStatus.OPERATION_STATUS_NOT_FOUND : OperationStatus.OPERATION_STATUS_APPLIED,
      );
    }
    const second = await runPattern();
    expect(second.pattern).toEqual(first.pattern);
    expect(await balanceOf(account)).toBe(1_000_000n - BigInt(80 - rejected * 2));
  });

  it('late_apply_rate: the client times out, then the debit applies after slow_ms', async () => {
    const account = await newAccount(1_000n);
    const ref = uniqueId('ref');
    await A().setChaos(quietChaos({ lateApplyRate: 1, slowMs: SLOW_MS }));
    const started = Date.now();
    await expectGrpcError(A(SHORT_DEADLINE_MS).debit(money(ref, account, 100n)), Status.DEADLINE_EXCEEDED);
    expect((await A().getOperation(ref, DEBIT)).status).toBe(OperationStatus.OPERATION_STATUS_NOT_FOUND);
    expect(await balanceOf(account)).toBe(1_000n);

    await sleep(Math.max(0, SLOW_MS - (Date.now() - started)) + 700);
    expect((await A().getOperation(ref, DEBIT)).status).toBe(OperationStatus.OPERATION_STATUS_APPLIED);
    expect(await balanceOf(account)).toBe(900n);
  });

  it('late_apply_rate + Resolve: the tombstone wins, so the late debit never applies', async () => {
    const account = await newAccount(1_000n);
    const ref = uniqueId('ref');
    await A().setChaos(quietChaos({ lateApplyRate: 1, slowMs: SLOW_MS }));
    const started = Date.now();
    await expectGrpcError(A(SHORT_DEADLINE_MS).debit(money(ref, account, 100n)), Status.DEADLINE_EXCEEDED);
    // Resolve honours only down, latency and reject_rate, so it answers at once.
    expect((await A().resolve(ref, DEBIT)).status).toBe(OperationStatus.OPERATION_STATUS_VOIDED);

    await sleep(Math.max(0, SLOW_MS - (Date.now() - started)) + 700);
    expect((await A().getOperation(ref, DEBIT)).status).toBe(OperationStatus.OPERATION_STATUS_VOIDED);
    expect(await balanceOf(account)).toBe(1_000n);
  });

  it('lost_response_rate: the debit commits but the client times out; a replay returns it once', async () => {
    const account = await newAccount(1_000n);
    const ref = uniqueId('ref');
    await A().setChaos(quietChaos({ lostResponseRate: 1, slowMs: SLOW_MS }));
    await expectGrpcError(A(SHORT_DEADLINE_MS).debit(money(ref, account, 100n)), Status.DEADLINE_EXCEEDED);
    expect((await A().getOperation(ref, DEBIT)).status).toBe(OperationStatus.OPERATION_STATUS_APPLIED);
    expect(await balanceOf(account)).toBe(900n);
    expect((await A().resolve(ref, DEBIT)).status).toBe(OperationStatus.OPERATION_STATUS_APPLIED);

    await A().setChaos(banks.a.startupChaos);
    const replay = await A().debit(money(ref, account, 100n));
    expect(replay.status).toBe(OperationStatus.OPERATION_STATUS_APPLIED);
    expect(await balanceOf(account)).toBe(900n);
  });

  it('Resolve and GetOperation ignore late_apply and lost_response', async () => {
    await A().setChaos(quietChaos({ lateApplyRate: 0.5, lostResponseRate: 0.5, slowMs: SLOW_MS }));
    const started = Date.now();
    for (let i = 0; i < 10; i++) {
      await A(SHORT_DEADLINE_MS).resolve(uniqueId('ref'), DEBIT);
      await A(SHORT_DEADLINE_MS).getOperation(uniqueId('ref'), DEBIT);
    }
    expect(Date.now() - started).toBeLessThan(SHORT_DEADLINE_MS * 2);
  });

  it('latency: every chaos-affected call waits within [latency_min_ms, latency_max_ms]', async () => {
    await A().setChaos(quietChaos({ latencyMinMs: 150, latencyMaxMs: 250 }));
    for (let i = 0; i < 6; i++) {
      const started = Date.now();
      await A().getOperation(uniqueId('ref'), DEBIT);
      const elapsed = Date.now() - started;
      expect(elapsed).toBeGreaterThanOrEqual(150);
      expect(elapsed).toBeLessThan(250 + 150);
    }
    const started = Date.now();
    await A().getChaos();
    expect(Date.now() - started).toBeLessThan(100);
  });

  it('SetChaosConfig rejects rates summing above 1 and keeps the old config', async () => {
    const before = await A().getChaos();
    await expectGrpcError(
      A().setChaos(quietChaos({ rejectRate: 0.5, lateApplyRate: 0.4, lostResponseRate: 0.2 })),
      Status.INVALID_ARGUMENT,
      'CHAOS_CONFIG_INVALID',
    );
    expect(await A().getChaos()).toEqual(before);
  });

  it('SetChaosConfig rejects a slow_ms that is not slower than the client deadline (ADR-016)', async () => {
    await expectGrpcError(
      A().setChaos(quietChaos({ lateApplyRate: 0.1, slowMs: 2_000 })),
      Status.INVALID_ARGUMENT,
      'CHAOS_CONFIG_INVALID',
    );
  });
});

describe('two independent instances', () => {
  it('bank_a and bank_b have separate databases', async () => {
    const account = await newAccount(1n);
    await expectGrpcError(B().getAccount(account), Status.NOT_FOUND, 'ACCOUNT_NOT_FOUND');
  });

  it('a transfer id used on both banks is independent per bank', async () => {
    const payer = await newAccount(1_000n);
    const payee = uniqueId('payee');
    await B().createAccount(payee, 0n);
    const transferId = uniqueId('transfer');
    await A().debit(money(transferId, payer, 400n));
    const credited = await B().credit(money(transferId, payee, 400n));
    expect(credited.balanceAfter).toBe('400');
    expect(await balanceOf(payer)).toBe(600n);
  });
});

describe('database guarantees and observability', () => {
  it('a balance can never go negative (CHECK constraint)', async () => {
    const account = await newAccount(5n);
    await expect(banks.a.db.query('UPDATE accounts SET balance = -1 WHERE account_id = $1', [account])).rejects.toThrow(
      /accounts_balance_check/,
    );
  });

  it('an APPLIED operation must carry an account and amount (applied_has_money)', async () => {
    await expect(
      banks.a.db.query(`INSERT INTO operations (reference_id, operation, status) VALUES ($1, 'DEBIT', 'APPLIED')`, [
        uniqueId('raw'),
      ]),
    ).rejects.toThrow(/applied_has_money/);
  });

  it('serves health and the bank metrics on each instance', async () => {
    for (const bank of Object.values(banks)) {
      expect((await fetch(`${bank.http}/readyz`)).status).toBe(200);
    }
    const body = await (await fetch(`${banks.a.http}/metrics`)).text();
    expect(body).toMatch(/bank_operations_total\{[^}]*operation="DEBIT"[^}]*result="APPLIED"[^}]*\} \d+/);
    expect(body).toMatch(/bank_operations_total\{[^}]*operation="RESOLVE"[^}]*result="VOIDED"[^}]*\} \d+/);
    for (const mode of ['down', 'reject', 'late_apply', 'lost_response', 'latency']) {
      expect(body).toMatch(new RegExp(`chaos_injected_total\\{[^}]*mode="${mode}"[^}]*\\} \\d+`));
    }
    expect(body).toContain('bank_id="bank_a"');
  });
});
