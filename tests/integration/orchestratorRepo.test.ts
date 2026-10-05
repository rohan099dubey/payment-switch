/**
 * M3 acceptance, database layer: `transfersRepo` against the real `orchestrator_db`.
 * The concurrency guarantees (compare-and-set, leases, the idempotency constraint, the
 * recovery claim query) live in SQL, so they are tested in SQL, never against a mock.
 *
 * Rows are unique per run. `claimDue` runs inside a transaction that is rolled back, so it
 * never leases anyone else's rows.
 */
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TransferState } from '../../services/orchestrator/src/domain/states';
import type { NewTransfer, Transfer } from '../../services/orchestrator/src/domain/transfer';
import type { CasRequest } from '../../services/orchestrator/src/domain/transitions';
import { listEvents } from '../../services/orchestrator/src/repo/eventsRepo';
import {
  acquireLease,
  casTransition,
  claimDue,
  getTransfer,
  insertTransfer,
  releaseLease,
  yieldTransfer,
} from '../../services/orchestrator/src/repo/transfersRepo';

const ORCH_DB = process.env.ORCHESTRATOR_DATABASE_URL ?? 'postgres://orch:orch@localhost:5433/orchestrator_db';
const LEASE_MS = 15_000;
const RUN = randomUUID().slice(0, 8);
let counter = 0;
const uniqueId = (prefix: string): string => `m3repo-${RUN}-${prefix}-${++counter}`;

let pool: Pool;

beforeAll(() => {
  pool = new Pool({ connectionString: ORCH_DB, max: 25 });
});

afterAll(async () => {
  await pool.end();
});

function newTransfer(overrides: Partial<NewTransfer> = {}): NewTransfer {
  return {
    clientId: uniqueId('client'),
    idempotencyKey: uniqueId('key'),
    requestHash: 'h'.repeat(64),
    payer: { bankId: 'bank_a', accountId: 'A1' },
    payee: { bankId: 'bank_b', accountId: 'B1' },
    amount: 12_500n,
    currency: 'INR',
    note: null,
    ...overrides,
  };
}

async function created(owner = uniqueId('owner')): Promise<{ t: Transfer; owner: string }> {
  const outcome = await insertTransfer(pool, newTransfer(), owner, LEASE_MS);
  if (outcome.status !== 'created') throw new Error('expected a new transfer');
  return { t: outcome.transfer, owner };
}

function cas(t: Transfer, to: TransferState, owner: string, extra: Partial<CasRequest> = {}): CasRequest {
  return {
    transferId: t.id,
    fromState: t.state,
    fromVersion: t.version,
    toState: to,
    leaseOwner: owner,
    leaseMs: LEASE_MS,
    terminal: to === TransferState.SUCCESS || to === TransferState.FAILED,
    failureCode: null,
    failureMessage: null,
    reason: 'TEST',
    detail: { test: true },
    ...extra,
  };
}

describe('insertTransfer (CreateTransfer step 3)', () => {
  it('inserts INITIATED at version 1, owning the lease, with the NULL -> INITIATED event', async () => {
    const before = Date.now();
    const { t, owner } = await created();
    expect(t).toMatchObject({ state: 'INITIATED', version: 1, attempts: 0, leaseOwner: owner, amount: 12_500n });
    expect(t.leaseExpiresAt?.getTime()).toBeGreaterThan(before + LEASE_MS - 2000);
    const events = await listEvents(pool, t.id);
    expect(events.map((e) => [e.fromState, e.toState, e.reason])).toEqual([[null, 'INITIATED', 'TRANSFER_CREATED']]);
  });

  it('a duplicate (client_id, idempotency_key) returns the existing row and inserts no event', async () => {
    const input = newTransfer();
    const first = await insertTransfer(pool, input, 'owner-1', LEASE_MS);
    const second = await insertTransfer(
      pool,
      { ...input, amount: 1n, requestHash: 'x'.repeat(64) },
      'owner-2',
      LEASE_MS,
    );
    expect(first.status).toBe('created');
    expect(second.status).toBe('duplicate');
    if (first.status !== 'created' || second.status !== 'duplicate') return;
    expect(second.existing.id).toBe(first.transfer.id);
    expect(second.existing.leaseOwner).toBe('owner-1');
    expect(second.existing.amount).toBe(12_500n);
    expect(await listEvents(pool, first.transfer.id)).toHaveLength(1);
  });

  it('20 concurrent inserts with the same key create exactly one transfer (separate connections)', async () => {
    const input = newTransfer();
    // Warm the pool so the inserts really race at the database rather than queue on connect.
    const clients = await Promise.all(Array.from({ length: 20 }, () => pool.connect()));
    clients.forEach((c) => {
      c.release();
    });
    const outcomes = await Promise.all(
      Array.from({ length: 20 }, (_, i) => insertTransfer(pool, input, `owner-${i}`, LEASE_MS)),
    );
    const createdOnes = outcomes.filter((o) => o.status === 'created');
    expect(createdOnes).toHaveLength(1);
    const ids = new Set(outcomes.map((o) => (o.status === 'created' ? o.transfer.id : o.existing.id)));
    expect(ids.size).toBe(1);
    const rows = await pool.query(
      'SELECT count(*)::int AS n FROM transfers WHERE client_id = $1 AND idempotency_key = $2',
      [input.clientId, input.idempotencyKey],
    );
    expect(rows.rows[0]).toEqual({ n: 1 });
  });

  it('the same key under two different client ids is two transfers', async () => {
    const input = newTransfer();
    const a = await insertTransfer(pool, input, 'o', LEASE_MS);
    const b = await insertTransfer(pool, { ...input, clientId: uniqueId('client') }, 'o', LEASE_MS);
    expect([a.status, b.status]).toEqual(['created', 'created']);
  });

  it('the CHECK constraint refuses a non-positive amount even if validation were skipped', async () => {
    await expect(insertTransfer(pool, newTransfer({ amount: 0n }), 'o', LEASE_MS)).rejects.toThrow(/check constraint/);
  });
});

describe('casTransition (section 13 compare-and-set)', () => {
  it('bumps the version, resets attempts, renews the lease, and appends the event in one go', async () => {
    const { t, owner } = await created();
    await pool.query(
      "UPDATE transfers SET attempts = 2, lease_expires_at = now() + interval '1 second' WHERE id = $1",
      [t.id],
    );
    const updated = await casTransition(pool, cas({ ...t }, TransferState.DEBIT_SENT, owner));

    expect(updated).toMatchObject({ state: 'DEBIT_SENT', version: 2, attempts: 0, leaseOwner: owner });
    expect(updated?.leaseExpiresAt?.getTime()).toBeGreaterThan(Date.now() + LEASE_MS - 3000);
    const events = await listEvents(pool, t.id);
    expect(events.map((e) => [e.fromState, e.toState, e.reason, e.detail])).toEqual([
      [null, 'INITIATED', 'TRANSFER_CREATED', {}],
      ['INITIATED', 'DEBIT_SENT', 'TEST', { test: true }],
    ]);
  });

  it.each([
    ['a stale version', (t: Transfer) => ({ fromVersion: t.version + 1 })],
    ['a stale state', () => ({ fromState: TransferState.DEBITED })],
    ['a lease held by someone else', () => ({ leaseOwner: 'thief' })],
  ])('matches zero rows for %s: returns null, writes nothing', async (_name, change) => {
    const { t, owner } = await created();
    const result = await casTransition(pool, cas(t, TransferState.DEBIT_SENT, owner, change(t)));
    expect(result).toBeNull();
    expect((await getTransfer(pool, t.id))?.state).toBe('INITIATED');
    expect(await listEvents(pool, t.id)).toHaveLength(1);
  });

  it('two drivers racing the same CAS: exactly one wins', async () => {
    const { t, owner } = await created();
    const results = await Promise.all([
      casTransition(pool, cas(t, TransferState.DEBIT_SENT, owner)),
      casTransition(pool, cas(t, TransferState.DEBIT_SENT, owner)),
      casTransition(pool, cas(t, TransferState.NEEDS_MANUAL_REVIEW, owner)),
    ]);
    expect(results.filter((r) => r !== null)).toHaveLength(1);
    expect(await listEvents(pool, t.id)).toHaveLength(2);
    expect((await getTransfer(pool, t.id))?.version).toBe(2);
  });

  it('a terminal state clears the lease; COALESCE keeps an earlier failure code when none is given', async () => {
    const { t, owner } = await created();
    const s1 = await casTransition(
      pool,
      cas(t, TransferState.DEBIT_SENT, owner, { failureCode: 'FIRST', failureMessage: 'm1' }),
    );
    if (s1 === null) throw new Error('cas failed');
    const s2 = await casTransition(pool, cas(s1, TransferState.FAILED, owner, { terminal: true }));
    expect(s2).toMatchObject({
      state: 'FAILED',
      leaseOwner: null,
      leaseExpiresAt: null,
      failureCode: 'FIRST',
      failureMessage: 'm1',
    });
  });

  it('after a terminal CAS the old owner can never write again', async () => {
    const { t, owner } = await created();
    const s1 = await casTransition(pool, cas(t, TransferState.DEBIT_SENT, owner));
    if (s1 === null) throw new Error('cas failed');
    const s2 = await casTransition(pool, cas(s1, TransferState.FAILED, owner, { terminal: true }));
    if (s2 === null) throw new Error('cas failed');
    expect(await casTransition(pool, cas(s2, TransferState.NEEDS_MANUAL_REVIEW, owner))).toBeNull();
  });
});

describe('yield and leases', () => {
  it('yieldTransfer: attempts + 1, next_attempt_at = now() + backoff, lease released, no version bump, no event', async () => {
    const { t, owner } = await created();
    const yielded = await yieldTransfer(pool, {
      transferId: t.id,
      version: t.version,
      leaseOwner: owner,
      backoffMs: 4000,
    });

    expect(yielded).toMatchObject({
      state: 'INITIATED',
      version: 1,
      attempts: 1,
      leaseOwner: null,
      leaseExpiresAt: null,
    });
    const { rows } = await pool.query<{ delay_ms: number }>(
      'SELECT extract(epoch FROM next_attempt_at - now()) * 1000 AS delay_ms FROM transfers WHERE id = $1',
      [t.id],
    );
    expect(Number(rows[0]?.delay_ms)).toBeGreaterThan(2500);
    expect(Number(rows[0]?.delay_ms)).toBeLessThanOrEqual(4000);
    expect(await listEvents(pool, t.id)).toHaveLength(1);
  });

  it('yieldTransfer by a stale driver matches nothing', async () => {
    const { t } = await created();
    expect(
      await yieldTransfer(pool, { transferId: t.id, version: t.version, leaseOwner: 'thief', backoffMs: 1 }),
    ).toBeNull();
    expect(
      await yieldTransfer(pool, { transferId: t.id, version: 9, leaseOwner: t.leaseOwner ?? '', backoffMs: 1 }),
    ).toBeNull();
  });

  it('acquireLease only takes a free or expired lease, and never on a terminal transfer', async () => {
    const { t, owner } = await created();
    expect(await acquireLease(pool, t.id, 'other', LEASE_MS)).toBeNull();

    await pool.query("UPDATE transfers SET lease_expires_at = now() - interval '1 second' WHERE id = $1", [t.id]);
    const taken = await acquireLease(pool, t.id, 'other', LEASE_MS);
    expect(taken?.leaseOwner).toBe('other');
    // The original owner's CAS now fails: it lost the lease.
    expect(await casTransition(pool, cas(t, TransferState.DEBIT_SENT, owner))).toBeNull();

    expect(await releaseLease(pool, t.id, 'not-me')).toBe(false);
    expect(await releaseLease(pool, t.id, 'other')).toBe(true);
    expect((await getTransfer(pool, t.id))?.leaseOwner).toBeNull();

    const done = await created();
    const s1 = await casTransition(pool, cas(done.t, TransferState.DEBIT_SENT, done.owner));
    if (s1 === null) throw new Error('cas failed');
    await casTransition(pool, cas(s1, TransferState.FAILED, done.owner, { terminal: true }));
    expect(await acquireLease(pool, done.t.id, 'other', LEASE_MS)).toBeNull();
  });
});

describe('claimDue (section 13 recovery claim query)', () => {
  it('claims due, non-terminal transfers whose lease is free or expired, oldest first, and nothing else', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const make = async (state: string, nextAttempt: string, lease: string | null): Promise<string> => {
        const res = await client.query<{ id: string }>(
          `INSERT INTO transfers (client_id, idempotency_key, request_hash, payer_bank_id, payer_account_id,
                                  payee_bank_id, payee_account_id, amount, state, next_attempt_at, lease_owner, lease_expires_at)
           VALUES ($1, $2, 'h', 'bank_a', 'A', 'bank_b', 'B', 1, $3, ${nextAttempt},
                   $4, ${lease === null ? 'NULL' : lease})
           RETURNING id`,
          [uniqueId('c'), uniqueId('k'), state, lease === null ? null : 'holder'],
        );
        return res.rows[0]?.id ?? '';
      };
      // '-infinity' puts these ahead of any due row already in the shared database.
      const dueFree = await make('DEBIT_SENT', "'-infinity'", null);
      const dueExpired = await make('REVERSING', "'-infinity'", "now() - interval '1 second'");
      const dueLeased = await make('CREDIT_SENT', "'-infinity'", "now() + interval '1 minute'");
      const notYetDue = await make('DEBITED', "now() + interval '1 hour'", null);
      const terminal = await make('FAILED', "'-infinity'", null);
      const success = await make('SUCCESS', "'-infinity'", null);

      const claimed = await claimDue(client, 'recovery-1', LEASE_MS, 2);
      expect(new Set(claimed.map((t) => t.id))).toEqual(new Set([dueFree, dueExpired]));
      for (const t of claimed) {
        expect(t.leaseOwner).toBe('recovery-1');
        expect(t.leaseExpiresAt?.getTime()).toBeGreaterThan(Date.now() + LEASE_MS - 3000);
      }

      // A second claim cannot take what the first just leased.
      const again = await claimDue(client, 'recovery-2', LEASE_MS, 50);
      const mine = new Set([dueFree, dueExpired, dueLeased, notYetDue, terminal, success]);
      expect(again.filter((t) => mine.has(t.id))).toEqual([]);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
