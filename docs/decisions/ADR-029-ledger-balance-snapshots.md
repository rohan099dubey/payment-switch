# ADR-029 — Ledger balance snapshots: details section 19 leaves open

- **Status:** Accepted
- **Date:** 2026-10-08
- **Milestone:** P2-5 (phase 2, item 5)
- **Type:** Clarification of section 19 item 5, reconciled with section 7 and the
  "never store a running balance" rule; one migration, one invariant (I11)

## Context

Section 19, item 5: "**Ledger balance snapshots.** Periodic snapshot rows so `GetBalance`
reads only entries after the latest snapshot." Section 7 says balances are "derived, never
stored", explains why there is no mutable balance row (`transit` would serialize every
transfer behind one row lock), and calls snapshots out of scope for phase 1. CLAUDE.md
forbids "storing a running balance in the ledger". The spec does not say what a snapshot
holds, how often one is taken, how it stays consistent with concurrent postings, or how to
prove it correct.

Measured before this milestone, with 955,286 entries (477,653 on `transit`):
`GetBalance('transit')` p50 87 ms and `GetTrialBalance` p50 215 ms, both growing linearly
with the ledger (`docs/benchmarks.md`, "Balance snapshots").

## Decisions

| Topic | Decision | Why |
|---|---|---|
| What a snapshot is | `balance_snapshots(id, last_entry_id UNIQUE, created_at)` plus `balance_snapshot_lines(snapshot_id, account_id, debit_total, credit_total)`: each account's totals over every entry with `id <= last_entry_id` | A checkpoint of a prefix of the sum, not a running balance. It is written once and never updated, so it has no row lock to contend on, and the section 7 reason against stored balances does not apply |
| Immutability | Both tables get the `forbid_mutation` triggers (UPDATE, DELETE, TRUNCATE), like journals and entries | A snapshot that could be edited would be a stored balance by another name |
| Database checks | A deferred constraint trigger requires, at commit, exactly one line per account and balanced totals (debits = credits) | Any correct prefix of a zero-sum ledger is zero-sum. Same pattern as `entries_balanced` |
| Totals type | `numeric(38,0)` | `SUM(bigint)` is `numeric` in Postgres; totals can outgrow `bigint` long before any single entry does |
| The cut | The writer takes `LOCK TABLE entries IN SHARE MODE` only to read `max(id)` (W), then commits. `SHARE` waits for every posting transaction in flight, which holds `ROW EXCLUSIVE` until it commits. So every id ≤ W belongs to a committed or rolled-back transaction, and every later insert gets a larger id (the identity sequence has `CACHE 1`) | Entry ids are allocated at insert, not at commit, so "id ≤ max(id)" is **not** a safe cut on its own: a posting with a smaller id can still be in flight. This is the stricter option; a lock-free variant based on a time margin cannot prove the cut |
| Cost of the lock | `SNAPSHOT_LOCK_TIMEOUT_MS` (default 200, at most 5,000). If the lock is not granted in time, the round is skipped (`lock_timeout`) and retried next tick | While the `SHARE` request waits, new postings queue behind it, so the timeout bounds the delay a snapshot can add to the payment path. A skipped snapshot only makes reads slower, never wrong |
| Computing it | Incremental, in a second transaction: the previous snapshot's lines plus the entries in (previous W, W]. `pg_advisory_xact_lock(727275)` serializes writers across Ledger instances; a writer that finds a snapshot at or beyond W does nothing (`up_to_date`) | Work proportional to new entries. Several Ledger instances are safe |
| Schedule | `SNAPSHOT_INTERVAL_MS` (default 60,000): a round every minute in every Ledger instance, rounds never overlapping in a process; `balance_snapshots_total{result}` counts created / up_to_date / lock_timeout / failed | At 50 transfers/s a minute is about 12,000 entries, a few milliseconds to sum. No new entries, no new snapshot |
| Reads | `GetBalance` and `GetTrialBalance` read the latest snapshot's lines plus the entries with `id > last_entry_id`, through a new covering index `entries (account_id, id) INCLUDE (direction, amount)`, still in one `REPEATABLE READ READ ONLY` transaction. With no snapshot, `last_entry_id` is 0 and the query is the old full sum | Section 19 item 5 exactly. The write path (`PostJournal`) never reads a snapshot |
| Retention | Snapshots are never deleted | Append-only, like the rest of the ledger; at one per minute the lines are about 7,200 rows a day |
| Proof | Invariant **I11**: (a) every snapshot equals the raw sums of the entries it covers, recomputed independently in one pass over `entries`; (b) `GetTrialBalance` equals the raw sum over all entries while the ledger is quiet. In `npm run invariants` and both chaos tests | The chaos runs take snapshots under full load, so I11 checks the cut where it matters |
| No API change | No new RPC; `ledger.proto` is unchanged | Tests call the writer directly (`createSnapshot`), as a second Ledger instance would |

## Verification

- `tests/integration/ledgerSnapshots.test.ts`: snapshots taken back to back while 600
  journals are posted 64 at a time pass I11; the query plan reads exactly the entries
  after the latest snapshot; both tables reject UPDATE, DELETE and TRUNCATE; an
  unbalanced, incomplete or empty snapshot is rejected (checked with
  `SET CONSTRAINTS ALL IMMEDIATE` in a transaction that always rolls back, so no fake
  snapshot can reach a shared database); a writer facing an uncommitted posting gives up
  after its lock timeout instead of covering it.
- Mutants, run in a throwaway Compose project (never against the shared stack, because
  snapshots are permanent): no `LOCK TABLE` (caught 3/3 by the in-flight test, 1/3 by the
  concurrent I11 test, whose race window is about a millisecond); a snapshot that drops the
  previous totals (caught by I11 and the read test); a read path with `>=` instead of `>`
  (caught by I11 and the exact plan count).
- An empty database found a real bug: `SELECT last_entry_id::text … ORDER BY last_entry_id`
  sorts the **text** output column, so '982' > '2414'. On the development stack every id had
  six digits and it never showed. It could only make the writer start from an older (still
  correct) snapshot and fail on a duplicate key, never write wrong totals, which I11 then
  confirmed on all 41 development snapshots. Fixed with distinct aliases.

## Consequences

- Reads cost O(entries since the latest snapshot) instead of O(all entries): with a fresh
  snapshot, `GetBalance('transit')` p50 4.4 ms instead of 87 ms (`docs/benchmarks.md`).
- Every minute, postings may wait up to the time the in-flight ones take to commit, at most
  `SNAPSHOT_LOCK_TIMEOUT_MS`.
- One more index on `entries`, so each posting writes one more index entry.

## Alternatives considered

- **A mutable balance row per account.** Forbidden (section 7, CLAUDE.md), and the reason
  is real: `transit` is touched by every transfer.
- **Cut by time ("entries older than one minute").** Simple and lock-free, but a slow or
  stuck posting transaction older than the margin would be missed, silently. Not provable.
- **Cut by transaction visibility (`pg_current_snapshot()` stored with the snapshot).**
  Exact and lock-free, but the reader would have to test every later entry's `xmin` for
  visibility, and `xmin` wraparound makes that fragile. The short `SHARE` lock is simpler
  and its cost is bounded and measured.
- **Snapshot on demand (an RPC).** Not needed: the schedule plus the direct call in tests
  cover it, and the contract stays unchanged.
