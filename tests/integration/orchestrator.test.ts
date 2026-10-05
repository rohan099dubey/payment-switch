/**
 * M3 acceptance: the Orchestrator over real gRPC, driving the real banks and Ledger,
 * plus SQL reads of `orchestrator_db` for the `transfer_events` trail. Needs the stack:
 * `npm run stack:up` (chaos off, the Compose default).
 *
 * Accounts, clients and idempotency keys are unique per run, and ledger assertions
 * compare before/after deltas, so the suite re-runs on a populated stack.
 */
import { randomUUID } from 'node:crypto';
import { status as Status } from '@grpc/grpc-js';
import { callUnary, errorCodeOf, makeClient } from '@switch/common';
import { BankServiceClient, OperationStatus, OperationType } from '@switch/proto-gen/bank/v1';
import { EntryDirection, LedgerServiceClient } from '@switch/proto-gen/ledger/v1';
import {
  TransferServiceClient,
  TransferState,
  type CreateTransferRequest,
  type CreateTransferResponse,
  type Transfer,
} from '@switch/proto-gen/orchestrator/v1';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { awaitTerminal } from '../helpers/transfers';

const ORCH_ADDR = process.env.ORCHESTRATOR_GRPC_ADDR ?? 'localhost:50051';
const ORCH_HTTP = process.env.ORCHESTRATOR_HTTP_URL ?? 'http://localhost:9101';
const ORCH_DB = process.env.ORCHESTRATOR_DATABASE_URL ?? 'postgres://orch:orch@localhost:5433/orchestrator_db';
const BANK_A_ADDR = process.env.BANK_A_GRPC_ADDR ?? 'localhost:50061';
const BANK_B_ADDR = process.env.BANK_B_GRPC_ADDR ?? 'localhost:50062';
const LEDGER_ADDR = process.env.LEDGER_GRPC_ADDR ?? 'localhost:50052';
/** The Gateway's CreateTransfer deadline (section 14); the Orchestrator must answer within it. */
const CREATE_TIMEOUT_MS = 10_000;
const TIMEOUT_MS = 5_000;

const RUN = randomUUID().slice(0, 8);
let counter = 0;
const uniqueId = (prefix: string): string => `m3-${RUN}-${prefix}-${++counter}`;
/** Each test uses its own client id, so idempotency keys never collide across tests. */
const CLIENT = `m3-${RUN}-client`;

let orch: TransferServiceClient;
let bankA: BankServiceClient;
let bankB: BankServiceClient;
let ledger: LedgerServiceClient;
let db: Pool;

beforeAll(() => {
  orch = makeClient(TransferServiceClient, ORCH_ADDR);
  bankA = makeClient(BankServiceClient, BANK_A_ADDR);
  bankB = makeClient(BankServiceClient, BANK_B_ADDR);
  ledger = makeClient(LedgerServiceClient, LEDGER_ADDR);
  db = new Pool({ connectionString: ORCH_DB, max: 4 });
});

afterAll(async () => {
  for (const c of [orch, bankA, bankB, ledger]) c.close();
  await db.end();
});

// ---------------------------------------------------------------- helpers

const bankOf = (bankId: string): BankServiceClient => (bankId === 'bank_a' ? bankA : bankB);

async function newAccount(bankId: 'bank_a' | 'bank_b', balance: bigint, status = ''): Promise<string> {
  const accountId = uniqueId(`acct-${bankId}`);
  const c = bankOf(bankId);
  await callUnary(
    c.createAccount.bind(c),
    { accountId, holderName: `Holder ${accountId}`, openingBalance: balance.toString(), currency: 'INR', status },
    { timeoutMs: TIMEOUT_MS },
  );
  return accountId;
}

async function balanceOf(bankId: string, accountId: string): Promise<bigint> {
  const c = bankOf(bankId);
  const account = await callUnary(c.getAccount.bind(c), { accountId }, { timeoutMs: TIMEOUT_MS });
  return BigInt(account.balance);
}

async function operationStatus(
  bankId: string,
  referenceId: string,
  operation: OperationType,
): Promise<OperationStatus> {
  const c = bankOf(bankId);
  return (await callUnary(c.getOperation.bind(c), { referenceId, operation }, { timeoutMs: TIMEOUT_MS })).status;
}

async function ledgerBalances(): Promise<Record<string, bigint>> {
  const trial = await callUnary(ledger.getTrialBalance.bind(ledger), {}, { timeoutMs: TIMEOUT_MS });
  return Object.fromEntries(trial.accounts.map((a) => [a.accountCode, BigInt(a.balance)]));
}

async function ledgerDelta<T>(fn: () => Promise<T>): Promise<{ result: T; delta: Record<string, bigint> }> {
  const before = await ledgerBalances();
  const result = await fn();
  const after = await ledgerBalances();
  const delta: Record<string, bigint> = {};
  for (const code of Object.keys(after)) {
    const change = (after[code] ?? 0n) - (before[code] ?? 0n);
    if (change !== 0n) delta[code] = change;
  }
  return { result, delta };
}

async function journalsFor(transferId: string): Promise<{ kind: string; lines: string[] }[]> {
  const res = await callUnary(ledger.listJournals.bind(ledger), { referenceId: transferId }, { timeoutMs: TIMEOUT_MS });
  return res.journals.map((j) => ({
    kind: j.kind,
    lines: j.lines.map(
      (l) => `${l.direction === EntryDirection.ENTRY_DIRECTION_DEBIT ? 'Dr' : 'Cr'} ${l.accountCode} ${l.amount}`,
    ),
  }));
}

interface EventRow {
  from_state: string | null;
  to_state: string;
  reason: string;
  detail: Record<string, unknown>;
}

async function eventsFor(transferId: string): Promise<EventRow[]> {
  const res = await db.query<EventRow>(
    'SELECT from_state, to_state, reason, detail FROM transfer_events WHERE transfer_id = $1 ORDER BY id',
    [transferId],
  );
  return res.rows;
}

interface TransferRow {
  state: string;
  version: number;
  attempts: number;
  lease_owner: string | null;
  lease_expires_at: Date | null;
  failure_code: string | null;
  amount: string;
}

async function rowOf(transferId: string): Promise<TransferRow | undefined> {
  const res = await db.query<TransferRow>(
    'SELECT state, version, attempts, lease_owner, lease_expires_at, failure_code, amount FROM transfers WHERE id = $1',
    [transferId],
  );
  return res.rows[0];
}

function request(
  overrides: Partial<CreateTransferRequest> & { payerAccount?: string; payeeAccount?: string },
): CreateTransferRequest {
  const { payerAccount = 'none', payeeAccount = 'none', ...rest } = overrides;
  return {
    clientId: CLIENT,
    idempotencyKey: uniqueId('key'),
    payer: { bankId: 'bank_a', accountId: payerAccount },
    payee: { bankId: 'bank_b', accountId: payeeAccount },
    amount: '12500',
    currency: 'INR',
    note: '',
    ...rest,
  };
}

function create(req: CreateTransferRequest, client: TransferServiceClient = orch): Promise<CreateTransferResponse> {
  return callUnary(client.createTransfer.bind(client), req, { timeoutMs: CREATE_TIMEOUT_MS });
}

/** Create, then wait for a terminal state (ADR-010: the create call may legitimately return early). */
async function transfer(req: CreateTransferRequest): Promise<{ response: CreateTransferResponse; final: Transfer }> {
  const response = await create(req);
  if (response.transfer === undefined) throw new Error('CreateTransfer returned no transfer');
  return { response, final: await awaitTerminal(orch, req.clientId, response.transfer) };
}

async function rejection(
  promise: Promise<unknown>,
): Promise<{ code: number | undefined; errorCode: string | undefined }> {
  try {
    await promise;
  } catch (err) {
    return { code: (err as { code?: number }).code, errorCode: errorCodeOf(err) };
  }
  throw new Error('expected the call to fail');
}

const trail = (events: EventRow[]): string[] =>
  events.map((e) => `${e.from_state ?? 'NULL'}->${e.to_state}:${e.reason}`);

/** Invariants of any trail: starts at NULL->INITIATED, each from equals the previous to, one event per version. */
function expectWellFormedTrail(events: EventRow[], row: TransferRow | undefined): void {
  expect(events[0]?.from_state).toBeNull();
  expect(events[0]?.to_state).toBe('INITIATED');
  for (let i = 1; i < events.length; i++) expect(events[i]?.from_state).toBe(events[i - 1]?.to_state);
  expect(row?.state).toBe(events.at(-1)?.to_state);
  // version starts at 1 on INITIATED and goes up by one per CAS.
  expect(row?.version).toBe(events.length);
}

// ---------------------------------------------------------------- tests

describe('CreateTransfer — SUCCESS', () => {
  it('moves 12,500 paise from bank_a to bank_b, posts both legs, and transit returns to where it was', async () => {
    const payer = await newAccount('bank_a', 100_000n);
    const payee = await newAccount('bank_b', 5_000n);

    const { result, delta } = await ledgerDelta(() =>
      transfer(request({ payerAccount: payer, payeeAccount: payee, note: 'rent' })),
    );
    const { response, final } = result;

    expect(response.replayed).toBe(false);
    // Chaos is off, so the inline saga finishes: the create call itself is terminal (the 201 case).
    expect(response.transfer?.state).toBe(TransferState.TRANSFER_STATE_SUCCESS);
    expect(final).toMatchObject({
      state: TransferState.TRANSFER_STATE_SUCCESS,
      payer: { bankId: 'bank_a', accountId: payer },
      payee: { bankId: 'bank_b', accountId: payee },
      amount: '12500',
      currency: 'INR',
      note: 'rent',
      failureCode: '',
      failureMessage: '',
    });

    expect(await balanceOf('bank_a', payer)).toBe(87_500n);
    expect(await balanceOf('bank_b', payee)).toBe(17_500n);
    expect(delta).toEqual({ 'receivable:bank_a': 12_500n, 'payable:bank_b': 12_500n });

    const id = final.transferId;
    expect(await journalsFor(id)).toEqual([
      { kind: 'TRANSFER_DEBIT_LEG', lines: ['Dr receivable:bank_a 12500', 'Cr transit 12500'] },
      { kind: 'TRANSFER_CREDIT_LEG', lines: ['Dr transit 12500', 'Cr payable:bank_b 12500'] },
    ]);
    expect(await operationStatus('bank_a', id, OperationType.OPERATION_TYPE_DEBIT)).toBe(
      OperationStatus.OPERATION_STATUS_APPLIED,
    );
    expect(await operationStatus('bank_b', id, OperationType.OPERATION_TYPE_CREDIT)).toBe(
      OperationStatus.OPERATION_STATUS_APPLIED,
    );
    expect(await operationStatus('bank_a', id, OperationType.OPERATION_TYPE_REVERSE_DEBIT)).toBe(
      OperationStatus.OPERATION_STATUS_NOT_FOUND,
    );
  });

  it('writes the complete transfer_events trail and leaves the row unleased', async () => {
    const payer = await newAccount('bank_a', 50_000n);
    const payee = await newAccount('bank_b', 0n);
    const { final } = await transfer(request({ payerAccount: payer, payeeAccount: payee }));

    const events = await eventsFor(final.transferId);
    const row = await rowOf(final.transferId);
    expect(trail(events)).toEqual([
      'NULL->INITIATED:TRANSFER_CREATED',
      'INITIATED->DEBIT_SENT:DEBIT_INTENT',
      'DEBIT_SENT->DEBITED:DEBIT_CONFIRMED',
      'DEBITED->CREDIT_SENT:CREDIT_INTENT',
      'CREDIT_SENT->CREDITED:CREDIT_CONFIRMED',
      'CREDITED->SUCCESS:TRANSFER_COMPLETED',
    ]);
    expectWellFormedTrail(events, row);
    expect(row).toMatchObject({
      attempts: 0,
      lease_owner: null,
      lease_expires_at: null,
      failure_code: null,
      amount: '12500',
    });
    // The confirming events carry the evidence: the bank transaction and the journal.
    for (const confirming of [events[2], events[4]]) {
      expect(typeof confirming?.detail.bank_txn_id).toBe('string');
      expect(typeof confirming?.detail.journal_id).toBe('string');
    }
  });

  it('allows two accounts at the same bank', async () => {
    const payer = await newAccount('bank_a', 20_000n);
    const payee = await newAccount('bank_a', 0n);
    const { final } = await transfer(request({ payerAccount: payer, payee: { bankId: 'bank_a', accountId: payee } }));
    expect(final.state).toBe(TransferState.TRANSFER_STATE_SUCCESS);
    expect(await balanceOf('bank_a', payee)).toBe(12_500n);
  });
});

describe('CreateTransfer — FAILED (definite debit failures)', () => {
  it('insufficient funds: FAILED / INSUFFICIENT_FUNDS as gRPC OK, nothing moved, nothing posted', async () => {
    const payer = await newAccount('bank_a', 100n);
    const payee = await newAccount('bank_b', 0n);

    // `transfer` awaits the call: a gRPC error would throw here. Business failures are OK + failure_code.
    const { result, delta } = await ledgerDelta(() => transfer(request({ payerAccount: payer, payeeAccount: payee })));
    const { response, final } = result;

    expect(response.transfer?.state).toBe(TransferState.TRANSFER_STATE_FAILED);
    expect(final.state).toBe(TransferState.TRANSFER_STATE_FAILED);
    expect(final.failureCode).toBe('INSUFFICIENT_FUNDS');
    expect(final.failureMessage).not.toBe('');
    expect(await balanceOf('bank_a', payer)).toBe(100n);
    expect(await balanceOf('bank_b', payee)).toBe(0n);
    expect(delta).toEqual({});
    expect(await journalsFor(final.transferId)).toEqual([]);
    // The bank rolled the rejection back completely: no operation row.
    expect(await operationStatus('bank_a', final.transferId, OperationType.OPERATION_TYPE_DEBIT)).toBe(
      OperationStatus.OPERATION_STATUS_NOT_FOUND,
    );

    const events = await eventsFor(final.transferId);
    expect(trail(events)).toEqual([
      'NULL->INITIATED:TRANSFER_CREATED',
      'INITIATED->DEBIT_SENT:DEBIT_INTENT',
      'DEBIT_SENT->FAILED:INSUFFICIENT_FUNDS',
    ]);
    expectWellFormedTrail(events, await rowOf(final.transferId));
    expect(events[2]?.detail).toMatchObject({ error_code: 'INSUFFICIENT_FUNDS', bank_id: 'bank_a' });
  });

  it('missing payer account: FAILED / PAYER_ACCOUNT_NOT_FOUND', async () => {
    const payee = await newAccount('bank_b', 0n);
    const { final } = await transfer(request({ payerAccount: uniqueId('missing'), payeeAccount: payee }));
    expect(final.state).toBe(TransferState.TRANSFER_STATE_FAILED);
    expect(final.failureCode).toBe('PAYER_ACCOUNT_NOT_FOUND');
    expect(await journalsFor(final.transferId)).toEqual([]);
  });

  it('blocked payer account: FAILED / PAYER_ACCOUNT_BLOCKED', async () => {
    const payer = await newAccount('bank_a', 100_000n, 'BLOCKED');
    const payee = await newAccount('bank_b', 0n);
    const { final } = await transfer(request({ payerAccount: payer, payeeAccount: payee }));
    expect(final.failureCode).toBe('PAYER_ACCOUNT_BLOCKED');
    expect(await balanceOf('bank_a', payer)).toBe(100_000n);
  });
});

describe('CreateTransfer — REVERSED (definite credit failures)', () => {
  it('missing payee account: REVERSING then REVERSED / PAYEE_ACCOUNT_NOT_FOUND, payer refunded', async () => {
    const payer = await newAccount('bank_a', 40_000n);
    const missingPayee = uniqueId('missing');

    const { result, delta } = await ledgerDelta(() =>
      transfer(request({ payerAccount: payer, payeeAccount: missingPayee })),
    );
    const { response, final } = result;

    expect(response.transfer?.state).toBe(TransferState.TRANSFER_STATE_REVERSED);
    expect(final.state).toBe(TransferState.TRANSFER_STATE_REVERSED);
    expect(final.failureCode).toBe('PAYEE_ACCOUNT_NOT_FOUND');
    expect(await balanceOf('bank_a', payer)).toBe(40_000n);
    // The debit leg and its exact reversal cancel out: no net movement anywhere.
    expect(delta).toEqual({});

    const id = final.transferId;
    expect(await journalsFor(id)).toEqual([
      { kind: 'TRANSFER_DEBIT_LEG', lines: ['Dr receivable:bank_a 12500', 'Cr transit 12500'] },
      { kind: 'TRANSFER_REVERSAL', lines: ['Dr transit 12500', 'Cr receivable:bank_a 12500'] },
    ]);
    expect(await operationStatus('bank_a', id, OperationType.OPERATION_TYPE_DEBIT)).toBe(
      OperationStatus.OPERATION_STATUS_APPLIED,
    );
    expect(await operationStatus('bank_a', id, OperationType.OPERATION_TYPE_REVERSE_DEBIT)).toBe(
      OperationStatus.OPERATION_STATUS_APPLIED,
    );
    expect(await operationStatus('bank_b', id, OperationType.OPERATION_TYPE_CREDIT)).toBe(
      OperationStatus.OPERATION_STATUS_NOT_FOUND,
    );

    const events = await eventsFor(id);
    expect(trail(events)).toEqual([
      'NULL->INITIATED:TRANSFER_CREATED',
      'INITIATED->DEBIT_SENT:DEBIT_INTENT',
      'DEBIT_SENT->DEBITED:DEBIT_CONFIRMED',
      'DEBITED->CREDIT_SENT:CREDIT_INTENT',
      'CREDIT_SENT->REVERSING:PAYEE_ACCOUNT_NOT_FOUND',
      'REVERSING->REVERSED:REVERSAL_CONFIRMED',
    ]);
    const row = await rowOf(id);
    expectWellFormedTrail(events, row);
    expect(row).toMatchObject({ lease_owner: null, lease_expires_at: null, failure_code: 'PAYEE_ACCOUNT_NOT_FOUND' });
    expect(events[4]?.detail).toMatchObject({ error_code: 'ACCOUNT_NOT_FOUND', bank_id: 'bank_b' });
  });

  it('blocked payee account: REVERSED / PAYEE_ACCOUNT_BLOCKED, payer refunded', async () => {
    const payer = await newAccount('bank_a', 30_000n);
    const payee = await newAccount('bank_b', 0n, 'BLOCKED');
    const { final } = await transfer(request({ payerAccount: payer, payeeAccount: payee }));
    expect(final.state).toBe(TransferState.TRANSFER_STATE_REVERSED);
    expect(final.failureCode).toBe('PAYEE_ACCOUNT_BLOCKED');
    expect(await balanceOf('bank_a', payer)).toBe(30_000n);
    expect(await balanceOf('bank_b', payee)).toBe(0n);
  });
});

describe('CreateTransfer — validation (INVALID_ARGUMENT, nothing registered)', () => {
  it.each([
    ['SAME_ACCOUNT', { payee: { bankId: 'bank_a', accountId: 'same' }, payerAccount: 'same' }],
    ['UNKNOWN_BANK', { payee: { bankId: 'bank_z', accountId: 'x' } }],
    ['INVALID_AMOUNT', { amount: '0' }],
    ['INVALID_AMOUNT', { amount: '-5' }],
    ['INVALID_AMOUNT', { amount: '10000001' }],
    ['UNSUPPORTED_CURRENCY', { currency: 'USD' }],
    ['INVALID_REQUEST', { idempotencyKey: '' }],
    ['INVALID_REQUEST', { clientId: '' }],
  ] as const)('%s for %j', async (errorCode, overrides) => {
    const req = request(overrides);
    expect(await rejection(create(req))).toEqual({ code: Status.INVALID_ARGUMENT, errorCode });
    const rows = await db.query('SELECT 1 FROM transfers WHERE client_id = $1 AND idempotency_key = $2', [
      req.clientId,
      req.idempotencyKey,
    ]);
    expect(rows.rowCount).toBe(0);
  });
});

describe('GetTransfer', () => {
  it('returns the transfer to its owner, and NOT_FOUND to anyone else', async () => {
    const payer = await newAccount('bank_a', 20_000n);
    const payee = await newAccount('bank_b', 0n);
    const { final } = await transfer(request({ payerAccount: payer, payeeAccount: payee }));

    const own = await callUnary(
      orch.getTransfer.bind(orch),
      { transferId: final.transferId, clientId: CLIENT },
      { timeoutMs: TIMEOUT_MS },
    );
    expect(own).toEqual(final);

    const other = callUnary(
      orch.getTransfer.bind(orch),
      { transferId: final.transferId, clientId: `${CLIENT}-other` },
      { timeoutMs: TIMEOUT_MS },
    );
    expect(await rejection(other)).toEqual({ code: Status.NOT_FOUND, errorCode: 'TRANSFER_NOT_FOUND' });
  });

  it.each(['not-a-uuid', randomUUID(), ''])('NOT_FOUND for transfer id %j', async (transferId) => {
    const call = callUnary(orch.getTransfer.bind(orch), { transferId, clientId: CLIENT }, { timeoutMs: TIMEOUT_MS });
    expect(await rejection(call)).toEqual({ code: Status.NOT_FOUND, errorCode: 'TRANSFER_NOT_FOUND' });
  });
});

describe('CreateTransfer — duplicate idempotency key', () => {
  it('the same body replays the same transfer without driving it again', async () => {
    const payer = await newAccount('bank_a', 20_000n);
    const payee = await newAccount('bank_b', 0n);
    const req = request({ payerAccount: payer, payeeAccount: payee });
    const first = await transfer(req);
    const again = await create(req);

    expect(again.replayed).toBe(true);
    expect(again.transfer).toEqual(first.final);
    expect(await balanceOf('bank_a', payer)).toBe(7_500n);
    expect(await eventsFor(first.final.transferId)).toHaveLength(6);
  });

  it('a different body returns ALREADY_EXISTS / IDEMPOTENCY_KEY_REUSED', async () => {
    const payer = await newAccount('bank_a', 20_000n);
    const payee = await newAccount('bank_b', 0n);
    const req = request({ payerAccount: payer, payeeAccount: payee });
    await transfer(req);
    expect(await rejection(create({ ...req, amount: '12501' }))).toEqual({
      code: Status.ALREADY_EXISTS,
      errorCode: 'IDEMPOTENCY_KEY_REUSED',
    });
  });

  it('two clients using the same key string get two transfers', async () => {
    const payer = await newAccount('bank_a', 30_000n);
    const payee = await newAccount('bank_b', 0n);
    const req = request({ payerAccount: payer, payeeAccount: payee });
    const a = await transfer(req);
    const b = await transfer({ ...req, clientId: `${CLIENT}-second` });
    expect(a.final.transferId).not.toBe(b.final.transferId);
    expect(b.response.replayed).toBe(false);
    expect(await balanceOf('bank_a', payer)).toBe(5_000n);
  });
});

describe('Orchestrator metrics', () => {
  it('exposes the section 17 orchestrator metrics after transfers ran', async () => {
    const body = await (await fetch(`${ORCH_HTTP}/metrics`)).text();
    expect(body).toMatch(/^transfers_total\{final_state="SUCCESS"\} [1-9]/m);
    expect(body).toMatch(/^transfers_total\{final_state="FAILED"\} [1-9]/m);
    expect(body).toMatch(/^transfers_total\{final_state="REVERSED"\} [1-9]/m);
    expect(body).toMatch(/^transfer_duration_seconds_count\{final_state="SUCCESS"\} [1-9]/m);
    for (const step of ['debit', 'credit', 'reverse', 'ledger']) {
      expect(body).toMatch(new RegExp(`^saga_step_duration_seconds_count\\{step="${step}"\\} [1-9]`, 'm'));
    }
    expect(body).toMatch(/^downstream_calls_total\{target="bank",operation="Debit",outcome="ok"\} [1-9]/m);
    expect(body).toMatch(/^downstream_calls_total\{target="bank",operation="Debit",outcome="definite"\} [1-9]/m);
    expect(body).toMatch(/^downstream_calls_total\{target="ledger",operation="PostJournal",outcome="ok"\} [1-9]/m);
    expect(body).toMatch(/^grpc_requests_total\{method="CreateTransfer",code="OK"\} [1-9]/m);
  });

  it('health endpoints answer', async () => {
    expect((await fetch(`${ORCH_HTTP}/healthz`)).status).toBe(200);
    expect((await fetch(`${ORCH_HTTP}/readyz`)).status).toBe(200);
  });
});
