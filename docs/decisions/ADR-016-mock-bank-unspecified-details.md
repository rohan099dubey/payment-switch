# ADR-016 — Mock Bank details the spec leaves open

- **Status:** Accepted
- **Date:** 2026-10-05
- **Milestone:** M2
- **Type:** Clarification of ambiguities (no contract, schema or file changes)

## Context

Section 8 specifies the money operations, `Resolve` and the chaos engine precisely. It
says nothing, or says contradictory things, about five details the implementation had to
decide. Per `CLAUDE.md`, each one takes the stricter option.

## Decisions

### 1. Error codes for errors section 8 does not name

Section 14 says *every* gRPC error carries an upper-case `x-error-code`. The bank's
table only covers money-operation outcomes. Added:

| `x-error-code` | gRPC status | When | `classify` |
|---|---|---|---|
| `INVALID_REQUEST` | `INVALID_ARGUMENT` | Malformed input: empty reference/account, amount <= 0 or > int64, currency not `[A-Z]{3}`, Resolve on `REVERSE_DEBIT` | `BUG` (correct: the Orchestrator built a bad request) |
| `ACCOUNT_ALREADY_EXISTS` | `ALREADY_EXISTS` | `CreateAccount` on a taken id (admin only) | n/a |
| `CHAOS_CONFIG_INVALID` | `INVALID_ARGUMENT` | `SetChaosConfig` rejected | n/a |
| `BANK_UNAVAILABLE` | `UNAVAILABLE` | Chaos `down` or `reject_rate` | `UNKNOWN_OUTCOME` (correct) |

### 2. `balance_after` on a replay

Section 8 says an idempotent replay "returns the original result", but
`operations` (section 10, used verbatim) does not store the balance after the original
call. A replay returns the original `bank_txn_id`, `status` and `applied_at` (the row's
`created_at`). `balance_after` is the account's balance **at replay time**. Adding a
column to store the original was rejected: it changes the spec schema, and nothing in
the switch reads `balance_after`.

### 3. `CURRENCY_MISMATCH` on Credit

Section 8 says Credit's rejections are "`ACCOUNT_NOT_FOUND` and `ACCOUNT_BLOCKED` only".
But Credit is "the same [conditional UPDATE] with `balance + $amount`", which includes
`currency = $cur`. Section 14's failure table also lists `CURRENCY_MISMATCH` from "bank
debit or credit" leading to `REVERSED`. Credit therefore also rejects with
`CURRENCY_MISMATCH`. The alternative, reporting a currency mismatch as
`INSUFFICIENT_FUNDS` or similar, would be wrong. Diagnosis order for both operations:
not found, then blocked, then currency, then (debit only) insufficient funds.

### 4. `slow_ms` validation at runtime

Section 14 requires config loaders to enforce "`slow_ms` is larger than
`BANK_CALL_TIMEOUT_MS`" at startup. The bank reads `BANK_CALL_TIMEOUT_MS` (default 2000)
only for that check. `SetChaosConfig` enforces the same rule at runtime, but **only when
`late_apply_rate` or `lost_response_rate` is non-zero**. That is the only time `slow_ms`
is used, and proto3 cannot tell "unset" from 0. So `{down: true}` alone is still a valid
config. `SetChaosConfig` also rejects rates outside [0, 1], `latency_min_ms > latency_max_ms`,
and rate sums above 1 (with a 1e-9 tolerance, so 0.1 + 0.2 + 0.7 is accepted).

### 5. Chaos randomness streams

"One uniform draw per request" chooses the mode. Latency is drawn from a **second**
mulberry32 stream seeded from `seed ^ 0x9e3779b9`. Turning latency on therefore does not
change which requests fail. `down` short-circuits before any draw.
`SetChaosConfig` reseeds both streams, so re-sending the same config replays the same
sequence. Determinism is guaranteed for requests arriving in the same order. Concurrent
requests draw in arrival order, which the network does not fix.

## Consequences

- Every error the bank can produce has a documented code and a deliberate
  classification.
- Integration tests pin all five decisions (`tests/integration/mockBank.test.ts`).
