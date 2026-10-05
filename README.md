# Payment Switch + Double-Entry Ledger

> **Status: in development.** Section order and content are fixed by
> `ARCHITECTURE.md` section 17. Each section below names the milestone that fills it.
> Nothing here is written speculatively — in particular, no benchmark number appears
> until it has been measured.

## 1. What it is

*(Fill at M9, three lines.)*

A mini UPI-style payment switch. It moves money between accounts at two independent
banks, records every movement in a double-entry ledger, and stays exactly-once even
when banks time out, responses are lost, or the switch crashes mid-transfer.

## 2. Architecture

*(Fill at M9 — render `docs/diagrams/architecture.mmd` to PNG and embed it.)*

Four services, no shared databases, gRPC between them, HTTP only at the edge:

| Service | Ports | Owns |
|---|---|---|
| Gateway | HTTP 8080 | nothing durable |
| Orchestrator | gRPC 50051, HTTP 9101 | `orchestrator_db` |
| Ledger | gRPC 50052, HTTP 9102 | `ledger_db` |
| Mock Bank A / B | gRPC 50061 / 50062 | `bank_a` / `bank_b` |

See [`ARCHITECTURE.md`](ARCHITECTURE.md) for the full specification and
[`docs/CONTEXT.md`](docs/CONTEXT.md) for a short orientation.

## 3. Quick start

*(Fill at M4, when there is something to curl.)*

```bash
npm run stack:up     # docker compose up -d --build --wait
npm run seed         # 10 accounts per bank, A001-A010, 10,000,000 paise each
```

Then: get a token, create a transfer, replay the same `Idempotency-Key`. Curl examples
go here.

## 4. How correctness is proven

*(Fill at M7.)*

Invariants checked after every chaos and load run — `npm run invariants`:

| | |
|---|---|
| **I1** | Every journal balances; the ledger is zero-sum |
| **I2** | Money is conserved; no balance is negative |
| **I3** | Nothing is left in transit |
| **I4** | The ledger agrees with each bank |
| **I5** | Every transfer had exactly-once effects |
| **I6** | Everything finished; zero transfers need manual review |
| **I7** | Replays are idempotent |

The headline test sends 10,000 transfers with injected failures, kills the Orchestrator
three times mid-run, and must pass every invariant twice in a row with different seeds.

## 5. Failure scenarios handled

*(Fill at M9 — short version of the 14-row table in `ARCHITECTURE.md` section 13.)*

The design distinction that matters: a **timeout is not a failure**. It is an unknown
outcome, settled by the bank's `Resolve` call, which writes a tombstone so a late
request can never apply after the transfer was given up on. See
[`ADR-002`](docs/decisions/ADR-002-resolve-tombstones.md).

## 6. Benchmarks

*(Fill at M8, copied from [`docs/benchmarks.md`](docs/benchmarks.md).)*

No numbers yet. Every figure quoted here must trace to a recorded run in that file,
with the machine and commit that produced it, and with the invariants green afterwards.

## 7. Design decisions and tradeoffs

| ADR | Decision |
|---|---|
| [001](docs/decisions/ADR-001-orchestrated-saga.md) | Orchestrated saga instead of two-phase commit |
| [002](docs/decisions/ADR-002-resolve-tombstones.md) | `Resolve` with tombstones to settle unknown outcomes |
| [003](docs/decisions/ADR-003-derived-ledger-balances.md) | Derived ledger balances, no hot balance row |
| [004](docs/decisions/ADR-004-isolation-levels.md) | `READ COMMITTED` for writes, `REPEATABLE READ` for aggregates |
| [005](docs/decisions/ADR-005-idempotency-three-layers.md) | Idempotency on the transfer row, in three layers |
| [006](docs/decisions/ADR-006-rate-limiter-fails-open.md) | The rate limiter fails open |
| [007](docs/decisions/ADR-007-database-per-service.md) | Database per service; shared Postgres only for the mock banks |
| [008](docs/decisions/ADR-008-recovery-by-lease-and-skip-locked.md) | Recovery by lease and `SKIP LOCKED`, not a message queue |
| [009](docs/decisions/ADR-009-node-22-fastify-5.md) | Node 22 LTS and Fastify 5 (deviation from the spec) |
| [010](docs/decisions/ADR-010-inline-saga-budget.md) | Inline saga budget vs. the `202` path — **open** |
| [011](docs/decisions/ADR-011-buf-lint-exceptions.md) | Four `buf lint` exceptions for the verbatim contracts (deviation) |
| [012](docs/decisions/ADR-012-ts-proto-plugin-invocation.md) | Run the ts-proto plugin through `node` (deviation) |
| [013](docs/decisions/ADR-013-vitest-projects.md) | Test layers as vitest projects (deviation) |
| [014](docs/decisions/ADR-014-migration-checksums.md) | Migration checksums, one transaction per batch (deviation) |
| [015](docs/decisions/ADR-015-ledger-forbid-truncate.md) | The ledger also forbids `TRUNCATE` (deviation) |
| [016](docs/decisions/ADR-016-mock-bank-unspecified-details.md) | Mock Bank details the spec leaves open |

## 8. What I built and why

*(Five lines appended after each milestone. Must be explainable out loud without
looking — that is what makes the project safe to put on a resume.)*

**M0 — Scaffold**
1. One npm-workspaces monorepo: shared code in `packages/`, each service in `services/`. Services share libraries but never a database or a process.
2. Service contracts are `.proto` files, and TypeScript types are generated from them. A field mismatch between two services is a compile error, not a production bug.
3. `classify()` sorts every downstream error into definite failure, unknown outcome or bug. Anything unrecognised counts as *unknown*, because a timeout must never be treated as a failure.
4. Retries are explicit and opt-in: gRPC's built-in retries are off, and `withRetry` needs a predicate, so a definite failure can't be retried by accident.
5. Migrations run under a Postgres advisory lock, all pending files in one transaction, with checksums so an edited migration stops startup.

**M1 — Ledger**
1. A double-entry ledger in which balances are derived by summing entries, never stored. So `transit`, touched by every transfer, never becomes a hot row that serialises all traffic.
2. "Every journal balances" is enforced twice: by validation in the app and by a deferred constraint trigger at COMMIT. A mutation test proved the trigger catches what the app misses.
3. The ledger is append-only in the database itself. Triggers reject UPDATE, DELETE and (beyond the spec, ADR-015) TRUNCATE, so history can't be rewritten even with raw SQL.
4. Idempotency comes from a unique key plus `ON CONFLICT DO NOTHING`, with no application locks. 100 concurrent identical posts produce one journal and 99 replays.
5. A reused key with a different body is rejected using a hash of the canonical request, so a retry can never silently post different amounts.

**M2 — Mock Bank**
1. A simulated external bank, run as two instances with separate databases. Every money operation is idempotent by `(reference_id, operation)`, the table's primary key.
2. Double-spend is impossible: the balance check and the decrement are one conditional `UPDATE`. 50 concurrent debits against funds for 10 yield exactly 10.
3. `Resolve` turns "did it happen?" into a permanent answer by inserting a tombstone. A late debit that arrives after it fails with `REFERENCE_VOIDED`, so money can never move after the switch gave up on it.
4. That race is tested for real: Debit and Resolve fire together on separate connections, each side wins sometimes, and every pair gets one consistent answer.
5. A seeded chaos engine (mulberry32) injects outages, rejections, late applies and lost responses. The same seed gives the same failures, so chaos bugs can be reproduced.

---

## Using the API: idempotency rules for clients

- Create one fresh key (UUID v4) per payment intent and reuse it for **every retry of
  that intent**.
- Retry on network errors, 429 (after `Retry-After`), 503 and 504. That is safe by
  design.
- Never reuse a key for a different payment. A `409` means exactly that.
- A `202` means the transfer is still in progress. Poll `GET /v1/transfers/{id}` until
  `status` is terminal.
- A replay returns the transfer's **current** state, not a copy of the first response —
  so a request that returned `202 PENDING` can return `SUCCEEDED` on retry.
