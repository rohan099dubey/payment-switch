/**
 * Phase 2, item 3 (ARCHITECTURE.md section 19, ADR-027): bank `GetStatement`, ledger
 * `ListJournalsByTime`, and the reconciliation service, against the real stack.
 *
 * Breaks are created on purpose by moving money at a bank, or posting a journal, directly:
 * traffic that bypasses the switch. Transfers made through the Gateway must reconcile cleanly.
 */
import { randomUUID } from 'node:crypto';
import { status as Status } from '@grpc/grpc-js';
import { callUnary, errorCodeOf, makeClient } from '@switch/common';
import { BankServiceClient } from '@switch/proto-gen/bank/v1';
import { EntryDirection, LedgerServiceClient } from '@switch/proto-gen/ledger/v1';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BankAdmin } from '../helpers/bankAdmin';
import { DEV_CLIENTS, GatewayClient } from '../helpers/gatewayClient';
import { ReconciliationClient } from '../helpers/reconciliation';

const RUN = randomUUID().slice(0, 8);
let counter = 0;
const uniqueId = (prefix: string): string => `p23-${RUN}-${prefix}-${++counter}`;

let banks: BankAdmin;
let recon: ReconciliationClient;
let bankA: BankServiceClient;
let ledger: LedgerServiceClient;
const gateway = GatewayClient.for(DEV_CLIENTS.b);

beforeAll(async () => {
  banks = new BankAdmin();
  recon = new ReconciliationClient();
  bankA = makeClient(BankServiceClient, process.env.BANK_A_GRPC_ADDR ?? 'localhost:50061');
  ledger = makeClient(LedgerServiceClient, process.env.LEDGER_GRPC_ADDR ?? 'localhost:50052');
  await gateway.accessToken();
});

afterAll(() => {
  banks.close();
  recon.close();
  bankA.close();
  ledger.close();
});

// ---------------------------------------------------------------- helpers

/** A journal posted straight to the Ledger, as a transfer leg would be. */
async function postLeg(
  kind: 'TRANSFER_DEBIT_LEG' | 'TRANSFER_CREDIT_LEG',
  referenceId: string,
  amount: bigint,
): Promise<void> {
  const bankLine = kind === 'TRANSFER_DEBIT_LEG' ? 'receivable:bank_a' : 'payable:bank_b';
  const D = EntryDirection.ENTRY_DIRECTION_DEBIT;
  const C = EntryDirection.ENTRY_DIRECTION_CREDIT;
  const lines =
    kind === 'TRANSFER_DEBIT_LEG'
      ? [
          { accountCode: bankLine, direction: D, amount: amount.toString() },
          { accountCode: 'transit', direction: C, amount: amount.toString() },
        ]
      : [
          { accountCode: 'transit', direction: D, amount: amount.toString() },
          { accountCode: bankLine, direction: C, amount: amount.toString() },
        ];
  await callUnary(
    ledger.postJournal.bind(ledger),
    { idempotencyKey: uniqueId('jk'), referenceId, kind, description: 'reconciliation test', currency: 'INR', lines },
    { timeoutMs: 10_000 },
  );
}

async function statementRefs(from: Date, to: Date, pageSize: number): Promise<{ refs: string[]; pages: number }> {
  const refs: string[] = [];
  let pageToken = '';
  let pages = 0;
  do {
    const page = await callUnary(
      bankA.getStatement.bind(bankA),
      { from, to, pageSize, pageToken },
      { timeoutMs: 30_000 },
    );
    refs.push(...page.lines.map((l) => `${l.referenceId}/${l.operation}`));
    pageToken = page.nextPageToken;
    pages++;
  } while (pageToken !== '');
  return { refs, pages };
}

async function grpcCode(promise: Promise<unknown>): Promise<{ code: unknown; errorCode: string | undefined }> {
  try {
    await promise;
  } catch (err) {
    return { code: (err as { code?: unknown }).code, errorCode: errorCodeOf(err) };
  }
  throw new Error('expected the call to fail');
}

const ms = (d: Date, delta: number): Date => new Date(d.getTime() + delta);

// ---------------------------------------------------------------- tests

describe('bank GetStatement and ledger ListJournalsByTime (ADR-027)', () => {
  it('GetStatement pages through the APPLIED operations in [from, to) with no gaps or repeats', async () => {
    const account = uniqueId('acct');
    await banks.createAccount('bank_a', account, 1_000_000n);
    const from = new Date();
    const refs = Array.from({ length: 5 }, () => uniqueId('ref'));
    for (const ref of refs) expect(await banks.sendMoney('bank_a', 'debit', ref, account, 100n)).toBe('APPLIED');
    // A VOIDED tombstone moved no money: it is not a statement line.
    const voided = uniqueId('voided');
    expect(await banks.resolve('bank_a', voided, 'DEBIT')).toBe('VOIDED');
    const to = ms(new Date(), 1000);

    const { refs: seen, pages } = await statementRefs(from, to, 2);
    const ours = seen.filter((r) => r.startsWith(`p23-${RUN}-`));
    expect(ours).toEqual(refs.map((r) => `${r}/1`)); // OPERATION_TYPE_DEBIT = 1, in creation order
    expect(new Set(seen).size).toBe(seen.length);
    expect(pages).toBeGreaterThanOrEqual(3);
    expect(seen.some((r) => r.startsWith(voided))).toBe(false);
  });

  it('ListJournalsByTime pages through journals in [from, to), with their lines', async () => {
    const from = new Date();
    const refs = Array.from({ length: 3 }, () => uniqueId('jref'));
    for (const ref of refs) await postLeg('TRANSFER_DEBIT_LEG', ref, 250n);
    const to = ms(new Date(), 1000);

    const seen: string[] = [];
    let pageToken = '';
    do {
      const page = await callUnary(
        ledger.listJournalsByTime.bind(ledger),
        { from, to, pageSize: 1, pageToken },
        { timeoutMs: 30_000 },
      );
      for (const j of page.journals) {
        seen.push(j.referenceId);
        if (refs.includes(j.referenceId)) expect(j.lines.map((l) => l.amount)).toEqual(['250', '250']);
      }
      pageToken = page.nextPageToken;
    } while (pageToken !== '');
    expect(seen.filter((r) => refs.includes(r))).toEqual(refs);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('both reject an empty window, a page size above 1000 and a malformed token', async () => {
    const now = new Date();
    for (const request of [
      { from: now, to: now, pageSize: 0, pageToken: '' },
      { from: ms(now, -1000), to: now, pageSize: 1001, pageToken: '' },
      { from: ms(now, -1000), to: now, pageSize: 0, pageToken: 'garbage' },
    ]) {
      expect(await grpcCode(callUnary(bankA.getStatement.bind(bankA), request, { timeoutMs: 5000 }))).toEqual({
        code: Status.INVALID_ARGUMENT,
        errorCode: 'INVALID_REQUEST',
      });
      expect(await grpcCode(callUnary(ledger.listJournalsByTime.bind(ledger), request, { timeoutMs: 5000 }))).toEqual({
        code: Status.INVALID_ARGUMENT,
        errorCode: 'INVALID_REQUEST',
      });
    }
  });
});

describe('reconciliation (section 19, ADR-027)', () => {
  it('transfers made through the switch reconcile with no break: SUCCESS, FAILED and REVERSED', async () => {
    const from = ms(new Date(), -1000);
    const payer = uniqueId('payer');
    const payee = uniqueId('payee');
    const poor = uniqueId('poor');
    await banks.createAccount('bank_a', payer, 10_000n);
    await banks.createAccount('bank_a', poor, 10n);
    await banks.createAccount('bank_b', payee, 0n);
    const body = (p: string, q: string): Record<string, unknown> => ({
      payer: { bank_id: 'bank_a', account_id: p },
      payee: { bank_id: 'bank_b', account_id: q },
      amount: 1000,
      currency: 'INR',
    });
    const results = [
      await gateway.createTransfer(body(payer, payee), uniqueId('k')),
      await gateway.createTransfer(body(poor, payee), uniqueId('k')),
      await gateway.createTransfer(body(payer, uniqueId('nobody')), uniqueId('k')),
    ];
    expect(results.map((r) => r.body.state)).toEqual(['SUCCESS', 'FAILED', 'REVERSED']);
    const ids = results.map((r) => r.body.id as string);

    const run = await recon.run(from, ms(new Date(), 1000));
    expect(run.statementLines).toBeGreaterThanOrEqual(4); // debit+credit, debit+reverse
    expect(run.journals).toBeGreaterThanOrEqual(4);
    expect((await recon.report({ referenceIds: ids })).breaks).toEqual([]);
  });

  it('finds each break type, with both amounts', async () => {
    const from = ms(new Date(), -1000);
    const account = uniqueId('acct');
    await banks.createAccount('bank_a', account, 1_000_000n);
    const onlyBank = randomUUID();
    const onlyLedger = randomUUID();
    const mismatch = randomUUID();
    expect(await banks.sendMoney('bank_a', 'debit', onlyBank, account, 700n)).toBe('APPLIED');
    await postLeg('TRANSFER_CREDIT_LEG', onlyLedger, 800n);
    expect(await banks.sendMoney('bank_a', 'debit', mismatch, account, 1000n)).toBe('APPLIED');
    await postLeg('TRANSFER_DEBIT_LEG', mismatch, 900n);

    const run = await recon.run(from, ms(new Date(), 1000));
    expect(run.breaksOpened).toBeGreaterThanOrEqual(3);
    const { breaks } = await recon.report({ referenceIds: [onlyBank, onlyLedger, mismatch], openOnly: true });
    const byRef = new Map(breaks.map((b) => [b.referenceId, b]));
    expect(byRef.get(onlyBank)).toMatchObject({
      bankId: 'bank_a',
      operation: 'DEBIT',
      type: 'MISSING_IN_LEDGER',
      bankAmount: 700n,
      ledgerAmount: 0n,
    });
    expect(byRef.get(onlyLedger)).toMatchObject({
      bankId: 'bank_b',
      operation: 'CREDIT',
      type: 'MISSING_AT_BANK',
      bankAmount: 0n,
      ledgerAmount: 800n,
    });
    expect(byRef.get(mismatch)).toMatchObject({
      bankId: 'bank_a',
      operation: 'DEBIT',
      type: 'AMOUNT_MISMATCH',
      bankAmount: 1000n,
      ledgerAmount: 900n,
    });
  });

  it('a break is resolved by a later run once its missing side appears', async () => {
    const from = ms(new Date(), -1000);
    const account = uniqueId('acct');
    await banks.createAccount('bank_a', account, 1_000_000n);
    const ref = randomUUID();
    expect(await banks.sendMoney('bank_a', 'debit', ref, account, 400n)).toBe('APPLIED');
    await recon.run(from, ms(new Date(), 1000));
    expect((await recon.report({ referenceIds: [ref] })).breaks[0]?.status).toBe('OPEN');

    // The missing journal arrives later (as recovery would post it); the next run covers a
    // later window that does not contain it, and still re-checks the open break.
    await postLeg('TRANSFER_DEBIT_LEG', ref, 400n);
    const later = new Date();
    const run = await recon.run(later, ms(later, 1000));
    expect(run.breaksResolved).toBeGreaterThanOrEqual(1);
    expect((await recon.report({ referenceIds: [ref] })).breaks[0]).toMatchObject({ status: 'RESOLVED' });
  });

  it('RunReconciliation rejects an empty or inverted window', async () => {
    const now = new Date();
    expect(await grpcCode(recon.run(now, now))).toEqual({
      code: Status.INVALID_ARGUMENT,
      errorCode: 'INVALID_REQUEST',
    });
    expect(await grpcCode(recon.run(now, ms(now, -1)))).toMatchObject({ code: Status.INVALID_ARGUMENT });
  });
});
