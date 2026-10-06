# ADR-004 — `READ COMMITTED` for writes, `REPEATABLE READ` for aggregates

- **Status:** Accepted
- **Date:** 2026-10-04 (from ARCHITECTURE.md)
- **Milestone:** M1, M2, M3

## Context

Postgres defaults to `READ COMMITTED`. The instinct in a money system is to reach for
`SERIALIZABLE` on the grounds that stronger is safer. That instinct is worth examining
rather than obeying, because `SERIALIZABLE` in Postgres means serialization failures and
therefore application-level retry loops on every write path.

## Decision

**All writes run at `READ COMMITTED`.** Every invariant in this system is guarded either
by one atomic statement or by one key conflict — never by read-then-write logic:

| Invariant | Guard |
|---|---|
| No double-spend | `UPDATE ... WHERE balance >= $amount` — check and decrement in one statement |
| No duplicate transfer | `INSERT ... ON CONFLICT DO NOTHING` on `(client_id, idempotency_key)` |
| No duplicate bank operation | primary key `(reference_id, operation)` |
| No duplicate journal | `UNIQUE` on `journals.idempotency_key` |
| No concurrent state write | compare-and-set on `(id, version, lease_owner)` |
| Every journal balances | deferred constraint trigger at commit time |

Because none of these depends on a stable read preceding a write, `SERIALIZABLE` would
add retry loops without adding protection.

**Read-only aggregates run at `REPEATABLE READ READ ONLY`** — `GetBalance` and
`GetTrialBalance` — so each sees one consistent snapshot. A trial balance computed at
`READ COMMITTED` could observe one leg of a journal and not the other and report itself
unbalanced, which would make invariant I1 flap under load.

## Consequences

- No write path needs serialization-failure retry handling.
- The correctness argument rests on the schema, not on isolation level. Removing any
  constraint listed above silently removes a guarantee, so none may be dropped for
  convenience.
- A trial balance taken mid-flight is consistent but not necessarily zero in `transit` —
  invariant I3 is only asserted once every transfer is terminal.

## Alternatives considered

- **`SERIALIZABLE` everywhere.** Adds `40001` retry loops to every write for protection
  the schema already provides. Also degrades sharply under the concurrency the invariant
  test applies (100 concurrent transfers).
- **`READ COMMITTED` everywhere, aggregates included.** Cheaper, but a trial balance
  could straddle a journal's two legs and report a false imbalance.
- **Advisory locks around balance reads.** Reintroduces exactly the contention ADR-003
  was written to avoid.

## As built (checked in M9, 2026-10-07)

- Every guard in the table exists as listed. One refinement (ADR-018): the
  compare-and-set also matches `state`, so it is on `(id, version, lease_owner, state)`.
- Proven under concurrency at `READ COMMITTED`: 50 concurrent debits against funds for
  10 give exactly 10 (`mockBank.test.ts`); 100 concurrent identical journal posts give one
  journal (`ledger.test.ts`); 50 concurrent identical transfer requests give one transfer
  and one debit (`idempotency.test.ts`).
