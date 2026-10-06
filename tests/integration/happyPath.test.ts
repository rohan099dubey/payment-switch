/**
 * M4 acceptance, section 16 `happyPath`: transfers through the public HTTP API, end to end
 * (Gateway -> Orchestrator -> banks + Ledger). Needs the stack with chaos off.
 *
 * Accounts and keys are unique per run; ledger assertions compare deltas.
 */
import { randomUUID } from 'node:crypto';
import { callUnary, makeClient, sleep } from '@switch/common';
import { LedgerServiceClient } from '@switch/proto-gen/ledger/v1';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BankAdmin, type BankId } from '../helpers/bankAdmin';
import { DEV_CLIENTS, GatewayClient, type HttpResult } from '../helpers/gatewayClient';

const RUN = randomUUID().slice(0, 8);
let counter = 0;
const uniqueId = (prefix: string): string => `m4-${RUN}-${prefix}-${++counter}`;
const newKey = (): string => `m4-${RUN}-key-${++counter}`;

const LEDGER_ADDR = process.env.LEDGER_GRPC_ADDR ?? 'localhost:50052';
let banks: BankAdmin;
let ledger: LedgerServiceClient;
const client = GatewayClient.for(DEV_CLIENTS.a);
const otherClient = GatewayClient.for(DEV_CLIENTS.b);

beforeAll(() => {
  banks = new BankAdmin();
  ledger = makeClient(LedgerServiceClient, LEDGER_ADDR);
});

afterAll(() => {
  banks.close();
  ledger.close();
});

async function account(bank: BankId, balance: bigint, status = ''): Promise<string> {
  const id = uniqueId(bank === 'bank_a' ? 'A' : 'B');
  await banks.createAccount(bank, id, balance, status);
  return id;
}

function body(
  payer: [BankId, string],
  payee: [BankId, string],
  amount = 12_500,
  note?: string,
): Record<string, unknown> {
  return {
    payer: { bank_id: payer[0], account_id: payer[1] },
    payee: { bank_id: payee[0], account_id: payee[1] },
    amount,
    currency: 'INR',
    ...(note === undefined ? {} : { note }),
  };
}

async function journalKinds(transferId: string): Promise<string[]> {
  const res = await callUnary(ledger.listJournals.bind(ledger), { referenceId: transferId }, { timeoutMs: 5000 });
  return res.journals.map((j) => j.kind);
}

async function trial(): Promise<Record<string, bigint>> {
  const t = await callUnary(ledger.getTrialBalance.bind(ledger), {}, { timeoutMs: 5000 });
  return Object.fromEntries(t.accounts.map((a) => [a.accountCode, BigInt(a.balance)]));
}

const idOf = (res: HttpResult): string => res.body.id as string;

describe('happyPath — through the Gateway', () => {
  it('a cross-bank transfer: 201 SUCCEEDED, both balances move by exactly the amount, two journals', async () => {
    const payer = await account('bank_a', 100_000n);
    const payee = await account('bank_b', 1_000n);
    const before = await trial();

    const res = await client.createTransfer(body(['bank_a', payer], ['bank_b', payee], 12_500, 'rent'), newKey());

    expect(res.status).toBe(201);
    expect(res.headers.get('idempotent-replay')).toBeNull();
    expect(res.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.body).toMatchObject({
      status: 'SUCCEEDED',
      state: 'SUCCESS',
      payer: { bank_id: 'bank_a', account_id: payer },
      payee: { bank_id: 'bank_b', account_id: payee },
      amount: 12_500,
      currency: 'INR',
      note: 'rent',
      failure_code: null,
      failure_message: null,
    });
    expect(res.body.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(Date.parse(res.body.created_at as string)).not.toBeNaN();

    expect(await banks.balance('bank_a', payer)).toBe(87_500n);
    expect(await banks.balance('bank_b', payee)).toBe(13_500n);
    expect(await journalKinds(idOf(res))).toEqual(['TRANSFER_DEBIT_LEG', 'TRANSFER_CREDIT_LEG']);
    const after = await trial();
    expect((after.transit ?? 0n) - (before.transit ?? 0n)).toBe(0n);
    expect((after['receivable:bank_a'] ?? 0n) - (before['receivable:bank_a'] ?? 0n)).toBe(12_500n);
    expect((after['payable:bank_b'] ?? 0n) - (before['payable:bank_b'] ?? 0n)).toBe(12_500n);
  });

  it('a same-bank transfer also works', async () => {
    const payer = await account('bank_b', 50_000n);
    const payee = await account('bank_b', 0n);
    const res = await client.createTransfer(body(['bank_b', payer], ['bank_b', payee], 20_000), newKey());
    expect(res.status).toBe(201);
    expect(await banks.balance('bank_b', payer)).toBe(30_000n);
    expect(await banks.balance('bank_b', payee)).toBe(20_000n);
    expect(await journalKinds(idOf(res))).toEqual(['TRANSFER_DEBIT_LEG', 'TRANSFER_CREDIT_LEG']);
  });

  it('GET /v1/transfers/{id} returns the same resource to its creator and 404 to anyone else', async () => {
    const payer = await account('bank_a', 20_000n);
    const payee = await account('bank_b', 0n);
    const created = await client.createTransfer(body(['bank_a', payer], ['bank_b', payee]), newKey());

    const own = await client.getTransfer(idOf(created));
    expect(own.status).toBe(200);
    expect(own.body).toEqual(created.body);

    const other = await otherClient.getTransfer(idOf(created));
    expect(other.status).toBe(404);
    expect(other.body).toMatchObject({ error: { code: 'TRANSFER_NOT_FOUND' } });
  });

  it('a replay is 200 with Idempotent-Replay: true, the same id, and no second debit', async () => {
    const payer = await account('bank_a', 20_000n);
    const payee = await account('bank_b', 0n);
    const key = newKey();
    const req = body(['bank_a', payer], ['bank_b', payee]);
    const first = await client.createTransfer(req, key);
    const again = await client.createTransfer(req, key);

    expect(first.status).toBe(201);
    expect(again.status).toBe(200);
    expect(again.headers.get('idempotent-replay')).toBe('true');
    expect(again.body).toEqual(first.body);
    expect(await banks.balance('bank_a', payer)).toBe(7_500n);
  });

  it('the same key with a different body is 409 IDEMPOTENCY_KEY_REUSED', async () => {
    const payer = await account('bank_a', 20_000n);
    const payee = await account('bank_b', 0n);
    const key = newKey();
    await client.createTransfer(body(['bank_a', payer], ['bank_b', payee]), key);
    const res = await client.createTransfer(body(['bank_a', payer], ['bank_b', payee], 12_501), key);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: { code: 'IDEMPOTENCY_KEY_REUSED' } });
  });

  it('two clients using the same key string get two transfers', async () => {
    const payer = await account('bank_a', 30_000n);
    const payee = await account('bank_b', 0n);
    const key = newKey();
    const req = body(['bank_a', payer], ['bank_b', payee]);
    const a = await client.createTransfer(req, key);
    const b = await otherClient.createTransfer(req, key);
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(idOf(a)).not.toBe(idOf(b));
  });
});

describe('happyPath — business failures are 422, not errors', () => {
  it('insufficient funds: 422 FAILED / INSUFFICIENT_FUNDS; the replay is 422 with Idempotent-Replay', async () => {
    const payer = await account('bank_a', 100n);
    const payee = await account('bank_b', 0n);
    const key = newKey();
    const req = body(['bank_a', payer], ['bank_b', payee]);
    const res = await client.createTransfer(req, key);
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ status: 'FAILED', state: 'FAILED', failure_code: 'INSUFFICIENT_FUNDS' });
    expect(await banks.balance('bank_a', payer)).toBe(100n);

    const replay = await client.createTransfer(req, key);
    expect(replay.status).toBe(422);
    expect(replay.headers.get('idempotent-replay')).toBe('true');
  });

  it('missing payee account: 422 REVERSED / PAYEE_ACCOUNT_NOT_FOUND, payer refunded', async () => {
    const payer = await account('bank_a', 40_000n);
    const res = await client.createTransfer(body(['bank_a', payer], ['bank_b', uniqueId('missing')]), newKey());
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ status: 'REVERSED', state: 'REVERSED', failure_code: 'PAYEE_ACCOUNT_NOT_FOUND' });
    expect(await banks.balance('bank_a', payer)).toBe(40_000n);
    expect(await journalKinds(idOf(res))).toEqual(['TRANSFER_DEBIT_LEG', 'TRANSFER_REVERSAL']);
  });
});

describe('happyPath — 202 when the saga cannot finish inline (ADR-010)', () => {
  it('payer bank down: 202 PENDING with Location; GET and replay say PENDING; recovery then finishes it once', async () => {
    const payer = await account('bank_a', 50_000n);
    const payee = await account('bank_b', 0n);
    const startup = await banks.getChaos('bank_a');
    const key = newKey();
    const req = body(['bank_a', payer], ['bank_b', payee]);
    let res: HttpResult;
    try {
      await banks.setChaos('bank_a', { ...startup, down: true });
      res = await client.createTransfer(req, key);

      expect(res.status).toBe(202);
      expect(res.headers.get('location')).toBe(`/v1/transfers/${idOf(res)}`);
      expect(res.headers.get('idempotent-replay')).toBeNull();
      // The debit intent is committed, the outcome unknown: never FAILED (a timeout is not a failure).
      expect(res.body).toMatchObject({ status: 'PENDING', state: 'DEBIT_SENT', failure_code: null });

      const polled = await client.getTransfer(idOf(res));
      expect(polled.status).toBe(200);
      expect(polled.body).toMatchObject({ status: 'PENDING', state: 'DEBIT_SENT' });

      const replay = await client.createTransfer(req, key);
      expect(replay.status).toBe(202);
      expect(replay.headers.get('idempotent-replay')).toBe('true');
      expect(replay.headers.get('location')).toBe(`/v1/transfers/${idOf(res)}`);
      expect(idOf(replay)).toBe(idOf(res));
    } finally {
      await banks.setChaos('bank_a', startup);
    }
    // M6: with the bank back, the recovery worker retries the idempotent debit and
    // finishes the transfer. The 202 resolves to SUCCEEDED with exactly one debit.
    const id = idOf(res);
    let final = await client.getTransfer(id);
    for (let i = 0; i < 120 && final.body.status === 'PENDING'; i++) {
      await sleep(250);
      final = await client.getTransfer(id);
    }
    expect(final.body).toMatchObject({ id, status: 'SUCCEEDED', state: 'SUCCESS' });
    expect(await banks.balance('bank_a', payer)).toBe(37_500n);
    expect(await banks.balance('bank_b', payee)).toBe(12_500n);
    expect(await journalKinds(id)).toEqual(['TRANSFER_DEBIT_LEG', 'TRANSFER_CREDIT_LEG']);
  });
});
