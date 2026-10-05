/**
 * M1 acceptance: the Ledger service over real gRPC, plus raw SQL against `ledger_db`
 * for the database-level guarantees. Needs the stack: `npm run stack:up`.
 *
 * The database is shared and persists between runs, so every key and reference id is
 * unique per run, and balance assertions compare before/after deltas.
 */
import { randomUUID } from 'node:crypto';
import { status as Status } from '@grpc/grpc-js';
import { callUnary, errorCodeOf, makeClient } from '@switch/common';
import {
  EntryDirection,
  LedgerServiceClient,
  type AccountBalance,
  type EntryLine,
  type PostJournalRequest,
} from '@switch/proto-gen/ledger/v1';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const LEDGER_ADDR = process.env.LEDGER_GRPC_ADDR ?? 'localhost:50052';
const LEDGER_HTTP = process.env.LEDGER_HTTP_URL ?? 'http://localhost:9102';
const LEDGER_DB = process.env.LEDGER_DATABASE_URL ?? 'postgres://ledger:ledger@localhost:5434/ledger_db';
const TIMEOUT_MS = 10_000;

const D = EntryDirection.ENTRY_DIRECTION_DEBIT;
const C = EntryDirection.ENTRY_DIRECTION_CREDIT;
const RUN = randomUUID();

let client: LedgerServiceClient;
let db: Pool;

beforeAll(() => {
  client = makeClient(LedgerServiceClient, LEDGER_ADDR);
  db = new Pool({ connectionString: LEDGER_DB, max: 4 });
});

afterAll(async () => {
  client.close();
  await db.end();
});

const ledger = {
  post: (request: PostJournalRequest) => callUnary(client.postJournal.bind(client), request, { timeoutMs: TIMEOUT_MS }),
  get: (journalId: string) => callUnary(client.getJournal.bind(client), { journalId }, { timeoutMs: TIMEOUT_MS }),
  list: (referenceId: string) =>
    callUnary(client.listJournals.bind(client), { referenceId }, { timeoutMs: TIMEOUT_MS }),
  balance: (accountCode: string) =>
    callUnary(client.getBalance.bind(client), { accountCode }, { timeoutMs: TIMEOUT_MS }),
  trial: () => callUnary(client.getTrialBalance.bind(client), {}, { timeoutMs: TIMEOUT_MS }),
};

function line(accountCode: string, direction: EntryDirection, amount: bigint): EntryLine {
  return { accountCode, direction, amount: amount.toString() };
}

/** Spec section 7 templates, keyed and referenced uniquely for this run. */
function debitLeg(transferId: string, amount: bigint, payerBank = 'bank_a'): PostJournalRequest {
  return {
    idempotencyKey: `transfer:${transferId}:debit-leg`,
    referenceId: transferId,
    kind: 'TRANSFER_DEBIT_LEG',
    description: 'debit leg',
    currency: 'INR',
    lines: [line(`receivable:${payerBank}`, D, amount), line('transit', C, amount)],
  };
}

function creditLeg(transferId: string, amount: bigint, payeeBank = 'bank_b'): PostJournalRequest {
  return {
    idempotencyKey: `transfer:${transferId}:credit-leg`,
    referenceId: transferId,
    kind: 'TRANSFER_CREDIT_LEG',
    description: 'credit leg',
    currency: 'INR',
    lines: [line('transit', D, amount), line(`payable:${payeeBank}`, C, amount)],
  };
}

function reversal(transferId: string, amount: bigint, payerBank = 'bank_a'): PostJournalRequest {
  return {
    idempotencyKey: `transfer:${transferId}:reversal`,
    referenceId: transferId,
    kind: 'TRANSFER_REVERSAL',
    description: 'reversal',
    currency: 'INR',
    lines: [line('transit', D, amount), line(`receivable:${payerBank}`, C, amount)],
  };
}

function newTransferId(): string {
  return `m1-${RUN}-${randomUUID()}`;
}

async function expectGrpcError(promise: Promise<unknown>, code: Status, errorCode: string): Promise<void> {
  const err: unknown = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err, 'expected the call to fail').toBeDefined();
  expect((err as { code?: unknown }).code).toBe(code);
  expect(errorCodeOf(err)).toBe(errorCode);
}

async function countJournals(idempotencyKey: string): Promise<number> {
  const { rows } = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM journals WHERE idempotency_key = $1', [
    idempotencyKey,
  ]);
  return rows[0]?.n ?? -1;
}

async function accountId(code: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>('SELECT id FROM accounts WHERE code = $1', [code]);
  const id = rows[0]?.id;
  if (id === undefined) throw new Error(`no account ${code}`);
  return id;
}

function amountsOf(balance: AccountBalance): { debit: bigint; credit: bigint; balance: bigint } {
  return { debit: BigInt(balance.debitTotal), credit: BigInt(balance.creditTotal), balance: BigInt(balance.balance) };
}

describe('PostJournal', () => {
  it('posts a balanced journal', async () => {
    const id = newTransferId();
    const request = debitLeg(id, 12_500n);
    const response = await ledger.post(request);

    expect(response.replayed).toBe(false);
    const journal = response.journal;
    expect(journal?.journalId).toMatch(/^[0-9a-f-]{36}$/);
    expect(journal).toMatchObject({
      idempotencyKey: request.idempotencyKey,
      referenceId: id,
      kind: 'TRANSFER_DEBIT_LEG',
      description: 'debit leg',
      currency: 'INR',
      lines: request.lines,
    });
    expect(journal?.createdAt).toBeInstanceOf(Date);

    const { rows } = await db.query<{ direction: string; amount: string }>(
      'SELECT direction, amount::text FROM entries WHERE journal_id = $1 ORDER BY id',
      [journal?.journalId],
    );
    expect(rows).toEqual([
      { direction: 'D', amount: '12500' },
      { direction: 'C', amount: '12500' },
    ]);
  });

  it('rejects an unbalanced journal in application code with INVALID_ARGUMENT / JOURNAL_INVALID', async () => {
    const id = newTransferId();
    const request = { ...debitLeg(id, 100n), lines: [line('receivable:bank_a', D, 100n), line('transit', C, 99n)] };
    await expectGrpcError(ledger.post(request), Status.INVALID_ARGUMENT, 'JOURNAL_INVALID');
    expect(await countJournals(request.idempotencyKey)).toBe(0);
  });

  it('rejects other invalid journals with JOURNAL_INVALID', async () => {
    const id = newTransferId();
    const invalid: PostJournalRequest[] = [
      { ...debitLeg(id, 100n), currency: 'USD' },
      { ...debitLeg(id, 100n), lines: [line('transit', D, 100n)] },
      { ...debitLeg(id, 100n), idempotencyKey: '' },
      { ...debitLeg(id, 100n), idempotencyKey: 'k'.repeat(201) },
      { ...debitLeg(id, 100n), referenceId: '' },
      { ...debitLeg(id, 100n), kind: '' },
      { ...debitLeg(id, 100n), lines: [line('receivable:bank_a', D, 0n), line('transit', C, 0n)] },
    ];
    for (const request of invalid) {
      await expectGrpcError(ledger.post(request), Status.INVALID_ARGUMENT, 'JOURNAL_INVALID');
    }
  });

  it('replays a duplicate key with the same body: replayed = true, same journal', async () => {
    const id = newTransferId();
    const request = debitLeg(id, 4_200n);
    const first = await ledger.post(request);
    const second = await ledger.post(request);

    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.journal).toEqual(first.journal);
    expect(await countJournals(request.idempotencyKey)).toBe(1);
  });

  it('treats reordered lines and a different description as the same body (spec hash)', async () => {
    const id = newTransferId();
    const request = debitLeg(id, 777n);
    const first = await ledger.post(request);
    const reordered = await ledger.post({ ...request, description: 'other', lines: [...request.lines].reverse() });
    expect(reordered.replayed).toBe(true);
    expect(reordered.journal?.journalId).toBe(first.journal?.journalId);
    expect(reordered.journal?.description).toBe('debit leg');
  });

  it('returns ALREADY_EXISTS / IDEMPOTENCY_KEY_REUSED for the same key with a different body', async () => {
    const id = newTransferId();
    const request = debitLeg(id, 1_000n);
    await ledger.post(request);
    const changed = { ...request, lines: [line('receivable:bank_a', D, 1_001n), line('transit', C, 1_001n)] };
    await expectGrpcError(ledger.post(changed), Status.ALREADY_EXISTS, 'IDEMPOTENCY_KEY_REUSED');
    const otherBank = { ...request, lines: [line('receivable:bank_b', D, 1_000n), line('transit', C, 1_000n)] };
    await expectGrpcError(ledger.post(otherBank), Status.ALREADY_EXISTS, 'IDEMPOTENCY_KEY_REUSED');
    expect(await countJournals(request.idempotencyKey)).toBe(1);
  });

  it('creates exactly one journal from 100 concurrent calls with the same key', async () => {
    const id = newTransferId();
    const request = debitLeg(id, 50_000n);
    const responses = await Promise.all(Array.from({ length: 100 }, () => ledger.post(request)));

    const journalIds = new Set(responses.map((response) => response.journal?.journalId));
    expect(journalIds.size).toBe(1);
    expect(responses.filter((response) => !response.replayed)).toHaveLength(1);
    expect(responses.filter((response) => response.replayed)).toHaveLength(99);

    expect(await countJournals(request.idempotencyKey)).toBe(1);
    const { rows } = await db.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM entries e JOIN journals j ON j.id = e.journal_id WHERE j.idempotency_key = $1',
      [request.idempotencyKey],
    );
    expect(rows[0]?.n).toBe(2);
  });

  it('returns NOT_FOUND / ACCOUNT_NOT_FOUND for an unknown account and rolls back', async () => {
    const id = newTransferId();
    const request = { ...debitLeg(id, 300n), lines: [line('receivable:bank_z', D, 300n), line('transit', C, 300n)] };
    await expectGrpcError(ledger.post(request), Status.NOT_FOUND, 'ACCOUNT_NOT_FOUND');
    expect(await countJournals(request.idempotencyKey)).toBe(0);

    // The rollback released the key: the same key with valid accounts is a fresh post.
    const valid = await ledger.post(debitLeg(id, 300n));
    expect(valid.replayed).toBe(false);
  });
});

describe('database guarantees (raw SQL, bypassing the service)', () => {
  it('the deferred trigger rejects an unbalanced journal at COMMIT', async () => {
    const transit = await accountId('transit');
    const key = `raw-unbalanced:${RUN}`;
    const conn = await db.connect();
    try {
      await conn.query('BEGIN');
      const { rows } = await conn.query<{ id: string }>(
        `INSERT INTO journals (idempotency_key, request_hash, reference_id, kind, currency)
         VALUES ($1, 'raw', $1, 'RAW_TEST', 'INR') RETURNING id`,
        [key],
      );
      await conn.query(`INSERT INTO entries (journal_id, account_id, direction, amount) VALUES ($1, $2, 'D', 100)`, [
        rows[0]?.id,
        transit,
      ]);
      await expect(conn.query('COMMIT')).rejects.toThrow(/unbalanced: debits 100 credits 0/);
    } finally {
      await conn.query('ROLLBACK').catch(() => undefined);
      conn.release();
    }
    expect(await countJournals(key)).toBe(0);
  });

  it('the trigger is deferred: a journal balanced only by commit time is accepted', async () => {
    const transit = await accountId('transit');
    const key = `raw-balanced:${RUN}`;
    const conn = await db.connect();
    try {
      await conn.query('BEGIN');
      const { rows } = await conn.query<{ id: string }>(
        `INSERT INTO journals (idempotency_key, request_hash, reference_id, kind, currency)
         VALUES ($1, 'raw', $1, 'RAW_TEST', 'INR') RETURNING id`,
        [key],
      );
      const journalId = rows[0]?.id;
      // Two separate statements: unbalanced after the first, balanced at COMMIT.
      await conn.query(`INSERT INTO entries (journal_id, account_id, direction, amount) VALUES ($1, $2, 'D', 1)`, [
        journalId,
        transit,
      ]);
      await conn.query(`INSERT INTO entries (journal_id, account_id, direction, amount) VALUES ($1, $2, 'C', 1)`, [
        journalId,
        transit,
      ]);
      await conn.query('COMMIT');
    } finally {
      conn.release();
    }
    expect(await countJournals(key)).toBe(1);
  });

  describe('append-only', () => {
    let journalId: string;

    beforeAll(async () => {
      const response = await ledger.post(debitLeg(newTransferId(), 10n));
      journalId = response.journal?.journalId ?? '';
      expect(journalId).not.toBe('');
    });

    it('UPDATE on entries fails', async () => {
      await expect(
        db.query('UPDATE entries SET amount = amount + 1 WHERE journal_id = $1', [journalId]),
      ).rejects.toThrow(/table entries is append-only/);
    });

    it('DELETE on entries fails', async () => {
      await expect(db.query('DELETE FROM entries WHERE journal_id = $1', [journalId])).rejects.toThrow(
        /table entries is append-only/,
      );
    });

    it('UPDATE on journals fails', async () => {
      await expect(db.query(`UPDATE journals SET kind = 'X' WHERE id = $1`, [journalId])).rejects.toThrow(
        /table journals is append-only/,
      );
    });

    it('DELETE on journals fails', async () => {
      await expect(db.query('DELETE FROM journals WHERE id = $1', [journalId])).rejects.toThrow(
        /table journals is append-only/,
      );
    });

    it('TRUNCATE on entries and journals fails (ADR-015)', async () => {
      // Inside a transaction that always rolls back: if the trigger were ever missing,
      // this test fails without destroying the ledger.
      for (const statement of ['TRUNCATE entries', 'TRUNCATE journals CASCADE']) {
        const conn = await db.connect();
        try {
          await conn.query('BEGIN');
          await expect(conn.query(statement)).rejects.toThrow(/append-only/);
        } finally {
          await conn.query('ROLLBACK');
          conn.release();
        }
      }
    });

    it('left the journal and its entries intact', async () => {
      const { rows } = await db.query<{ amount: string }>(
        'SELECT amount::text FROM entries WHERE journal_id = $1 ORDER BY id',
        [journalId],
      );
      expect(rows).toEqual([{ amount: '10' }, { amount: '10' }]);
    });
  });
});

describe('GetJournal', () => {
  it('returns a posted journal by id', async () => {
    const posted = await ledger.post(creditLeg(newTransferId(), 2_500n));
    const fetched = await ledger.get(posted.journal?.journalId ?? '');
    expect(fetched).toEqual(posted.journal);
  });

  it('returns NOT_FOUND / JOURNAL_NOT_FOUND for an unknown or malformed id', async () => {
    await expectGrpcError(ledger.get(randomUUID()), Status.NOT_FOUND, 'JOURNAL_NOT_FOUND');
    await expectGrpcError(ledger.get('not-a-uuid'), Status.NOT_FOUND, 'JOURNAL_NOT_FOUND');
  });
});

describe('ListJournals', () => {
  it('returns every journal for a reference id, oldest first, with lines', async () => {
    const id = newTransferId();
    const posted = [
      await ledger.post(debitLeg(id, 900n)),
      await ledger.post(reversal(id, 900n)),
      await ledger.post(creditLeg(id, 900n)),
    ];
    const listed = await ledger.list(id);
    expect(listed.journals).toEqual(posted.map((response) => response.journal));
  });

  it('returns at most 50, the oldest ones', async () => {
    const reference = newTransferId();
    const keys: string[] = [];
    for (let i = 0; i < 51; i++) {
      const request = { ...debitLeg(reference, 1n), idempotencyKey: `${reference}:${String(i).padStart(2, '0')}` };
      keys.push(request.idempotencyKey);
      await ledger.post(request);
    }
    const listed = await ledger.list(reference);
    expect(listed.journals.map((journal) => journal.idempotencyKey)).toEqual(keys.slice(0, 50));
  });

  it('returns an empty list for an unknown reference id', async () => {
    expect((await ledger.list(newTransferId())).journals).toEqual([]);
  });
});

describe('GetBalance', () => {
  it('computes the normal-side balance for ASSET and LIABILITY accounts', async () => {
    const id = newTransferId();
    const amount = 12_500n;
    const before = {
      receivable: amountsOf(await ledger.balance('receivable:bank_a')),
      transit: amountsOf(await ledger.balance('transit')),
      payable: amountsOf(await ledger.balance('payable:bank_b')),
    };

    // Debit leg: receivable:bank_a (ASSET, debit-normal) and transit (LIABILITY, credit-normal) both rise.
    await ledger.post(debitLeg(id, amount));
    const receivable = await ledger.balance('receivable:bank_a');
    const transitMid = await ledger.balance('transit');
    expect(receivable).toMatchObject({ accountCode: 'receivable:bank_a', accountType: 'ASSET', currency: 'INR' });
    expect(transitMid).toMatchObject({ accountCode: 'transit', accountType: 'LIABILITY', currency: 'INR' });
    expect(amountsOf(receivable)).toEqual({
      debit: before.receivable.debit + amount,
      credit: before.receivable.credit,
      balance: before.receivable.balance + amount,
    });
    expect(amountsOf(transitMid)).toEqual({
      debit: before.transit.debit,
      credit: before.transit.credit + amount,
      balance: before.transit.balance + amount,
    });

    // Credit leg: transit returns to where it was; payable:bank_b (LIABILITY) rises.
    await ledger.post(creditLeg(id, amount));
    expect(amountsOf(await ledger.balance('transit')).balance).toBe(before.transit.balance);
    const payable = await ledger.balance('payable:bank_b');
    expect(payable.accountType).toBe('LIABILITY');
    expect(amountsOf(payable)).toEqual({
      debit: before.payable.debit,
      credit: before.payable.credit + amount,
      balance: before.payable.balance + amount,
    });
  });

  it('returns NOT_FOUND / ACCOUNT_NOT_FOUND for an unknown account', async () => {
    await expectGrpcError(ledger.balance('receivable:bank_z'), Status.NOT_FOUND, 'ACCOUNT_NOT_FOUND');
  });
});

describe('GetTrialBalance', () => {
  it('lists the chart of accounts with consistent, balanced totals', async () => {
    const trial = await ledger.trial();
    expect(trial.accounts.map((account) => [account.accountCode, account.accountType])).toEqual([
      ['payable:bank_a', 'LIABILITY'],
      ['payable:bank_b', 'LIABILITY'],
      ['receivable:bank_a', 'ASSET'],
      ['receivable:bank_b', 'ASSET'],
      ['transit', 'LIABILITY'],
    ]);
    const debits = trial.accounts.reduce((sum, account) => sum + BigInt(account.debitTotal), 0n);
    const credits = trial.accounts.reduce((sum, account) => sum + BigInt(account.creditTotal), 0n);
    expect(BigInt(trial.totalDebits)).toBe(debits);
    expect(BigInt(trial.totalCredits)).toBe(credits);
    expect(debits).toBe(credits);
    expect(trial.balanced).toBe(true);
    for (const account of trial.accounts) {
      const { debit, credit, balance } = amountsOf(account);
      expect(balance).toBe(account.accountType === 'ASSET' ? debit - credit : credit - debit);
    }
  });
});

describe('health and metrics (HTTP 9102)', () => {
  it('serves /healthz and /readyz', async () => {
    const health = await fetch(`${LEDGER_HTTP}/healthz`);
    expect(health.status).toBe(200);
    const ready = await fetch(`${LEDGER_HTTP}/readyz`);
    expect(ready.status).toBe(200);
  });

  it('exposes journals_posted_total and the gRPC metrics', async () => {
    const body = await (await fetch(`${LEDGER_HTTP}/metrics`)).text();
    expect(body).toMatch(/journals_posted_total\{kind="TRANSFER_DEBIT_LEG",replayed="false"\} \d+/);
    expect(body).toMatch(/journals_posted_total\{kind="TRANSFER_DEBIT_LEG",replayed="true"\} \d+/);
    expect(body).toMatch(/grpc_requests_total\{method="PostJournal",code="OK"\} \d+/);
    expect(body).toMatch(/grpc_requests_total\{method="PostJournal",code="INVALID_ARGUMENT"\} \d+/);
    expect(body).toMatch(/grpc_request_duration_seconds_count\{method="GetTrialBalance"\} \d+/);
  });
});
