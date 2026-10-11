# ADR-031 — An unexpected error during a recovery drive yields with backoff

- **Status:** Accepted
- **Date:** 2026-10-11
- **Milestone:** post-phase-2 follow-up (filed 2026-10-08, SESSION_LOG session 4)
- **Type:** Interpretation (section 6 does not say what recovery does when a drive throws)

## Context

On 2026-10-08 transfer `4bad8053` on the development stack reached `CREDITED` after a test
had committed an outbox row for it (payload `{}`; SESSION_LOG, session 4). Every
`CREDITED -> SUCCESS` compare-and-set then failed inside its transaction with a duplicate
key on `outbox_one_event_per_transfer`, because a terminal transition writes its outbox
event in the same transaction (ADR-025). The recovery worker caught the error, released the
lease and returned. The transfer was due again at once (`next_attempt_at` unchanged), so
every poll (1 s) claimed it, failed and released it again. `attempts` stayed 0, so the
`MAX_RECOVERY_ATTEMPTS` rule (20) that exists for exactly this, "retried until it works, or
`NEEDS_MANUAL_REVIEW`", never fired. It was a hot loop with no end.

Section 6 defines two ways a drive can stop short: a stale CAS (stop, do not retry the
write) and `yield` for an unknown outcome (`attempts + 1`, `next_attempt_at = now() +
backoff(attempts)`, lease released). It does not cover an exception that is neither: the
database refusing a write, or a programming error. The `catch` in the worker
treated that as "retry on the next poll", the loosest reading.

## Decision

1. **In recovery mode, `SagaEngine` yields on any error that is not `StaleTransferError`**
   (`aborted` in `domain/saga.ts`, used by `advance`, `settle` and `exhaust`). It is the
   section 6 `yield` unchanged: the same guarded `yieldTransfer` (`id`, `version`,
   `lease_owner`), the same backoff, state unchanged, no `transfer_events` row and no
   version bump, as for every yield. The transfer it yields is the one this drive last
   wrote, so the version guard matches even when the error comes after earlier
   transitions in the same drive. The error is logged at `error` with the state, version
   and attempts. The worker reports the run as `yielded`.
2. **Repeated failures therefore follow the existing rules**: backoff 2, 4, 8 … 60 s, and at
   `MAX_RECOVERY_ATTEMPTS` the worker escalates to `NEEDS_MANUAL_REVIEW` /
   `RECOVERY_EXHAUSTED`. If the escalation write fails too, `exhaust` yields as well: the
   escalation is retried every 60 s, never in a loop.
3. **If the yield itself fails** (the database is unreachable), the original error
   propagates and the worker **keeps the lease**: it expires after `LEASE_MS` (15 s),
   and that is the backoff. The worker no longer releases the lease in its `catch`,
   because releasing it is what let the next poll retry at once. `releaseLease` left
   the `RecoveryStore` port; the inline handler still uses it.
4. **Unchanged:** the classification of downstream answers (`classify`, `DEFINITE_FAILURE` /
   `UNKNOWN_OUTCOME` / `BUG`). Those are handled in `SagaEngine.call` and never thrown.
   `StaleTransferError` still means stop without retrying the write. Every state change is
   still one CAS on `version` plus its `transfer_events` row. Inline drives
   (`CreateTransfer`) still propagate the error. The handler releases the lease, and
   recovery takes over with this rule from its first attempt.

## Alternatives rejected

- **Yield from the worker's `catch`.** The worker knows only the transfer as claimed. After
  a transition earlier in the same drive, its version is stale and the yield would
  match nothing. The saga knows the current row.
- **Treat the error as `BUG` and go to manual review at once.** A database blip (failover,
  a dropped connection) would send healthy transfers to manual review. The spec's own
  answer to "keeps failing" is the attempt limit.
- **Write the outbox event with `ON CONFLICT DO NOTHING`.** It would let `4bad8053` reach
  `SUCCESS` with the wrong event (`transfer.failed`, payload `{}`) silently on the topic.
  That breaks I8 instead of reporting the problem.

## Consequences

- A transfer whose writes keep failing costs one attempt per backoff period, not one per
  poll. After 20 attempts (the backoffs sum to 962 s, up to about 19 minutes with jitter) it is escalated, or, if the escalation
  cannot be written either, it waits at 60 s intervals with `attempts` above 20, visible
  in `transfers_in_flight` and the error log.
- **Transfer `4bad8053` (development stack).** Its case is the second branch: the
  planted row also blocks `NEEDS_MANUAL_REVIEW`, so with this change it backs off to
  one attempt a minute but cannot finish until the owner removes the row. Order
  matters. If the row is removed while `attempts < 20`, the next attempt reaches
  `SUCCESS` (correct: both legs and journals are posted). Once the rebuilt Orchestrator
  has run on it for 16 to 19 minutes, `attempts >= 20`, and removing the row then sends
  it to `NEEDS_MANUAL_REVIEW` / `RECOVERY_EXHAUSTED` instead. That fails I6 for the
  development stack until someone resolves it by hand. The integration test shows the
  first ordering on a scratch database.
- Tests: unit (`test/domain/saga.test.ts`, `test/recovery/worker.test.ts`) and
  integration (`tests/integration/recoveryBackoff.test.ts`). The integration test plants
  the conflicting row in a **scratch database** it creates on the orchestrator's Postgres
  server, migrates and drops. It never writes `orchestrator_db`, and the live recovery
  worker never sees its rows.
