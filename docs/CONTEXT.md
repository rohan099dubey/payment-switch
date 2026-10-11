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
| **Active milestone** | **None: phase 2 is complete.** Phase 1 and P2-1 to P2-6 are `DONE` (P2-6 optional, built too). A Compose change must also land in `deploy/k8s` (`tests/unit/k8sManifests.test.ts` checks parity) |
| **Definition of done** | **8 of 8 — phase 1 complete** (2026-10-07; the last box confirmed by the owner) |
| **CI** | Private remote `origin` = `github.com/rohan099dubey/payment-switch`. Four jobs (`static`, `integration`, `k8s`, `nightly`), all green on P2-5's `8b7eceb`. The first `nightly` found a real bug, fixed in ADR-024 |
| **Next action** | No milestone left. Open follow-ups (SESSION_LOG, 2026-10-08): the owner's call on transfer `4bad8053` stuck on the dev stack by test interference; two filed tasks (recovery backoff on unexpected transition errors: **done**, ADR-031 (the shared stack's Orchestrator runs the old image until rebuilt; mind ADR-031's note on the order for `4bad8053`); the outbox uniqueness test must not be able to commit); the P2-6 session's k8s crash-test timing fix (`claude/p2-6-k8s-crash-timing`) |
| **Read first for phase 2** | `ARCHITECTURE.md` section 19 (each item is independent), plus `ADR-025` for how events look on the wire |

`docs/PROGRESS.md` is authoritative for status — if it disagrees with this table,
believe `PROGRESS.md` and correct this one.

**Branch and merge policy** (the owner delegated merge decisions to Claude on 2026-10-05):
work on the session's branch. Merge into `main` only when the milestone is `DONE`: every
box ticked, and `lint`, `typecheck`, `test` and the acceptance commands green. Merge
fast-forward only (`git merge --ff-only`). If that is impossible, rebase onto `main`,
re-run the checks, then merge. Never merge a half-finished milestone. Since 2026-10-07
`main` is pushed to the private `origin` (the owner set it up and approved pushing as part
of closing phase 1). Git authenticates as `rohan099dubey` through a **repo-local**
credential helper (`gh auth git-credential`); `gh` 2.102.0 is installed per-user by
winget. Push only `main`, only after it passes the full check chain.

## Services

Four deployable services. Never merged, never sharing a database. Only the Gateway
speaks HTTP to the outside; everything internal is gRPC.

| Service | Ports | Owns | Calls |
|---|---|---|---|
| Gateway | HTTP 8080 | nothing durable (Redis = rate-limit buckets only) | Orchestrator |
| Orchestrator | gRPC 50051, HTTP 9101 | `orchestrator_db`: `transfers`, `transfer_events`, `outbox` | both banks, Ledger; publishes to Kafka (outbox relay) |
| Ledger | gRPC 50052, HTTP 9102 | `ledger_db`: `accounts`, `journals`, `entries`, `balance_snapshots` + `balance_snapshot_lines` (P2-5, append-only) | nothing (leaf) |
| Notification | HTTP 9103 | `notification_db` on `postgres-notification`: `processed_events`, `webhook_attempts` | nothing (consumes `transfer-events`, produces `transfer-events.dlq`) |
| Reconciliation | gRPC 50053, HTTP 9104 | `reconciliation_db` on `postgres-reconciliation`: `reconciliation_runs`, `reconciliation_breaks` | both banks (`GetStatement`, `GetOperation`), Ledger (`ListJournalsByTime`, `ListJournals`) |
| Mock Bank A | gRPC 50061, HTTP 9111 | db `bank_a` | nothing |
| Mock Bank B | gRPC 50062, HTTP 9112 | db `bank_b` | nothing |

Observability (ADR-028): Jaeger 16686 (traces), Prometheus 9090 (scrapes all 7 services),
Grafana 3000 (dashboard `payment-switch`, committed JSON in `observability/`). Every service
imports `@switch/common/tracing` **first** in `main.ts`.

Kafka (`apache/kafka:3.9.1`, KRaft, single node; `kafka:9092` inside Compose, `localhost:9094`
from the host) carries topic `transfer-events` (phase 2, ADR-025). It is **not** on the
payment path: nothing depends on it, and events wait in the outbox while it is down.

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
| `DEFINITE_FAILURE` | bank said no (`FAILED_PRECONDITION`, `NOT_FOUND`) | **fence first** with `Resolve` (ADR-024): `VOIDED` → failure branch, `APPLIED` → the step succeeded after all, no answer → stay |
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
2. **A timeout is an unknown outcome, never a failure.** A transfer reaches a failure
   state only once its reference holds a `VOIDED` tombstone at the bank, from `Resolve`
   or proven by a `REFERENCE_VOIDED` answer. A definite refusal is fenced with `Resolve`
   first, because an earlier attempt for the same reference may still apply (ADR-024).
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
| **I8** | Outbox (phase 2): every terminal transfer since `0002_outbox.sql` has exactly one event of the matching type; none unpublished once quiet (ADR-025) |
| **I9** | Notifications (phase 2): every published event has exactly one outcome in `processed_events`, `DELIVERED` unless the payee is a `whfail-` account (ADR-026) |
| **I10** | Reconciliation (phase 2): after a run covering them, no OPEN break names one of the transfers (ADR-027) |
| **I11** | Balance snapshots (phase 2): every snapshot equals the raw sums of the entries it covers; `GetTrialBalance` equals the raw sums (ADR-029) |

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
| **A definite bank failure is fenced with `Resolve` before the failure branch** (the spec fails at once; a late earlier attempt could then still apply, which the first nightly CI run caught) | `ADR-024` |
| Outbox: an event for **every** terminal state (incl. `NEEDS_MANUAL_REVIEW`), `UNIQUE (aggregate_id)`, amount as a string, **Kafka 3.9.1** (kafkajs predates 4.x), no `depends_on` Kafka, relay metrics, invariant I8 | `ADR-025` |
| Notification: a dedicated `postgres-notification`, a deterministic simulated webhook (`whfail-` / `whflaky-` payees, a seeded rate), blocking retries 200·2^n ms, a dead letter for malformed messages, invariant I9 | `ADR-026` |
| Reconciliation: **added** `LedgerService.ListJournalsByTime` and `ReconciliationService.RunReconciliation`; paged `GetStatement` (page_size, page_token); a 120 s settle lag; breaks OPEN to RESOLVED; dedicated `postgres-reconciliation`; invariant I10 | `ADR-027` |
| Tracing: the OTel bootstrap is the first import in every `main.ts`; `pg` spans only inside requests; always-on sampling (its cost is a separate benchmark row: +26 % CPU per transfer); new top-level `observability/`; Jaeger's store capped at 10,000 traces (amendment 1) | `ADR-028` |
| Balance snapshots: immutable checkpoints (`balance_snapshots`, append-only), not a running balance; the cut takes a brief `SHARE` lock on `entries` (bounded by `SNAPSHOT_LOCK_TIMEOUT_MS`); a new covering index on `entries`; invariant I11; no proto change | `ADR-029` |
| Kubernetes (P2-6, optional): kind only, plain manifests + kustomize, one image with `SERVICE` at run time, **added** network policies (database per service enforced), two Orchestrators, a `k8s` test project and CI job. `tests/unit/k8sManifests.test.ts` fails if Compose and the manifests drift | `ADR-030` |
| Recovery: an unexpected error (not a classified answer, not `StaleTransferError`) during a recovery drive **yields** with the section 6 backoff instead of releasing the lease for the next poll; if the yield fails too, the lease is kept and expires | `ADR-031` |

PostgreSQL stays at 16. Everything else is verbatim per spec.

**Shape notes for later milestones** (not deviations, just how `@switch/common` landed):
`instrument` comes from `createInstrument({ logger, registry })`; `withRetry` requires a
`shouldRetry` predicate (no default, so a definite failure can never be retried by
accident); `withRetry`'s `attempts` is the **total** count, so `INLINE_BANK_RETRIES=2`
means `attempts: 3`; generated code is imported as `@switch/proto-gen/bank/v1` (etc.). The dev machine runs Node
v24, which is forward-compatible with the ES2022/CommonJS target; Docker and CI pin
`node:22-alpine`, and `.nvmrc` records 22.

## Known open questions

None about the design. One housekeeping item, the owner's:

- **The dev stack holds two inconsistent transfers** (`c9346799`, `5c784905`), left by
  the ADR-024 red tests, which were run against the shared stack while the bug was live.
  The unscoped `npm run invariants` reports I4/I5 for those two only. Clear them with
  another reset (`npm run stack:down && npm run stack:up && npm run seed`), which Claude
  cannot run (the auto-mode classifier blocks volume deletion). Until then, use
  `--since`. The M3 artifacts are gone (reset 2026-10-07, backup in
  `D:\WORK\DEV\PROJECTS\PaymentSwitch_DEL_backups\2026-10-07-pre-reset\`).
- **Rule for red tests:** run a test against code with a known money bug only in a
  throwaway Compose project (`COMPOSE_PROJECT_NAME=...`, ADR-023), never against the
  shared stack.

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
