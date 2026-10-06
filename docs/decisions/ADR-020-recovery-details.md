# ADR-020 — Recovery worker details the spec leaves open

- **Status:** Accepted
- **Date:** 2026-10-06
- **Milestone:** M6
- **Type:** Clarification (no contract, schema or config changes)

## Context

Sections 6 and 13 specify the recovery loop, the claim query, the `Resolve` branches and
exhaustion. Some details are left open; each takes the stricter option.

## Decisions

| Topic | Decision | Why |
|---|---|---|
| Where `Resolve` lives | `SagaEngine.settle()`, next to `advance`: `Resolve` → (`APPLIED`: leg journal, CAS to `DEBITED`/`CREDITED`, `advance`) or (`VOIDED`: `FAILED` / `DEBIT_NOT_CONFIRMED` or `REVERSING` / `CREDIT_NOT_CONFIRMED`, then `advance`) | The same CAS, logging, metrics and stale-lease handling as every other state change; the worker only decides *which* call to make (`recoveryAction`, a pure function) |
| `Resolve` errors | Retried inline like any bank call (`INLINE_BANK_RETRIES`); `UNKNOWN_OUTCOME` → yield; a `BUG`-class error, any definite failure, or an answer other than `APPLIED`/`VOIDED` → `NEEDS_MANUAL_REVIEW` / `BANK_INVARIANT_VIOLATION` | The bank promises `Resolve` never answers `NOT_FOUND`; anything else is a broken contract, not a business outcome |
| `APPLIED` but the Ledger is unreachable | Yield in `*_SENT`. The next run calls `Resolve` again (`attempts` is still >= 3), gets the same `APPLIED`, and posts the leg | `Resolve` is final once answered and the leg journal key is derived, so repeating both is idempotent |
| Order of checks | Exhaustion (`attempts >= MAX_RECOVERY_ATTEMPTS`) first, in **every** non-terminal state, `REVERSING` included; then `Resolve` only for `DEBIT_SENT`/`CREDIT_SENT` at `attempts >= RESOLVE_AFTER_ATTEMPTS`; otherwise `advance` | Scenario 11: a reversal is retried "until it works (or `NEEDS_MANUAL_REVIEW` after 20 attempts)", and is never resolved by voiding |
| Lease owner | One token per claim (`{INSTANCE_ID}:recovery:{uuid}`), because the §13 claim query takes a single `$1` for the batch. Each row is still leased separately | A different row is a different lease. Inline drives and later claims always get fresh tokens |
| Late items in a batch | Before driving each claimed transfer, the worker calls `renewLease` (`WHERE lease_owner = me AND lease_expires_at > now()`). If that matches nothing, the transfer is skipped untouched | With 20 claimed and 5 lanes, an item can wait longer than `LEASE_MS`. Driving it then would be "driving a transfer whose lease it does not hold" (§6 "must never") |
| Unexpected errors | The transfer's lease is released (best effort) and the loop carries on with the rest of the batch | The transfer is retried on a later poll rather than after `LEASE_MS`; one bad row cannot stall recovery |
| `recovery_runs_total{result}` | `exhausted`, `resolved_applied`, `resolved_voided` when `Resolve` answered (even if the leg then had to yield); otherwise `advanced` if the transfer reached a terminal state or changed state, else `yielded` | The five labels in §17, assigned deterministically |
| `transfers_in_flight{state}` | One `GROUP BY state` query per loop; every non-terminal state is set, zeros included | A state that empties must drop to 0, not keep its last value |
| Event audit | Every `transfer_events.detail` now carries `driver` (`inline` / `recovery`) and `lease_owner`, as well as `request_id` for inline drives | The crash test proves *which instance* finished a transfer, and *when* relative to the lease expiry |
| Shutdown | `tryShutdown` the gRPC server (10 s for inline sagas), then stop the loop and wait up to 10 s for the batch in progress, then close the pool | §6 Shutdown order; anything unfinished keeps its lease, which expires |
| Repo-level tests vs the live worker | `orchestratorRepo.test.ts` parks its synthetic rows (`next_attempt_at = 'infinity'`) while it runs and releases them in `afterAll`; their payer exists at no bank, so recovery fails them without moving money | Once the worker runs, a test that expires a lease would otherwise race it. Releasing the rows (instead of leaving them parked) keeps invariant I6 (nothing non-terminal) true |

## Consequences

- Unit tests (`test/recovery/worker.test.ts`, 39 cases) pin every row. A mutation run with
  six isolated planted bugs caught all six.
- `tests/integration/failurePaths.test.ts` proves the behaviour against the stack: a bank
  outage, a Ledger outage, `lost_response_rate = 1`, the `late_apply_rate = 1` tombstone
  race, and a SIGKILLed Orchestrator finished by a second instance after its lease expired.
