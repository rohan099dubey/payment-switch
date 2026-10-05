# ADR-003 — Derived ledger balances, no hot balance row

- **Status:** Accepted
- **Date:** 2026-10-04 (from ARCHITECTURE.md)
- **Milestone:** M1

## Context

The ledger needs to report account balances. The obvious implementation keeps a
`balance` column on `accounts` and updates it as entries are posted.

Every single transfer touches the `transit` account — twice, once on the debit leg and
once on the credit leg. A mutable balance column there would mean every concurrent
transfer in the system contends for one row lock.

## Decision

**Store no balance.** `accounts` has no balance column. `GetBalance` sums the `entries`
rows for that account inside a `REPEATABLE READ READ ONLY` transaction and computes the
normal-side value: `debit_total - credit_total` for ASSET accounts,
`credit_total - debit_total` for LIABILITY accounts.

The ledger is append-only: inserts never conflict with each other, so transfer
throughput scales with Postgres rather than with lock contention on `transit`.

## Consequences

- Writes never serialize. Two transfers posting legs that both touch `transit` do not
  block each other at all.
- Reads get more expensive as `entries` grows, since a balance is an aggregate over
  every entry for that account. Acceptable at phase-1 volumes with
  `entries_account_idx`; balance snapshots are explicitly out of scope for phase 1 and
  listed as phase 2, item 5.
- There is no stored balance that can drift from the entries. The books cannot be
  internally inconsistent, which is what makes invariant I1 meaningful.
- Aggregates must run at `REPEATABLE READ READ ONLY` so a trial balance is a single
  consistent snapshot rather than a smear across concurrent commits. See ADR-004.

## Alternatives considered

- **A `balance` column updated per entry.** Simple and fast to read, but serializes
  every transfer behind the `transit` row and introduces a value that can disagree with
  the entries. Rejected.
- **Periodic snapshot rows plus a delta scan.** The right answer once `entries` is
  large, and it preserves the append-only property. Deliberately deferred to phase 2 so
  phase 1 has no premature optimisation to defend.
- **A materialized view.** Needs refreshing, and a stale refresh would break the
  invariant checks that are the whole point of the project.
