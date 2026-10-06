# ADR-001 — Orchestrated saga instead of two-phase commit

- **Status:** Accepted
- **Date:** 2026-10-04 (from ARCHITECTURE.md)
- **Milestone:** M3

## Context

A transfer must move money at two independent external banks and record both movements
in the ledger. The banks are separate systems with separate databases; there is no
shared transaction manager and no way to enlist them in one atomic commit. Both banks
and the ledger can time out, be unavailable, or apply a request after the caller has
given up.

## Decision

Use an **orchestrated saga**. The Orchestrator owns the lifecycle of every transfer and
drives it forward one *persisted* state at a time: debit the payer, credit the payee,
and on a definite credit failure compensate by reversing the debit. There is no
distributed commit; there is a forward path and a compensating path, and the current
position is always durable in `transfers.state`.

Orchestration (a central driver) is chosen over choreography (services reacting to each
other's events) because the state machine is small, strictly sequential, and far easier
to reason about and recover when one component holds it.

## Consequences

- There is a window where the payer has been debited and the payee has not been
  credited. That window is explicit in the model as `DEBITED` / `CREDIT_SENT`, and the
  money is accounted for in the ledger's `transit` account for its whole duration.
- Compensation is a real business outcome, not an error path: `REVERSED` is a terminal
  state the client can be shown.
- The Orchestrator is a single point of coordination, so it must be safe to run several
  instances and safe to kill at any moment. That is what the lease and compare-and-set
  machinery in ADR-008 exists for.
- Every step must be idempotent, because the saga will re-run steps after any unknown
  outcome. See ADR-005.

## Alternatives considered

- **Two-phase commit / XA.** Not available — the mock banks stand in for external
  institutions that would never expose a prepare phase. It also blocks on coordinator
  failure, which is precisely the failure this project is built to survive.
- **Choreographed saga over a message bus.** More decoupled, but the transfer state ends
  up smeared across services with no single place to ask "where is this transfer?".
  Rejected for phase 1; the outbox and Kafka work in phase 2 adds events without moving
  the state.
- **Best-effort with a reconciliation sweep only.** Would leave money mismatched between
  banks for minutes at a time and makes exactly-once impossible to demonstrate.

## As built (checked in M9, 2026-10-07)

- `SagaEngine` (`services/orchestrator/src/domain/saga.ts`) drives the state machine;
  each step is a compare-and-set plus a `transfer_events` row, committed before the next
  external call.
- Refined by ADR-010: the inline budget is a hard bound, and a transfer that runs out of
  it is answered `202` and finished by recovery, never failed.
- Proven by `tests/integration/orchestrator.test.ts` (success, `FAILED`, `REVERSED`, with
  their event trails) and the 10,000-transfer invariant test (I1–I7, twice).
