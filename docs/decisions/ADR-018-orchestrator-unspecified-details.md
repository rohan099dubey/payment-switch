# ADR-018 — Orchestrator details the spec leaves open

- **Status:** Accepted
- **Date:** 2026-10-05
- **Milestone:** M3
- **Type:** Clarification of ambiguities (no contract or schema changes; the migration is verbatim)

## Context

Sections 6, 11, 13 and 14 specify the saga, the CAS statement and the failure codes. A
handful of details are unstated, or stated differently in two places. Per `CLAUDE.md`,
each one takes the stricter option. ADR-010 (the inline budget) and ADR-017 (Ledger
invariant rejections) are recorded separately.

## Decisions

### 1. The CAS also matches `state`

Section 6's module table says `transition()` compare-and-sets on `(id, version, state)`.
Section 13's statement matches `(id, version, lease_owner)`. The implementation matches
**all four**: `WHERE id = $1 AND version = $2 AND lease_owner = $7 AND state = $9`.
`version` already implies `state` for a correct caller, so this costs nothing. It also
means a caller holding a wrong in-memory state can never write. The repo integration
test pins each guard separately, and a mutation run that dropped the state and lease
guards failed 4 of its tests.

### 2. Bank errors the failure table does not name are bugs

Section 14 names `BANK_INVARIANT_VIOLATION` only for `ReverseDebit`. The saga uses it for
**every** bank error that is not a recognised business answer:

| Bank answer | Result |
|---|---|
| `BUG` class at any step (`INVALID_REQUEST`, `REFERENCE_CONFLICT`, `NOTHING_TO_REVERSE`, `PERMISSION_DENIED`, …) | `NEEDS_MANUAL_REVIEW` / `BANK_INVARIANT_VIOLATION` |
| `DEFINITE_FAILURE` whose `x-error-code` is not in that step's table (e.g. `INSUFFICIENT_FUNDS` on a Credit, a missing trailer, a code added later) | the same |
| Any `DEFINITE_FAILURE` from `ReverseDebit` | the same (section 6: a refused refund is a broken invariant) |
| `OK` without `status = APPLIED` | the same (contract violation, never treated as success) |

The alternative, mapping an unrecognised definite failure to a generic `FAILED`, would
let the switch guess its way down a failure branch it does not understand. On the credit
side that guess triggers a refund.

### 3. Error codes for requests the spec does not name

| `x-error-code` | gRPC status | When |
|---|---|---|
| `INVALID_REQUEST` | `INVALID_ARGUMENT` | `CreateTransfer` with an empty `client_id`, `idempotency_key`, party, `bank_id` or `account_id`; `GetTransfer` with an empty `client_id` |
| `TRANSFER_NOT_FOUND` | `NOT_FOUND` | `GetTransfer` for an unknown id, a malformed id, or another client's transfer (indistinguishable on purpose) |

### 4. `transfer_events.reason` vocabulary

`TRANSFER_CREATED`, `DEBIT_INTENT`, `DEBIT_CONFIRMED`, `CREDIT_INTENT`,
`CREDIT_CONFIRMED`, `TRANSFER_COMPLETED`, `REVERSAL_CONFIRMED`. A failure transition's
reason is its failure code (`INSUFFICIENT_FUNDS`, `PAYEE_ACCOUNT_NOT_FOUND`,
`LEDGER_REJECTED`, …). That is the same string stored in `transfers.failure_code`, and
section 6 already uses `RECOVERY_EXHAUSTED` that way. `detail` carries the evidence:
`bank_txn_id`, `journal_id`, `error_code`, `grpc_code`, `message`, `bank_id`,
`request_id`.

### 5. `yield`

`attempts = attempts + 1` and `next_attempt_at = now() + backoff(new attempts)`. So the
first yield waits `backoff(1)` = 2–2.4 s. It releases the lease. It is not a state
change, so there is no `transfer_events` row and no version bump. It is still guarded
by `(id, version, lease_owner)`, so a driver that already lost the transfer cannot
reschedule it.

### 6. Extra startup checks

Section 14 requires `SAGA_INLINE_BUDGET_MS < ORCHESTRATOR_TIMEOUT_MS`, so the
Orchestrator reads `ORCHESTRATOR_TIMEOUT_MS` (default 10000) for that check only. It
also refuses `REPLAY_WAIT_MS >= ORCHESTRATOR_TIMEOUT_MS`, because a replay would then
outlive the Gateway's deadline. It refuses `LEASE_MS <= SAGA_INLINE_BUDGET_MS`, because
an inline saga could then outlive its own lease while still driving. `BANK_ENDPOINTS`
rejects duplicates and malformed entries. An empty `INSTANCE_ID` means the hostname.

### 7. Smaller choices

- The inline deadline is computed when the request **arrives**, not after the insert. The
  Gateway's 10 s deadline started even earlier.
- If the saga throws something unexpected (the database went away), the handler
  releases the lease before returning `INTERNAL`, so recovery can pick the transfer up
  immediately instead of after `LEASE_MS`. This is best effort.
- An empty proto `note` is stored as `NULL`. The request hash uses `note ?? ""` as the
  spec says, so the two forms hash identically.
- `NEEDS_MANUAL_REVIEW` is a legal target from every non-terminal state, because
  recovery exhaustion can strike anywhere. The unit test enumerates all 100 pairs.
- `manual_review_total{reason}` is registered now, not in M6, because M3 can already
  reach `NEEDS_MANUAL_REVIEW` (`LEDGER_REJECTED`, `BANK_INVARIANT_VIOLATION`).
- Every downstream call result is logged at `info` with `transfer_id`, `target`,
  `operation`, `bank_id`, `outcome`, `duration_ms` (section 17: one line per result).
- A `BANK_ENDPOINTS` bank without ledger accounts (`receivable:` / `payable:`) would
  reach `NEEDS_MANUAL_REVIEW` / `LEDGER_REJECTED` after its first debit. The
  Orchestrator does not probe the Ledger at startup: failing startup because the Ledger
  is briefly down would be worse. Adding a bank means adding its accounts first (section 7).

## Consequences

- Unit tests pin 2, 4, 5 and the transition map. The integration tests
  (`tests/integration/orchestrator.test.ts`, `orchestratorRepo.test.ts`) pin 1, 3, 4
  and 5 against the real database and services.
