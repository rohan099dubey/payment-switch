# ADR-010 — Inline saga budget versus the `202` path

- **Status:** **OPEN** — decide during M3
- **Date raised:** 2026-10-05
- **Milestone:** M3

## Context

`ARCHITECTURE.md` gives these deadlines (section 14):

| Setting | Value |
|---|---|
| `SAGA_INLINE_BUDGET_MS` | 8000 |
| `ORCHESTRATOR_TIMEOUT_MS` (Gateway to Orchestrator) | 10000 |
| `BANK_CALL_TIMEOUT_MS` | 2000 |
| `LEDGER_CALL_TIMEOUT_MS` | 2000 |
| `INLINE_BANK_RETRIES` / `INLINE_LEDGER_RETRIES` | 2 each (so 3 attempts) |

The numbers do not close. A single `debitStep` can consume:

```
bank:   3 attempts x 2000 ms = 6000 ms
ledger: 3 attempts x 2000 ms = 6000 ms
                              -------
                              12000 ms   > 8000 ms budget
```

So one saga step can exhaust the entire inline budget on its own, before the credit step
is even attempted. A full success path has four steps that can each hit a bank or the
ledger.

This is **not a bug.** The saga is designed to `yield` when the budget runs out: it
increments `attempts`, sets `next_attempt_at`, releases the lease and returns the
transfer as it stands, and the Gateway answers `202` with a `Location` header. The
recovery worker finishes it. Money is never at risk.

But it has two consequences that affect how earlier milestones get built, which is why
it is worth deciding deliberately rather than discovering in M7:

1. **Under chaos, `202` becomes the common response, not the exception.** The invariant
   test runs with `reject_rate` 0.05, `late_apply_rate` 0.02 and `lost_response_rate`
   0.03, and `slow_ms` 3000 exceeds `BANK_CALL_TIMEOUT_MS` by design. Integration tests
   written in M3–M5 must treat `202` as a normal outcome and poll, not assert `201`.
2. **The recovery worker is load-bearing far earlier than the M0 to M9 ordering
   suggests.** M6 builds it, but M5's acceptance criterion (`lost_response_rate = 1`
   ends in `SUCCESS` with one debit) cannot pass inline — it *requires* recovery. Either
   that criterion is verified by polling after M6 lands, or M5 and M6 are effectively
   one milestone.

## Options

1. **Accept `202` as normal.** Change nothing. Write every integration test from M3
   onward to poll `GET /v1/transfers/{id}` to a terminal state rather than asserting a
   status on the create call. Most faithful to the spec; makes the asynchronous path the
   default and therefore the well-tested one.
2. **Raise `SAGA_INLINE_BUDGET_MS`** toward `ORCHESTRATOR_TIMEOUT_MS` (e.g. 9000). Buys
   almost nothing — 12000 still exceeds it — and reduces the Gateway's margin.
3. **Cut `INLINE_BANK_RETRIES` / `INLINE_LEDGER_RETRIES` to 1** (2 attempts each). Worst
   case per step becomes 8000 ms, which fits the budget for a single step but still not
   for a full four-step path. Makes inline success likelier in the common case and leans
   harder on recovery for the rest.
4. **Lower `BANK_CALL_TIMEOUT_MS`.** Not available: the spec requires the Mock Bank's
   `slow_ms` (3000) to exceed it, and the config loader must enforce that at startup.

## Decision

TODO — M3.

Leaning toward **option 1 plus the test-polling discipline**, because the spec's
constraint that `slow_ms` must exceed `BANK_CALL_TIMEOUT_MS` means timeouts are
*intended* to happen, and a design whose asynchronous path is exercised constantly is
better tested than one where it is a rare branch. Option 3 is a reasonable addition if
inline latency turns out to matter for the k6 numbers in M8.

## Consequences

TODO once decided. Must state explicitly whether M5's `lost_response_rate = 1`
acceptance criterion is deferred until M6 lands.
