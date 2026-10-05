# ADR-002 — `Resolve` with tombstones to settle unknown outcomes

- **Status:** Accepted
- **Date:** 2026-10-04 (from ARCHITECTURE.md)
- **Milestone:** M2 (bank side), M6 (orchestrator side)

## Context

When a call to a bank times out or returns `UNAVAILABLE`, the caller does not know
whether the money moved. The request may still be in flight and may commit *after* the
caller gives up. Retrying is safe (operations are idempotent) but retrying forever is
not an option — the transfer has to reach a terminal state.

Treating a timeout as a failure would be wrong: the debit may have applied, and marking
the transfer `FAILED` would lose real money. Treating it as a success would be equally
wrong.

## Decision

Give the bank a **`Resolve(reference_id, operation)`** RPC that forces a decision by
inserting a tombstone:

```sql
INSERT INTO operations (reference_id, operation, account_id, amount, status)
VALUES ($1, $2, NULL, NULL, 'VOIDED') ON CONFLICT DO NOTHING;
```

Then read the row back and return its status. The primary key
`(reference_id, operation)` arbitrates the race:

- If the real operation committed first, the insert conflicts and `Resolve` returns
  `APPLIED` — the money did move, so the saga continues.
- If the tombstone lands first, `Resolve` returns `VOIDED`, and a late-arriving `Debit`
  for that reference now hits the tombstone and fails with `REFERENCE_VOIDED`. It can
  never apply after being voided.

Once `Resolve` has answered, the answer never changes. The Orchestrator calls it only
after `RESOLVE_AFTER_ATTEMPTS` (3) ordinary retries have failed to get a definite
answer.

## Consequences

- An unknown outcome always becomes a known one in bounded time. No transfer is stuck
  waiting for a bank that will never answer.
- The database, not application logic or a timer, decides who wins the race. This is the
  single most important correctness property in the system.
- The bank must **not** check whether the client cancelled before applying — a late
  apply landing after the client gave up is exactly the case under test.
- `VOIDED` rows carry no `account_id` or `amount`, so the schema's `applied_has_money`
  check must permit nulls for them.
- `Resolve` is never used on a reversal. A reversal must eventually succeed, not be
  voided.

## Alternatives considered

- **Retry until a definite answer arrives.** Unbounded — a permanently broken bank would
  pin the transfer in a non-terminal state forever.
- **Assume failure on timeout and compensate.** Unsafe: a late-applying debit would land
  after the compensation, leaving the payer short with no record.
- **Query the bank's statement and reconcile later.** Too slow to answer a synchronous
  client, and it only shifts the race rather than resolving it. Reconciliation is still
  worth having as a safety net — it is phase 2, item 3.
