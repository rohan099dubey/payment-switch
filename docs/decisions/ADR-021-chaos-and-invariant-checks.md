# ADR-021 — How the chaos tests and the invariant checker interpret section 16

- **Status:** Accepted
- **Date:** 2026-10-06
- **Milestone:** M7
- **Type:** Clarification (test and tooling only; no service change)

## Context

Section 16 defines I1–I7, the crash recovery test, the invariant test and
`npm run invariants`. It leaves several mechanics open, and the shared development
databases hold traffic that never went through the Orchestrator: the M1 and M2 tests call
the Ledger and the banks directly. They also hold the deliberately corrupt output of the
M3 mutation run (below). Each choice here takes the stricter option that still measures
the system, not the environment.

## Decisions

### Scope of the invariants

| Where | Scope | How I2–I4 are evaluated |
|---|---|---|
| `tests/chaos/*` | The run's accounts (baseline) and the run's transfers (idempotency-key prefix) | Against `snapshotBaseline()` exactly as §16 says: balances of the test accounts, `transit`, `receivable:*` / `payable:*` |
| `scripts/checkInvariants.ts` | Every transfer the Orchestrator knows, or `--since <ISO>` | **Per transfer**, from the evidence alone: money out of payers (debits minus refunds) equals money into payees; the journals carrying those ids leave `transit` unchanged; per bank, the customer effect plus (receivable change minus payable change) is zero. This is exact even though the ledger and banks also hold direct test traffic |

I1 is global in both (every journal in `ledger_db` balances). Before a baseline, the chaos
tests **quiesce**: they wait until no transfer anywhere is in flight, because the recovery
worker finishing earlier work would move money during the run ("No other traffic may hit
the stack").

### I5 is stricter than the table

Evidence comes from `Bank.GetOperation` (both banks) and `Ledger.ListJournals`, as §16
prescribes, collected with 32 calls in flight. On top of the table: every applied
operation and every journal line must carry exactly the transfer's amount. For `FAILED`,
the payee `CREDIT` and the payer `REVERSE_DEBIT` must be **absent** (NOT_FOUND), not merely
"not applied".

### Workload and client

- `TEST_SEED` (default 1) seeds the workload PRNG, the banks' own `mulberry32`. It picks
  payers, payees, amounts, ghosts and duplicates. The bank chaos seed stays 42, as §16 fixes it.
  "Twice in a row with different test seeds" means `TEST_SEED=1`, then `TEST_SEED=2`.
- Payer and payee are always distinct accounts: a same-account request is a 400, not a
  transfer. 5 % go to a non-existent payee at a random bank, which forces reversals. 5 % are
  sent twice at the same moment (same key, same body).
- Requests are spread round-robin over the four development API clients, because each
  has its own rate-limit bucket. A 429 waits out `Retry-After` and does not use up a retry:
  it is the limiter, not a failure (README client guidance).
- 5xx or network error: up to 10 retries, 500 ms apart, with the same key (§16 step 4).
- **A request still failing after its 10 retries is sent again later** with the same key,
  once the kills are over and chaos is cleared. It must then get an answer: the same
  transfer if one was registered (checked as an I7 sample), or a new one, which must also
  finish and satisfy every invariant. The test fails if any request is still unanswered.
  Reason: a kill-and-restart takes about 5 s on Docker Desktop for Windows (2 s of §16's
  wait plus about 1.7 s for `docker compose start` alone), which is about the 10 × 500 ms
  retry window. Whether a request fits that window measures the container runtime, not
  the switch. Dropping the "every request answered" requirement would have been looser.
- The kills fire when 25, 50 and 75 % of the requests have answered.

### Mechanics

- Waiting until every transfer is terminal reads `orchestrator_db`. Polling 10,000
  transfers through the rate-limited Gateway would measure the limiter.
- "Recovery runs" in the summary counts transfer events with `detail.driver =
  'recovery'`, because the Orchestrator's own counters reset at each kill.
- `npm run test:chaos` passes `--silent=false`. vitest 5 hides console output from
  passing tests, and §16 requires the summary to be printed.
- The crash test also asserts that the kill actually caught transfers (some 5xx answers)
  and that recovery finished some of them. Otherwise a passing test could prove nothing.

## Known data issue: M3 mutation artifacts

The unscoped `npm run invariants` reports I3, I4 and I5 failures. All of them trace to the
M3 mutation run on 2026-10-05, 18:40:31–18:41:00, whose planted bugs ran against the
shared databases:

- Mutant B ("reversal journal never posted"): 6 `REVERSED` transfers have only a
  debit leg, which leaves +6 × 12,500 in `transit`.
- Mutant E ("debit leg credits `payable`"): 20 debit legs credit `payable:bank_a`
  instead of `transit`, which is −20 × 12,500.

Net −175,000 is exactly the `transit` and `bank_a` discrepancy reported. The checker
working on real, deliberately broken books is useful evidence. The ledger is append-only,
so these rows cannot be fixed in place; inventing compensating journals is not in the
design. The fix is a clean slate (`npm run stack:down && npm run stack:up`), which is
the owner's call because it deletes every development database. Until then,
`npm run invariants -- --since <time>` checks everything after the artifacts. From M7 on,
mutation runs use their own databases, never the shared ones.

## Amendment (2026-10-07): resolved, and two facts from the first CI runs

- **The M3 mutation artifacts are gone.** The owner reset the development stack on
  2026-10-07 after a verified `pg_dumpall` backup
  (`D:\WORK\DEV\PROJECTS\PaymentSwitch_DEL_backups\2026-10-07-pre-reset\`). The unscoped
  `npm run invariants` passed on the reset stack. Afterwards, the ADR-024 red tests were
  (wrongly) run against the shared development stack while the bug was still live. They
  left exactly two inconsistent transfers: `c9346799` (FAILED, late debit applied, −1,000
  at bank_a) and `5c784905` (REVERSED, late credit applied, +1,000 at bank_b). The
  unscoped check reports I4/I5 for those two only, until the next reset. Red tests
  against unfixed code belong in a throwaway Compose project.
- **Crash test: `registered` can be less than `sent`.** The crash test sends each request
  once and never retries it. A request that reaches the Gateway while the Orchestrator is
  dead, before its `transfers` row is inserted, gets a retry-safe `503` and has no row and
  no effects. The test requires every *registered* transfer to finish and I1–I6 to hold
  over the test accounts, so a stray debit from an unregistered request would fail I2 or
  I4. On the first GitHub run it was 192 of 200. Docker Desktop has always registered 200,
  because its slower restart leaves fewer requests in the gap.
- **I7's sample count depends on the kill timing.** It covers the planned 5% duplicates
  plus every request resent after a kill, so the count varies by machine: 54 on the
  GitHub runner and 151 on Docker Desktop for `TRANSFER_COUNT=1000`, seed 1. Every sample
  must still return one id, the stored one, in a terminal state.
- **Run the unscoped checker only on a quiet stack.** Straight after
  `npm run test:integration` it can report I5/I6 failures for about 15 s.
  `orchestratorRepo.test.ts` hands its synthetic rows to recovery in `afterAll`, but they
  still hold their insert-time lease (`LEASE_MS` = 15 s), so recovery claims them only
  once the lease expires. They then fail cleanly (`PAYER_ACCOUNT_NOT_FOUND`). The checker
  is right to count in-flight transfers as violations, and it is not loosened. Neither CI
  job runs it straight after the integration suite.
- **Verification reads retry a reset connection (P2-1).** After Kafka joined the stack, two
  `npm run test:chaos` runs with 10,000 transfers failed at the very end with `read
  ECONNRESET`: the test's *first* connection to `postgres-ledger` (`checkI1`, about 150 s
  in). Postgres logged nothing, not even an incomplete startup packet, so the reset
  happened in Docker Desktop's port forwarder on Windows before the database was reached.
  The database never restarted. Windows `TIME_WAIT` peaked at 61 sockets, so it was not
  port exhaustion. A 1,000-transfer run and a later 10,000 run passed, and the scoped
  `npm run invariants` straight afterwards held on all 20,455 transfers. Every read-only
  verification query in `tests/helpers/invariants.ts` now goes through `readQuery`. It
  retries **only** connection-level errors (`ECONNRESET`, `ECONNREFUSED`, `EPIPE`,
  "Connection terminated"), at most twice, logging each retry to stderr. A SQL error
  or a wrong result fails at once, and the data checked is the same, so no invariant is
  loosened. The next two full runs logged 0 retries.
- **The test HTTP client retries a request with no HTTP response (P2-2).** The Gateway
  burst test (450 concurrent requests) twice timed out at 30 s. The Gateway's own logs
  showed why: in those runs only 445 and 448 requests ever arrived, while every passing
  run shows all 450. It answered everything it received, quickly. Connections lost on the
  way into Docker Desktop on Windows are the same family as the `ECONNRESET` above. Plain
  `fetch` has no timeout, so the test hung. `tests/helpers/gatewayClient.ts` now gives
  each request a 20 s timeout (above the Gateway's 10 s Orchestrator deadline) and retries
  **only** when no HTTP response arrived, at most twice, logging each retry. That is the
  client rule the README states: retry network errors with the same `Idempotency-Key`,
  which is safe by design. Every HTTP response, 4xx or 5xx, is returned unchanged.
- **The `GetBalance` integration test now waits for a quiet stack (P2-2).** It measures
  global account totals, and a transfer left to the recovery worker by an earlier test
  file posted a 1,000-paise journal in the middle of it. The test now waits until no
  transfer is in flight before measuring, as `failurePaths` does. The assertions are
  unchanged and exact.
