# CONTEXT — read this first

Orientation primer. Deliberately short so it is cheap to re-read at the start of every
session. `ARCHITECTURE.md` is the source of truth; this file compresses it and never
contradicts it. If something here is wrong, fix it here — do not edit the spec.

## What this is

A mini UPI-style **payment switch**. A client asks it to move money from an account at
one mock bank to an account at another. The switch debits the payer's bank, credits the
payee's bank, and records every movement in a **double-entry ledger**. The result is
**exactly-once** even when banks time out, responses are lost, or the switch itself
crashes mid-transfer.

## Where I am

| | |
|---|---|
| **Active milestone** | **None. Phase 1 milestones M0–M9 are all `DONE`.** |
| **Definition of done** | 6 of 8 ticked. **Open:** "tests pass in CI" needs a GitHub remote (the workflow has never run), and "explainable without notes" is the owner's to confirm. Phase 2 (§19) starts only when all 8 are ticked |
| **Next action** | The owner's decisions: add a GitHub remote and push (then watch the `static` and `integration` jobs, and trigger `nightly` with `workflow_dispatch`), and whether to reset the development stack (ADR-021) |
| **Read first for phase 2** | `ARCHITECTURE.md` section 19 (Phase 2 extensions), and only once the definition of done is complete |

`docs/PROGRESS.md` is authoritative for status — if it disagrees with this table,
believe `PROGRESS.md` and correct this one.

**Branch and merge policy** (the owner delegated merge decisions to Claude on 2026-10-05):
work on the session's branch. Merge into `main` only when the milestone is `DONE`: every
box ticked, and `lint`, `typecheck`, `test` and the acceptance commands green. Merge
fast-forward only (`git merge --ff-only`). If that is impossible, rebase onto `main`,
re-run the checks, then merge. Never merge a half-finished milestone. There is no git
remote yet, so nothing is pushed.

## Services

Four deployable services. Never merged, never sharing a database. Only the Gateway
speaks HTTP to the outside; everything internal is gRPC.

| Service | Ports | Owns | Calls |
|---|---|---|---|
| Gateway | HTTP 8080 | nothing durable (Redis = rate-limit buckets only) | Orchestrator |
| Orchestrator | gRPC 50051, HTTP 9101 | `orchestrator_db`: `transfers`, `transfer_events` | both banks, Ledger |
| Ledger | gRPC 50052, HTTP 9102 | `ledger_db`: `accounts`, `journals`, `entries` | nothing (leaf) |
| Mock Bank A | gRPC 50061, HTTP 9111 | db `bank_a` | nothing |
| Mock Bank B | gRPC 50062, HTTP 9112 | db `bank_b` | nothing |

Orchestrator and Ledger each get a dedicated Postgres container. The two banks share
one container (`postgres-banks`, two databases) because they stand in for *external*
systems. HTTP ports serve `/healthz`, `/readyz`, `/metrics` only.

## The state machine

Ten states, four terminal. Nothing ever leaves a terminal state, and **a timeout never
changes the current state**.

```text
INITIATED -> DEBIT_SENT -> DEBITED -> CREDIT_SENT -> CREDITED -> SUCCESS  (terminal)
                  |                        |
                  | definite failure       | definite failure
                  v                        v
             FAILED (terminal)        REVERSING -> REVERSED (terminal)
                                           |
                       bug / 20 attempts   v
                             NEEDS_MANUAL_REVIEW (terminal)
```

`*_SENT` is a **write-ahead state**: it means the call was attempted and its outcome is
not yet recorded. It is committed *before* the external call, which is the whole reason
a crash is recoverable. `DEBITED` means the bank confirmed **and** the ledger
`debit-leg` is posted — both, not either.

Each step has three possible outcomes, and that distinction is the heart of the design:

| Outcome | Means | Reaction |
|---|---|---|
| `DEFINITE_FAILURE` | bank said no (`FAILED_PRECONDITION`, `NOT_FOUND`) | take the failure branch |
| `UNKNOWN_OUTCOME` | timeout, `UNAVAILABLE`, socket reset — **money may or may not have moved** | stay in state; retry inline, then recovery, then settle with the bank's `Resolve` |
| `BUG` | invariant broken (`INVALID_ARGUMENT`, ledger rejecting a journal) | `NEEDS_MANUAL_REVIEW`, never retried |

When in doubt, classify as `UNKNOWN_OUTCOME` — it is the safe default because `Resolve`
can always settle it.

## Idempotency — three independent layers

Each has its own key and its own **database constraint**. None relies on application
logic.

| Layer | Key | Enforced by |
|---|---|---|
| Client to Orchestrator | `(client_id, Idempotency-Key)` | `UNIQUE` on `transfers` |
| Orchestrator to Bank | `(reference_id = transfer id, operation)` | primary key of bank's `operations` |
| Orchestrator to Ledger | `transfer:{id}:{leg}` | `UNIQUE` on `journals.idempotency_key` |

Internal keys are **derived from the transfer id, never random**, so a retry after a
crash regenerates the identical key.

`Resolve` is the mechanism that turns an unknown outcome into a decision: it inserts a
`VOIDED` tombstone on `(reference_id, operation)`. If the real operation committed
first, `Resolve` sees `APPLIED`. If the tombstone lands first, a late-arriving debit
hits it and fails with `REFERENCE_VOIDED`, so it can never apply after being voided.
The primary key arbitrates the race. Once `Resolve` answers, the answer never changes.

## Non-negotiable rules

1. **Persist intent before every external call.** That is what `*_SENT` exists for.
2. **A timeout is an unknown outcome, never a failure.** Only a definite failure, or
   `Resolve` returning `VOIDED`, moves a transfer to a failure state.
3. **Every state change is a compare-and-set on `version`** plus a `transfer_events`
   row, in one transaction. Zero rows updated means `StaleTransferError`: stop driving,
   do not retry the write.
4. **Money is `bigint` paise.** Never a float. (`int8` arrives from `pg` as a string —
   convert with `BigInt()`.)
5. **The ledger is append-only and every journal balances.** Enforced by database
   triggers, not only by application code.
6. Never hold a database transaction open across a gRPC call.
7. Nothing that must survive a restart lives in memory. Integration tests run against
   real Postgres and Redis, never mocks.

## Invariants — the proof the project works

Computed against a baseline snapshot taken before each run.

| | |
|---|---|
| **I1** | Every journal balances; the ledger as a whole is zero-sum |
| **I2** | Money is conserved — bank balances sum to the baseline sum; none negative |
| **I3** | Nothing left in transit — `transit` returns to baseline once all transfers are terminal |
| **I4** | Ledger agrees with each bank — balance change plus receivable/payable change is zero |
| **I5** | Exactly-once effects per transfer, verified per final state |
| **I6** | Everything finished — no non-terminal transfer, **zero** in `NEEDS_MANUAL_REVIEW` |
| **I7** | Replays are idempotent — same transfer id, same final state |

## Active deviations from ARCHITECTURE.md

| Deviation | ADR |
|---|---|
| **Node 22 LTS**, not Node 20 (20 reached EOL April 2026) | `ADR-009` |
| **Fastify 5** + `@fastify/jwt` v9, not Fastify 4 | `ADR-009` |
| `buf lint` STANDARD **except** 4 rules the verbatim protos/layout violate | `ADR-011` |
| ts-proto plugin run as `['node', 'node_modules/ts-proto/protoc-gen-ts_proto']` (Windows) | `ADR-012` |
| `test*` scripts use vitest **projects** (`unit`/`integration`/`chaos`), not `--dir` | `ADR-013` |
| `schema_migrations` has an extra `checksum` column; pending files apply in **one** transaction | `ADR-014` |
| Ledger migration `0003_forbid_truncate.sql` (statement-level `BEFORE TRUNCATE` triggers) | `ADR-015` |
| Mock Bank: 4 extra error codes, replay `balance_after` = current balance, Credit can be `CURRENCY_MISMATCH`, runtime `slow_ms` check | `ADR-016` |
| Inline saga budget is a **hard bound**: each call's deadline is `min(per-call timeout, budget left)`, no attempt with < 100 ms left, retry sleeps capped at the deadline | `ADR-010` |
| Ledger maps its own trigger/CHECK rejections (`P0001`, `23514`) to `FAILED_PRECONDITION` / `LEDGER_INVARIANT_VIOLATION` (was `INTERNAL`) | `ADR-017` |
| **`@fastify/jwt` 10.2.2**, not v9 (v9's `fast-jwt` has critical advisories); Gateway details | `ADR-019` |
| Load test spread over the four dev API clients (per-client rate limit); demo seed `ACC001`–`ACC005`; k6 v2.2.0 via winget | `ADR-022` |
| Chaos tests: invariants scoped to a baseline / key prefix; `npm run invariants` scoped per transfer (`--since`); a request that gave up during a restart is resent later | `ADR-021` |
| Recovery: `Resolve` lives in `SagaEngine.settle`, the lease is renewed before each drive, events record `driver` + `lease_owner` | `ADR-020` |
| Orchestrator: CAS also matches `state`; unrecognised bank errors are `BANK_INVARIANT_VIOLATION`; `INVALID_REQUEST`/`TRANSFER_NOT_FOUND` codes; extra startup checks | `ADR-018` |
| CI `nightly` runs the 10,000-transfer test **twice** (seeds 1, 2) plus an unscoped `npm run invariants`; jobs gated by event; diagrams rendered by `npx` mermaid-cli, not a dependency | `ADR-023` |

PostgreSQL stays at 16. Everything else is verbatim per spec.

**Shape notes for later milestones** (not deviations, just how `@switch/common` landed):
`instrument` comes from `createInstrument({ logger, registry })`; `withRetry` requires a
`shouldRetry` predicate (no default, so a definite failure can never be retried by
accident); `withRetry`'s `attempts` is the **total** count, so `INLINE_BANK_RETRIES=2`
means `attempts: 3`; generated code is imported as `@switch/proto-gen/bank/v1` (etc.). The dev machine runs Node
v24, which is forward-compatible with the ES2022/CommonJS target; Docker and CI pin
`node:22-alpine`, and `.nvmrc` records 22.

## Known open questions

Two, both the owner's to decide (not design questions):

- **Development stack reset** (`npm run stack:down && npm run stack:up`) to clear the M3
  mutation artifacts (ADR-021). Until then, use `npm run invariants -- --since <ISO>` on
  this stack. A clean-room project in M9 showed the unscoped check passing on fresh
  databases.
- **A GitHub remote**, so CI can run and the last open "tests pass in CI" box can be
  checked.

Both design questions from M0–M2 were resolved in M3 (`ADR-010`, `ADR-017`). Two facts
from that resolution shape every later milestone:

- **`202` is a normal outcome.** Integration tests pass the `CreateTransfer` response to
  `awaitTerminal` (`tests/helpers/transfers.ts`), which polls `GetTransfer`.
- **Recovery is live (M6).** A 202 transfer is finished by the recovery worker within
  seconds to minutes (backoff 2, 4, 8 s, then `Resolve`). Tests poll for a terminal state;
  none may assume a non-terminal transfer *stays* non-terminal.

**Shape notes from M3:** `SagaEngine.advance(transfer, {mode, deadline?, leaseOwner,
requestId?})` already handles inline retries and `yield` (section 6 pseudocode), so M5
mostly *verifies* them. M6 calls `advance` with `mode: 'recovery'` and uses
`claimDue`/`acquireLease` from `repo/transfersRepo.ts`. `tests/tsconfig.json` references
`services/orchestrator`, so integration tests may import its `src/` for repo-level SQL
tests.

**Shape notes from M4:** HTTP tests go through `tests/helpers/gatewayClient.ts`
(`GatewayClient.for(DEV_CLIENTS.a)`; the dev credentials live in `docker-compose.yml`).
`tests/helpers/bankAdmin.ts` creates accounts and sets chaos. `tests/helpers/stack.ts` can
stop and start Compose services. The Gateway is built by `buildApp(deps)` with injected
ports, so unit tests use `app.inject()` with no sockets.

## Doc map

| Question | File |
|---|---|
| What is this, what are the rules, where am I? | **this file** |
| What is done, what is next, what are the acceptance criteria? | `docs/PROGRESS.md` |
| Why was something decided? What went wrong before? | `docs/SESSION_LOG.md` |
| Why this design and not the obvious alternative? | `docs/decisions/ADR-*.md` |
| Full detail on anything | `ARCHITECTURE.md` — read *sections*, not the whole file |

`ARCHITECTURE.md` section guide: **2** tech stack, **3** repo layout, **4** system
architecture, **5** Gateway, **6** Orchestrator, **7** Ledger, **8** Mock Bank,
**9** protobuf contracts, **10** database schemas, **11** transfer lifecycle,
**12** idempotency, **13** concurrency / failures / recovery, **14** errors / deadlines /
retries, **15** config and deployment, **16** testing, **17** observability / CI / docs,
**19** milestones, **20** definition of done, **21** forbidden shortcuts.
