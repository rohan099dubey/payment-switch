# ADR-010 — Inline saga budget versus the `202` path

- **Status:** Accepted (decided in M3, 2026-10-05)
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

**Option 1, made strict: keep every spec number, accept `202` as a normal outcome, and
make the inline budget a hard bound rather than a loop-top check.**

All values stay exactly as section 14 gives them (8000 / 10000 / 2000 / 2000 / 2 / 2).
The project owner stated no preference, so per `CLAUDE.md` the stricter option wins.
Options 2 and 3 change spec numbers to make a symptom rarer; neither closes the gap
(12000 ms still exceeds 9000 ms; a four-step path still exceeds 8000 ms), so they would
only hide the asynchronous path, not remove it.

The real defect is not the size of the budget but that section 6's pseudocode checks the
deadline **only at the top of the loop**. A step that starts at 7.9 s can then run for
another 12 s, so `CreateTransfer` would answer after ~20 s, long after the Gateway's
`ORCHESTRATOR_TIMEOUT_MS` (10 s) gave up. The client would see a gateway timeout instead
of the intended `202`. That breaks the guarantee the startup check
"`SAGA_INLINE_BUDGET_MS` < `ORCHESTRATOR_TIMEOUT_MS`" exists to give. So, in inline mode:

1. **Every downstream attempt checks the deadline before it starts.** If less than
   `MIN_ATTEMPT_MS` (100 ms) of the budget is left, the attempt is not made; the step
   result is `UNKNOWN_OUTCOME` and the saga yields. Not calling is always safe in a
   `*_SENT` state: the intent is already committed, so recovery makes the call.
2. **Each call's gRPC deadline is `min(BANK_CALL_TIMEOUT_MS or LEDGER_CALL_TIMEOUT_MS,
   time left in the budget)`.** A shorter deadline can only turn a would-be answer into
   an unknown outcome, which the design already settles with retries and `Resolve`.
   It can never turn an unknown into a failure.
3. **Inline retries stop when the budget is spent**, even if `INLINE_*_RETRIES` attempts
   remain (`withRetry`'s `shouldRetry` also checks the remaining budget).

Result: inline `advance` returns within `SAGA_INLINE_BUDGET_MS` plus one CAS round trip,
always inside the Gateway's 10 s. In recovery mode (M6) there is no inline deadline and
calls use the full per-call timeouts.

Point 2 shortens a per-call deadline below the section 14 table value, so it is listed
under "Active deviations" in `docs/CONTEXT.md`.

## Consequences

- **`202` is a normal outcome, not an error.** Every integration test from M3 onward
  that creates a transfer goes through one helper that accepts the `CreateTransfer`
  response and, if it is non-terminal, polls `GetTransfer` until the transfer is
  terminal or a timeout expires. No test asserts "terminal on the create call" except
  where the scenario guarantees it (chaos off, all services up).
- **Before M6 a yielded transfer never progresses**, because nothing drives it. The M3
  integration tests run with chaos off, where every path completes inline in tens of
  milliseconds. A yield in M3 tests is therefore a real failure, and the poll helper
  times out and fails the test rather than masking it.
- **M5's `lost_response_rate = 1` criterion is deferred until M6 lands.** With every
  response lost, every inline attempt times out and the saga must yield; only the
  recovery worker (re-run, then `Resolve` → `APPLIED`) can finish it. M5 must not tick
  that box. It is verified, by polling, in the M6 session, and the M5 box is ticked
  then with a note.
- The k6 numbers in M8 are measured with chaos off, where the budget is never touched.
  If inline latency under chaos matters later, option 3 can still be added by config,
  with no code change.

## Amendment (M5, 2026-10-06)

The M5 box for `lost_response_rate = 1` was **moved to M6's acceptance list** in
`docs/PROGRESS.md`, instead of staying in M5 unticked until M6. The criterion is unchanged
and still has to be observed passing. It now lives in the milestone that can satisfy it,
which matches section 16, where it belongs to the `failurePaths` tests. The alternative,
declaring M5 `DONE` with an open box, would contradict the merge policy that every box is
ticked.
