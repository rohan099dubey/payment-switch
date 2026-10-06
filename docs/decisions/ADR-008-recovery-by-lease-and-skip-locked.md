# ADR-008 — Recovery by lease and `SKIP LOCKED` polling, not a message queue

- **Status:** Accepted
- **Date:** 2026-10-04 (from ARCHITECTURE.md)
- **Milestone:** M6

## Context

A transfer can be left half-done: the Orchestrator may crash between a bank applying a
debit and the `DEBITED` state being saved, or a bank or the Ledger may be unreachable
and the step has to be tried again later. Something has to pick those transfers up and
finish them.

Two Orchestrator instances must never drive the same transfer at the same time, and a
crashed instance must not hold a transfer hostage.

## Decision

Poll the `transfers` table from a recovery worker running **in every instance**, and
coordinate with a **lease plus compare-and-set**. No message queue, no scheduler, no
external lock service in phase 1.

- **Claim** with `FOR UPDATE SKIP LOCKED`, taking only transfers that are non-terminal,
  due (`next_attempt_at <= now()`) and whose lease is null or expired. `SKIP LOCKED`
  means instances never block on each other and never claim the same row.
- **Lease** `lease_owner` is `INSTANCE_ID` plus a random token minted per drive attempt,
  so two drivers inside one process cannot share a lease. `LEASE_MS` is 15000, renewed
  on every successful compare-and-set.
- **Compare-and-set** on `(id, version, lease_owner)` guards every state write. Zero
  rows updated means another worker moved the transfer: throw `StaleTransferError`, stop
  driving, and do **not** retry the write.
- **Backoff** `min(1000 * 2^attempts, 60000)` ms plus up to 20% jitter, stored in
  `next_attempt_at`.
- **Give up** at `MAX_RECOVERY_ATTEMPTS` (20) into `NEEDS_MANUAL_REVIEW` with reason
  `RECOVERY_EXHAUSTED`.

The database is already the source of truth for transfer state, so it is also the only
thing that needs to be consulted to find work. Adding a queue would mean two places that
both believe they know what is pending.

## Consequences

- Recovery latency is bounded by `LEASE_MS` plus `RECOVERY_POLL_MS` — up to ~16 seconds
  after a crash before another instance takes over. Acceptable here; a queue would be
  faster.
- The polling query runs once per second per instance forever, even when idle. The
  partial index `transfers_recovery_idx` keeps that cheap.
- Correctness does not depend on at-most-once delivery from any broker. A transfer
  claimed twice is still safe because every step is idempotent and every write is
  compare-and-set guarded.
- Killing an Orchestrator at any instant is safe, which is what the crash recovery and
  invariant tests exercise.

## Alternatives considered

- **A message queue (Kafka/SQS) carrying pending work.** Lower latency, but duplicate
  and out-of-order delivery still require the same lease and CAS machinery underneath,
  so it adds infrastructure without removing any of the hard parts. Phase 2 adds Kafka
  for *events*, deliberately not for driving the saga.
- **A single leader doing all recovery.** Needs leader election, and the leader becomes
  a throughput bottleneck and a failure domain.
- **`SELECT ... FOR UPDATE` without `SKIP LOCKED`.** Instances would serialize behind
  each other on the same rows, converting parallel recovery into a queue of waiters.
- **`pg_notify` / `LISTEN` instead of polling.** No durability — a notification sent
  while an instance is down is simply lost, which is exactly the case recovery exists
  for.

## As built (checked in M9, 2026-10-07)

- `services/orchestrator/src/recovery/worker.ts` and `repo/transfersRepo.ts`
  (`claimDue`). Refinements in ADR-020: the claim query takes one lease token per batch
  (`{INSTANCE_ID}:recovery:{uuid}`), and each row is still leased separately; the lease
  is renewed before each transfer is driven, and a transfer whose lease has lapsed is
  skipped. ADR-018: the compare-and-set also matches `state`.
- Proven by `tests/integration/failurePaths.test.ts` (a SIGKILLed Orchestrator's
  transfer is finished by a second instance, only after the lease expired),
  `tests/chaos/crashRecovery.test.ts` (200 in-flight transfers) and
  `services/orchestrator/test/recovery/worker.test.ts`.
