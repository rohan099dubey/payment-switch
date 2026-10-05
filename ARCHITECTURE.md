# Payment Switch + Double-Entry Ledger — Architecture & Build Spec

Oct 4, 2026 · @Rohan

> **Amendments.** This document is the source of truth and is never edited in place.
> Where the implementation deviates, the deviation is recorded in [`docs/decisions/`](docs/decisions/)
> and listed under "Active deviations" in [`docs/CONTEXT.md`](docs/CONTEXT.md).
> Currently active: **ADR-009** (Node 22 LTS and Fastify 5, not Node 20 and Fastify 4).

## How to use this document

This document is the single source of truth for building the Payment Switch with Claude Code. Implement exactly what is written: the same services, ports, schemas, state machine, error codes and file layout. Where it is silent, pick the stricter option and record the choice as an ADR in `docs/decisions/`.

**What is being built.** A mini UPI-style payment switch. A client asks the switch to move money from an account at one mock bank to an account at another. The switch debits the payer's bank, credits the payee's bank, and records every movement in a double-entry ledger. The result is exactly-once even when banks time out, responses are lost, or the switch itself crashes mid-transfer.

### Ground rules

1. Four deployable services: Gateway, Orchestrator, Ledger, Mock Bank (run as two instances, `bank_a` and `bank_b`). Never merge services. Never share a database between services.
2. All service-to-service calls are gRPC using the contracts in section 9. Only the Gateway speaks HTTP to the outside.
3. PostgreSQL per service, raw SQL through `pg`. No ORM.
4. Money is an integer number of paise (`bigint` in SQL, `int64` in protobuf, `bigint` or decimal string in TypeScript). Never floats.
5. Every call to a bank or the ledger is idempotent and carries a deadline.
6. Only a definite failure moves a transfer to a failure state. A timeout or `UNAVAILABLE` is an unknown outcome and is settled through the bank's `Resolve` call.
7. Persist intent before every external call. The `*_SENT` states exist for this.
8. Every state change is a compare-and-set on `version` and writes a `transfer_events` row in the same transaction.
9. The ledger is append-only and every journal balances. Both are enforced by the database, not only by application code.
10. Nothing that must survive a restart lives in memory. Integration tests run against real Postgres and Redis, never mocks.
11. TypeScript `strict` mode, no `any`, no skipped or commented-out tests.
12. Do not add services, libraries, endpoints or abstractions that this document does not list. Phase 2 (section 19) starts only after the definition of done in section 20 is met for phase 1.

### Files to commit at the repo root

Save this document as `ARCHITECTURE.md`, and add this `CLAUDE.md` so every Claude Code session loads the rules:

```markdown
# CLAUDE.md
- Read ARCHITECTURE.md before every task. It is the source of truth. Do not deviate or simplify.
- Implement only the milestone named in the prompt. Do not start later milestones.
- TypeScript strict, CommonJS, Node 20, npm workspaces. Raw SQL with pg. gRPC with @grpc/grpc-js and the generated code in packages/proto-gen.
- Money is bigint paise. Never floats.
- Every transfer state change is a compare-and-set on version plus a transfer_events row, in one transaction.
- Before saying a milestone is done, run: npm run lint && npm run typecheck && npm test, plus the acceptance commands listed for that milestone.
- If ARCHITECTURE.md is ambiguous, choose the stricter option and write a short ADR in docs/decisions/.
```

## Tech stack

Use exactly these choices. Install with `npm install --save-exact` and commit `package-lock.json`.

| Concern | Choice | Notes |
| --- | --- | --- |
| Runtime | Node.js 20 LTS, TypeScript 5 `strict` | CommonJS output (`module: commonjs`, `target: ES2022`) to avoid ESM friction with generated gRPC code |
| Monorepo | npm workspaces: `packages/*`, `services/*` | TypeScript project references, build with `tsc -b` |
| gRPC runtime | `@grpc/grpc-js` | Do not use `@grpc/proto-loader`; use generated typed code |
| Codegen | `@bufbuild/buf` + `ts-proto` | `buf generate` writes to `packages/proto-gen/src` (gitignored, generated on build) |
| HTTP (Gateway only) | `fastify` 4, `zod`, `@fastify/jwt` | No Express |
| Database | PostgreSQL 16, `pg` Pool | Raw SQL, no ORM. `int8` columns arrive as strings; convert with `BigInt()` |
| Rate limiting | Redis 7, `ioredis` | Gateway only. Redis never stores money or transfer state |
| Logging | `pino` (JSON to stdout) | One logger factory in `@switch/common` |
| Metrics | `prom-client` | Each service exposes `/metrics` on its HTTP port |
| Tests | `vitest`, `k6` | Integration and chaos tests run against the Docker Compose stack |
| Lint and format | `eslint` + `typescript-eslint`, `prettier`, `buf lint` |  |
| Packaging | Docker multi-stage build, Docker Compose v2 | One Dockerfile, `SERVICE` build argument |
| CI | GitHub Actions |  |

### Codegen configuration

`buf.gen.yaml` at the repo root:

```yaml
version: v2
plugins:
  - local: node_modules/.bin/protoc-gen-ts_proto
    out: packages/proto-gen/src
    opt:
      - outputServices=grpc-js
      - esModuleInterop=true
      - forceLong=string
      - useDate=true
      - env=node
      - useOptionals=messages
      - exportCommonSymbols=false
```

`buf.yaml` at the repo root sets `version: v2`, `modules: [{path: proto}]`, lint `STANDARD`, breaking `FILE`.

Generated names to expect: service `BankService` produces `BankServiceService` (the server definition), `BankServiceServer` (handler interface) and `BankServiceClient`. Every `int64` is a TypeScript `string` because of `forceLong=string`.

### Shared package `@switch/common`

All cross-cutting code lives in `packages/common/src`. Services import from it and never copy it.

| File | Provides |
| --- | --- |
| `config.ts` | `loadConfig(zodSchema)` reads `process.env`, fails fast with a readable error |
| `logger.ts` | `createLogger(serviceName)` with `request_id` and `transfer_id` child bindings |
| `httpServer.ts` | Tiny HTTP server for `/healthz`, `/readyz`, `/metrics` on gRPC services |
| `db.ts` | `createPool(url)`, `withTransaction(pool, fn, isolation?)` helper |
| `migrate.ts` | `runMigrations(pool, dir)` using an advisory lock and a `schema_migrations` table |
| `grpc/client.ts` | `makeClient(ServiceCtor, address)` with keepalive; built-in retries disabled (`grpc.enable_retries: 0`) |
| `grpc/call.ts` | `callUnary(fn, request, {timeoutMs, requestId})` sets the deadline and metadata |
| `grpc/retry.ts` | `withRetry(fn, {attempts, baseMs, maxMs})` exponential backoff with full jitter |
| `grpc/errors.ts` | `classify(err)` returning `DEFINITE_FAILURE`, `UNKNOWN_OUTCOME` or `BUG`; `errorCodeOf(err)` reads the `x-error-code` trailer; `makeGrpcError(code, errorCode, message)` |
| `grpc/instrument.ts` | `instrument(name, handler)` wraps every server handler: request id, logging, latency metric, error mapping |
| `hash.ts` | `canonicalJson(obj)` (sorted keys) and `sha256Hex(string)` |
| `time.ts` | `sleep`, `backoffMs(attempt)` |

## Repository layout

Create exactly this structure. File names are camelCase `.ts`, SQL migrations are `NNNN_name.sql`, and workspace package names are `@switch/<name>`.

```text
payment-switch/
├── ARCHITECTURE.md              this document
├── CLAUDE.md                    rules for Claude Code (section 1)
├── README.md                    overview, how to run, design decisions
├── package.json                 workspaces + root scripts (section 15)
├── tsconfig.base.json           strict, CommonJS, ES2022
├── buf.yaml / buf.gen.yaml
├── docker-compose.yml
├── Dockerfile                   one file, ARG SERVICE
├── .env.example
├── .github/workflows/ci.yml
├── proto/
│   ├── bank/v1/bank.proto
│   ├── ledger/v1/ledger.proto
│   └── orchestrator/v1/orchestrator.proto
├── packages/
│   ├── proto-gen/               generated TypeScript (gitignored)
│   └── common/src/              config, logger, db, migrate, httpServer, hash, time, grpc/*
├── services/
│   ├── gateway/
│   │   ├── src/
│   │   │   ├── main.ts
│   │   │   ├── app.ts                   builds the Fastify instance
│   │   │   ├── config.ts
│   │   │   ├── plugins/{requestId,auth,rateLimit,errorHandler}.ts
│   │   │   ├── routes/{auth,transfers,health}.ts
│   │   │   ├── clients/orchestratorClient.ts
│   │   │   ├── lua/tokenBucket.lua
│   │   │   └── mappers.ts               gRPC <-> HTTP shapes and status codes
│   │   └── test/
│   ├── orchestrator/
│   │   ├── src/
│   │   │   ├── main.ts
│   │   │   ├── config.ts
│   │   │   ├── grpc/{server,handlers}.ts
│   │   │   ├── domain/{states,transitions,saga,failureCodes,policy}.ts
│   │   │   ├── repo/{transfersRepo,eventsRepo}.ts
│   │   │   ├── clients/{bankClients,ledgerClient}.ts
│   │   │   ├── recovery/worker.ts
│   │   │   └── metrics.ts
│   │   ├── migrations/0001_init.sql
│   │   └── test/
│   ├── ledger/
│   │   ├── src/
│   │   │   ├── main.ts
│   │   │   ├── config.ts
│   │   │   ├── grpc/{server,handlers}.ts
│   │   │   ├── domain/{validate,journalHash}.ts
│   │   │   ├── repo/{journalRepo,balanceRepo}.ts
│   │   │   └── metrics.ts
│   │   ├── migrations/{0001_init,0002_seed_accounts}.sql
│   │   └── test/
│   └── mockBank/
│       ├── src/
│       │   ├── main.ts
│       │   ├── config.ts
│       │   ├── grpc/{server,handlers}.ts
│       │   ├── chaos/{chaos,prng}.ts
│       │   ├── repo/{accountsRepo,operationsRepo}.ts
│       │   └── metrics.ts
│       ├── migrations/0001_init.sql
│       └── test/
├── tests/
│   ├── helpers/{stack,gatewayClient,bankAdmin,ledgerClient,invariants}.ts
│   ├── integration/{happyPath,validation,idempotency,failurePaths}.test.ts
│   └── chaos/{crashRecovery,invariant}.test.ts
├── load/transfer.k6.js
├── scripts/{seed.ts,checkInvariants.ts,initBankDbs.sql}
└── docs/
    ├── diagrams/*.mmd           architecture, state machine, sequence diagrams
    └── decisions/ADR-*.md
```

The Mock Bank directory is `services/mockBank` and its package name is `@switch/mock-bank`. Compose service names are `gateway`, `orchestrator`, `ledger`, `bank-a`, `bank-b`.

**Conventions**

- Each service has `main.ts` (wiring and startup only), `config.ts` (zod-validated env), `grpc/` (transport), `domain/` (pure logic, no I/O), `repo/` (SQL only).
- SQL lives only in `repo/` files and `migrations/`. Handlers never build SQL strings. Always use parameterized queries.
- `domain/` code is unit-testable without a database. The saga engine takes its dependencies (repo, clients, clock) as constructor arguments.

## System architecture

&#91;embedded content: architecture · 4 services, 4 data stores\]

The Gateway is the only public entry point. The Orchestrator is the only service that calls the banks and the Ledger, and every service owns its own data.

| Component | Protocol and port | Owns | Calls |
| --- | --- | --- | --- |
| Gateway | HTTP 8080 | No durable state (Redis holds rate-limit buckets) | Orchestrator |
| Orchestrator | gRPC 50051, HTTP 9101 | `orchestrator_db`: `transfers`, `transfer_events` | `bank-a`, `bank-b`, Ledger |
| Ledger | gRPC 50052, HTTP 9102 | `ledger_db`: `accounts`, `journals`, `entries` | nothing |
| Mock Bank A | gRPC 50061, HTTP 9111 | database `bank_a` | nothing |
| Mock Bank B | gRPC 50062, HTTP 9112 | database `bank_b` | nothing |

**Sync and async.** Everything in phase 1 is synchronous gRPC. A client request normally finishes the whole saga inline. If a bank or the Ledger misbehaves, the request returns `202` and the recovery worker finishes the transfer in the background. Kafka events arrive in phase 2.

## Service: Gateway

The Gateway is the only public entry point. It authenticates, rate-limits, validates input, translates REST to gRPC and back, and nothing else. It has no database and no business logic. Runtime: Fastify on HTTP port **8080**.

### Endpoints

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| POST | `/v1/auth/token` | none | Exchange `client_id` and `client_secret` for a JWT |
| POST | `/v1/transfers` | Bearer | Create a transfer (idempotent) |
| GET | `/v1/transfers/{id}` | Bearer | Read a transfer; only the client that created it can read it |
| GET | `/healthz` | none | Liveness, always 200 while the process is up |
| GET | `/readyz` | none | 200 only if Redis answers PING and the Orchestrator channel is connected |
| GET | `/metrics` | none | Prometheus metrics |

### Authentication

- Clients come from the `API_CLIENTS` env var, a JSON array such as `[{"client_id":"demo-client","client_secret":"demo-secret"}]`.
- `POST /v1/auth/token` with `{ "client_id", "client_secret" }` compares the secret with `crypto.timingSafeEqual` and returns `{ "access_token", "token_type": "Bearer", "expires_in": 900 }`.
- Tokens are HS256 JWTs signed with `JWT_SECRET`, claims `sub` (the client id), `iat`, `exp`.
- Every `/v1/transfers` route requires a valid bearer token. The `client_id` sent to the Orchestrator always comes from the token `sub`, never from the request body.

### POST /v1/transfers

Headers: `Authorization: Bearer <jwt>`, `Idempotency-Key` (required), `Content-Type: application/json`, optional `X-Request-Id` (a UUID is generated if absent and echoed on every response).

`Idempotency-Key` must match `^[A-Za-z0-9_.:-]{8,128}$`. Missing or malformed returns 400 `IDEMPOTENCY_KEY_REQUIRED`.

Request body, validated with zod (unknown fields rejected):

```json
{
  "payer": { "bank_id": "bank_a", "account_id": "ACC001" },
  "payee": { "bank_id": "bank_b", "account_id": "ACC002" },
  "amount": 12500,
  "currency": "INR",
  "note": "rent"
}
```

| Field | Rule |
| --- | --- |
| `bank_id` | string, `^[a-z0-9_]{1,32}$`. Whether the bank exists is checked by the Orchestrator |
| `account_id` | string, `^[A-Za-z0-9_-]{1,64}$` |
| `amount` | integer in paise, `1` to `MAX_TRANSFER_AMOUNT` (default 10000000, which is 1 lakh rupees) |
| `currency` | literal `"INR"` |
| `note` | optional string, at most 140 characters |

Response body is the Transfer resource:

```json
{
  "id": "0b6f6f0e-4a0b-4c3b-9b59-2f1f6d1a8c11",
  "status": "SUCCEEDED",
  "state": "SUCCESS",
  "payer": { "bank_id": "bank_a", "account_id": "ACC001" },
  "payee": { "bank_id": "bank_b", "account_id": "ACC002" },
  "amount": 12500,
  "currency": "INR",
  "note": "rent",
  "failure_code": null,
  "failure_message": null,
  "created_at": "2026-10-04T10:15:00.000Z",
  "updated_at": "2026-10-04T10:15:00.412Z"
}
```

`status` is the public summary of `state`: `SUCCESS` becomes `SUCCEEDED`, `FAILED` stays `FAILED`, `REVERSED` stays `REVERSED`, `NEEDS_MANUAL_REVIEW` becomes `UNDER_REVIEW`, every other state becomes `PENDING`.

| Transfer state | First response | Replay of the same key |
| --- | --- | --- |
| `SUCCESS` | 201 | 200 with header `Idempotent-Replay: true` |
| `FAILED`, `REVERSED` | 422 | 422 with `Idempotent-Replay: true` |
| Any non-terminal state, `NEEDS_MANUAL_REVIEW` | 202 with `Location: /v1/transfers/{id}` | 202 with `Idempotent-Replay: true` |

### Error format and mapping

Every error body is `{ "error": { "code": "...", "message": "...", "request_id": "..." } }`. Validation errors add `details` (the zod issues).

| Condition | HTTP | `code` |
| --- | --- | --- |
| Missing or invalid bearer token, bad client credentials | 401 | `UNAUTHENTICATED` |
| Missing or malformed `Idempotency-Key` | 400 | `IDEMPOTENCY_KEY_REQUIRED` |
| Invalid body | 400 | `VALIDATION_ERROR` |
| gRPC `INVALID_ARGUMENT` from the Orchestrator | 400 | the `x-error-code` trailer value, default `VALIDATION_ERROR` |
| gRPC `ALREADY_EXISTS` with trailer `IDEMPOTENCY_KEY_REUSED` | 409 | `IDEMPOTENCY_KEY_REUSED` |
| gRPC `NOT_FOUND` on `GetTransfer` | 404 | `TRANSFER_NOT_FOUND` |
| Rate limit exceeded | 429 | `RATE_LIMITED` (header `Retry-After`) |
| gRPC `UNAVAILABLE` | 503 | `UPSTREAM_UNAVAILABLE` |
| gRPC `DEADLINE_EXCEEDED` | 504 | `UPSTREAM_TIMEOUT` |
| Anything else | 500 | `INTERNAL` |

On 503 and 504 the client must retry with the same `Idempotency-Key`. That is safe by design.

### Rate limiting

- Token bucket in Redis, implemented as a Lua script (`src/lua/tokenBucket.lua`) run with `EVALSHA`, so check-and-decrement is atomic. The script reads the clock with Redis `TIME`.
- Key `rl:{client_id}`. Env `RATE_LIMIT_RPS` (default 100) and `RATE_LIMIT_BURST` (default 200).
- Applied after authentication to both `/v1/transfers` routes. Responses carry `X-RateLimit-Remaining`; a rejection returns 429 with `Retry-After` in seconds.
- If Redis is unreachable the limiter fails open, logs a warning and increments `rate_limit_fail_open_total`. Availability of payments beats strictness of limits here, and the ADR must say so.

### Calling the Orchestrator

- `CreateTransfer` deadline: `ORCHESTRATOR_TIMEOUT_MS` (default 10000). `GetTransfer` deadline: 3000 ms.
- Forward the request id as gRPC metadata `x-request-id`.
- The Gateway never retries `CreateTransfer` itself. The client retries with the same `Idempotency-Key`.

### The Gateway must never

- Contain transfer logic, talk to a bank or the Ledger, or touch a database.
- Accept `client_id` from the body or a header.
- Log tokens, secrets or full request bodies.

## Service: Orchestrator

The Orchestrator owns the lifecycle of every transfer. gRPC port **50051**, HTTP (health and metrics) port **9101**, database `orchestrator_db` on `postgres-orchestrator`. It calls both banks and the Ledger over gRPC.

**Responsibilities:** validate and register transfers idempotently; drive the saga described in section 11; run the recovery worker that finishes anything left half-done; keep an audit trail in `transfer_events`.

### Modules

| File | Role |
| --- | --- |
| `domain/states.ts` | `TransferState` enum, terminal set, map of allowed transitions |
| `domain/transitions.ts` | `transition(transfer, to, {reason, detail, patch})`: one DB transaction doing a compare-and-set on `(id, version, state)` plus an insert into `transfer_events`. Throws `StaleTransferError` when zero rows match |
| `domain/saga.ts` | `SagaEngine.advance(transfer, ctx)`, the only code that moves money |
| `domain/policy.ts` | Timeouts, retry counts and backoff, read from config |
| `domain/failureCodes.ts` | Failure code constants and the mapping from bank error codes |
| `repo/transfersRepo.ts` | Insert with idempotency, get by id, CAS update, lease acquire and release, `claimDue` |
| `repo/eventsRepo.ts` | Append to `transfer_events` |
| `clients/bankClients.ts` | Map `bank_id` to a `BankServiceClient` built from `BANK_ENDPOINTS` |
| `clients/ledgerClient.ts` | Typed wrapper over `PostJournal` with the three journal templates from section 7 |
| `recovery/worker.ts` | The recovery loop |

### CreateTransfer, step by step

1. **Validate.** `client_id` and `idempotency_key` non-empty. Payer and payee not the same `(bank_id, account_id)`, else `INVALID_ARGUMENT` with code `SAME_ACCOUNT`. Both `bank_id` values in `BANK_ENDPOINTS`, else `UNKNOWN_BANK`. Amount in `1..MAX_TRANSFER_AMOUNT`, else `INVALID_AMOUNT`. Currency `INR`, else `UNSUPPORTED_CURRENCY`.
2. **Hash.** `request_hash = sha256Hex(canonicalJson({payer, payee, amount, currency, note: note ?? ""}))`.
3. **Register.** In one transaction run `INSERT INTO transfers (...) VALUES (...) ON CONFLICT (client_id, idempotency_key) DO NOTHING RETURNING *`, with state `INITIATED` and the lease already owned by this instance. If a row came back, also insert the `transfer_events` row (`NULL` to `INITIATED`). This call now owns the transfer.
4. **Duplicate key.** If no row came back, select the existing transfer. A different `request_hash` returns gRPC `ALREADY_EXISTS` with trailer `x-error-code: IDEMPOTENCY_KEY_REUSED`. The same hash is a replay: while the transfer is non-terminal, poll the row every 100 ms for up to `REPLAY_WAIT_MS` (default 2000) and return the latest row with `replayed = true`. A replay never drives the saga; the owner or the recovery worker does.
5. **Drive.** Call `saga.advance(transfer, {mode: 'inline', deadline: now + SAGA_INLINE_BUDGET_MS})` and return the latest transfer with `replayed = false`.

Business failures (insufficient funds and so on) are **not** gRPC errors. They return `OK` with `state = FAILED` or `REVERSED` and a `failure_code`.

### Saga engine

`advance` loops until the transfer is terminal, an outcome is unknown, the inline budget runs out, or the lease or version is lost. The transition table, failure paths and diagram are in section 11. The loop:

```text
advance(t):
  while not terminal(t.state):
    if inline and now > deadline: return yield(t)
    switch t.state:
      INITIATED:   t = cas(t, DEBIT_SENT)
      DEBIT_SENT:  r = debitStep(t)      // bank Debit, then ledger debit-leg
                   if r.ok:        t = cas(t, DEBITED)
                   elif r.definite: t = cas(t, FAILED, r.code)
                   elif r.bug:      t = cas(t, NEEDS_MANUAL_REVIEW)
                   else:            return yield(t)
      DEBITED:     t = cas(t, CREDIT_SENT)
      CREDIT_SENT: r = creditStep(t)     // bank Credit, then ledger credit-leg
                   if r.ok:        t = cas(t, CREDITED)
                   elif r.definite: t = cas(t, REVERSING, r.code)
                   elif r.bug:      t = cas(t, NEEDS_MANUAL_REVIEW)
                   else:            return yield(t)
      CREDITED:    t = cas(t, SUCCESS)
      REVERSING:   r = reverseStep(t)    // bank ReverseDebit, then ledger reversal
                   if r.ok:        t = cas(t, REVERSED)
                   elif r.bug:      t = cas(t, NEEDS_MANUAL_REVIEW)
                   else:            return yield(t)
  return t
```

- Every `cas` renews the lease (`lease_expires_at = now() + LEASE_MS`), resets `attempts` to 0 and logs `transfer_id`, `from_state`, `to_state`.
- `yield(t)` schedules recovery: `attempts = attempts + 1`, `next_attempt_at = now() + backoff(attempts)`, releases the lease, returns the transfer as it stands.
- `debitStep`: call `Debit` on the payer's bank with reference id = transfer id. On `UNKNOWN_OUTCOME`, retry the same request up to `INLINE_BANK_RETRIES` times with backoff. On success post the `debit-leg` journal (retried the same way). If the Ledger stays unreachable the result is unknown, the transfer stays in `DEBIT_SENT`, and the already-applied bank debit is rediscovered by the retry or by `Resolve`.
- `creditStep`: same shape with `Credit` on the payee's bank and the `credit-leg` journal. A definite failure here leads to `REVERSING`, not `FAILED`.
- `reverseStep`: `ReverseDebit` on the payer's bank, then the `reversal` journal. A definite failure of `ReverseDebit` means an invariant was broken, so the result is `bug`.
- A Ledger answer of `INVALID_ARGUMENT` or `FAILED_PRECONDITION` is a `bug`, never retried.

### Recovery worker

Runs in every Orchestrator instance. Every `RECOVERY_POLL_MS` (default 1000):

1. Claim up to `RECOVERY_BATCH` (20) due transfers with the claim query in section 13 (`FOR UPDATE SKIP LOCKED`, lease required to be free).
2. Process up to `RECOVERY_CONCURRENCY` (5) at a time:
   - `INITIATED`, `DEBITED`, `CREDITED`: call `advance`.
   - `DEBIT_SENT` or `CREDIT_SENT` with `attempts < RESOLVE_AFTER_ATTEMPTS` (3): call `advance`, which repeats the idempotent step.
   - `DEBIT_SENT` or `CREDIT_SENT` with `attempts >= RESOLVE_AFTER_ATTEMPTS`: call `Resolve(reference_id = transfer id, operation)` on the relevant bank. `APPLIED`: post that leg's journal, CAS to `DEBITED` or `CREDITED`, then `advance`. `VOIDED`: from `DEBIT_SENT` CAS to `FAILED` with `DEBIT_NOT_CONFIRMED`; from `CREDIT_SENT` CAS to `REVERSING` with `CREDIT_NOT_CONFIRMED`, then `advance`. A transient error: `yield`.
   - `REVERSING`: call `advance`. A reversal is never abandoned early and is never resolved by voiding.
3. If `attempts >= MAX_RECOVERY_ATTEMPTS` (20) the transfer moves to `NEEDS_MANUAL_REVIEW` with event reason `RECOVERY_EXHAUSTED`.
4. Refresh the `transfers_in_flight` gauge every loop.

Backoff is `min(1000 * 2^attempts, 60000)` ms plus random jitter of up to 20 percent.

### Shutdown

On `SIGTERM`: stop accepting new calls (`server.tryShutdown`), wait up to 10 seconds for inline sagas, stop the recovery loop, close the pool. Anything unfinished is picked up by another instance after its lease expires.

### The Orchestrator must never

- Call a bank before the `*_SENT` state is committed.
- Move to `FAILED` or `REVERSING` after a timeout unless `Resolve` returned `VOIDED`.
- Mark `SUCCESS` unless both ledger journals are posted.
- Hold a database transaction open across a gRPC call.
- Drive a transfer whose lease it does not hold, or write a state without the CAS.

## Service: Ledger

The Ledger is the switch's append-only, double-entry set of books. gRPC port **50052**, HTTP port **9102**, database `ledger_db` on `postgres-ledger`. It is a leaf service: it calls nobody.

### Chart of accounts

Seeded by migration `0002_seed_accounts.sql`. All accounts are in INR. Adding a bank later means adding two accounts in a new migration.

| Code | Type | Normal side | Meaning |
| --- | --- | --- | --- |
| `receivable:bank_a` | ASSET | debit | Amount `bank_a` owes the switch for debits it applied |
| `receivable:bank_b` | ASSET | debit | Same for `bank_b` |
| `payable:bank_a` | LIABILITY | credit | Amount the switch owes `bank_a` for credits it applied |
| `payable:bank_b` | LIABILITY | credit | Same for `bank_b` |
| `transit` | LIABILITY | credit | Money taken from a payer and not yet delivered to a payee. Zero when no transfer is in flight |

### Journal templates

The Orchestrator posts exactly these three journals. Each uses the transfer amount, `reference_id` = transfer id and currency `INR`.

| Journal | Idempotency key | `kind` | Debit | Credit |
| --- | --- | --- | --- | --- |
| debit-leg | `transfer:{id}:debit-leg` | `TRANSFER_DEBIT_LEG` | `receivable:{payer_bank}` | `transit` |
| credit-leg | `transfer:{id}:credit-leg` | `TRANSFER_CREDIT_LEG` | `transit` | `payable:{payee_bank}` |
| reversal | `transfer:{id}:reversal` | `TRANSFER_REVERSAL` | `transit` | `receivable:{payer_bank}` |

Worked example, 12,500 paise from `bank_a` to `bank_b`: the debit leg puts 12,500 on `receivable:bank_a` (debit) and `transit` (credit). The credit leg moves `transit` back to zero and puts 12,500 on `payable:bank_b`. A reversal after a failed credit undoes the debit leg exactly.

### PostJournal algorithm

1. **Validate** in `domain/validate.ts`: 2 to 10 lines; every amount greater than 0; direction set; total debits equal total credits; currency `INR`; `idempotency_key` 1 to 200 characters; `reference_id` and `kind` non-empty. Failure returns `INVALID_ARGUMENT` with `x-error-code: JOURNAL_INVALID`.
2. **Hash.** `request_hash = sha256Hex(canonicalJson({reference_id, kind, currency, lines}))` with lines sorted by `(account_code, direction, amount)`.
3. **Transaction** at `READ COMMITTED`:
   1. `INSERT INTO journals (...) ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`.
   2. No row returned: read the existing journal. A different hash returns `ALREADY_EXISTS` with `IDEMPOTENCY_KEY_REUSED`. The same hash returns that journal with `replayed = true`.
   3. Resolve account codes with one query (`WHERE code = ANY($1)`). An unknown code rolls back and returns `NOT_FOUND` with `ACCOUNT_NOT_FOUND`.
   4. Insert all entries in a single multi-row `INSERT`.
   5. Commit. The deferred constraint trigger (section 10) asserts the journal balances at commit time.
4. **Return** the journal and the `replayed` flag.

Two concurrent calls with the same key are safe with no explicit locking: the second blocks on the unique index until the first commits, then takes the replay branch.

### Other RPCs

| RPC | Behaviour |
| --- | --- |
| `GetJournal` | By `journal_id`. `NOT_FOUND` with `JOURNAL_NOT_FOUND` if absent |
| `ListJournals` | By `reference_id`, ordered by `created_at`, at most 50. Used by tests to verify exactly-once effects |
| `GetBalance` | Derived balance of one account (below) |
| `GetTrialBalance` | Every account plus `total_debits`, `total_credits`, `balanced`, read in one `REPEATABLE READ READ ONLY` transaction |

### Balances are derived, never stored

There is no balance column. `GetBalance` sums `entries` for the account inside a `REPEATABLE READ READ ONLY` transaction. `balance` is `debit_total - credit_total` for ASSET accounts and `credit_total - debit_total` for LIABILITY accounts.

Reason: `transit` is touched by every transfer. A mutable balance row there would serialize all transfers behind one row lock. Append-only inserts never conflict with each other, so throughput scales with Postgres. Balance snapshots for read speed are out of scope for phase 1.

### The Ledger must never

- Update or delete a journal or entry (database triggers enforce this).
- Store a running balance.
- Accept a journal that references an unknown account.
- Call another service.

## Service: Mock Bank

The Mock Bank simulates an external bank. It is authoritative for customer balances, idempotent by reference id, and can be slow, drop responses or apply requests late on demand. One codebase runs as two instances:

| Instance | `BANK_ID` | gRPC | HTTP | Database |
| --- | --- | --- | --- | --- |
| `bank-a` | `bank_a` | 50061 | 9111 | `bank_a` on `postgres-banks` |
| `bank-b` | `bank_b` | 50062 | 9112 | `bank_b` on `postgres-banks` |

`postgres-banks` is one Postgres container hosting two databases because banks stand in for external systems. The switch's own services (Orchestrator, Ledger) each have a dedicated Postgres container.

### Operation semantics

Every money operation is keyed by `(reference_id, operation)`, the primary key of the `operations` table. All run in one transaction at `READ COMMITTED`. The reference id the Orchestrator sends is the transfer id.

**Debit** (`reference_id, account_id, amount, currency`)

1. `INSERT INTO operations (...) VALUES (..., 'DEBIT', ..., 'APPLIED') ON CONFLICT DO NOTHING RETURNING *`. If another transaction holds the same key uncommitted, this blocks until it finishes.
2. Conflict: read the existing row. `VOIDED` returns `FAILED_PRECONDITION` with `REFERENCE_VOIDED`. `APPLIED` with the same account and amount returns the original result (idempotent replay). `APPLIED` with different parameters returns `INVALID_ARGUMENT` with `REFERENCE_CONFLICT`.
3. Inserted: run `UPDATE accounts SET balance = balance - $amount WHERE account_id = $id AND status = 'ACTIVE' AND currency = $cur AND balance >= $amount RETURNING balance`. If no row is returned, work out why (missing account is `NOT_FOUND` / `ACCOUNT_NOT_FOUND`; blocked is `FAILED_PRECONDITION` / `ACCOUNT_BLOCKED`; otherwise `FAILED_PRECONDITION` / `INSUFFICIENT_FUNDS`) and **roll back the whole transaction**, including the operation row. Business rejections are not recorded; the Orchestrator treats the first definite answer as final.
4. Commit and return `{bank_txn_id, status: APPLIED, balance_after, applied_at}`.

The conditional `UPDATE` is what prevents double-spend: the balance check and the decrement are one atomic statement, so two concurrent debits can never both pass on the same funds.

**Credit** is the same with `balance + $amount`. Its rejections are `ACCOUNT_NOT_FOUND` and `ACCOUNT_BLOCKED` only.

**ReverseDebit** (`reference_id`)

1. Read the `DEBIT` row for the reference. Missing or not `APPLIED` returns `FAILED_PRECONDITION` with `NOTHING_TO_REVERSE`.
2. `INSERT ... (reference_id, 'REVERSE_DEBIT', account_id, amount, 'APPLIED') ON CONFLICT DO NOTHING`. Conflict returns the original result.
3. Inserted: add the amount back to the same account. This works even if the account is now `BLOCKED`, because a refund must always succeed.

**Resolve** (`reference_id, operation` where operation is `DEBIT` or `CREDIT`) settles an unknown outcome for good:

1. `INSERT INTO operations (reference_id, operation, account_id, amount, status) VALUES ($1, $2, NULL, NULL, 'VOIDED') ON CONFLICT DO NOTHING`.
2. Select the row and return its status: `APPLIED` if the operation had already happened, otherwise `VOIDED`.

Once `Resolve` returns, the answer never changes. A late `Debit` or `Credit` that arrives afterwards hits the tombstone and fails with `REFERENCE_VOIDED`. If the operation committed first, `Resolve` sees `APPLIED`. The primary key arbitrates the race, which is the whole point of this design.

**GetOperation** is read-only and returns `APPLIED`, `VOIDED` or `NOT_FOUND`, plus account and amount. Used by tests and the future reconciliation job.

### Error codes

Sent as gRPC status plus trailer `x-error-code`.

| `x-error-code` | gRPC status | Class |
| --- | --- | --- |
| `INSUFFICIENT_FUNDS` | `FAILED_PRECONDITION` | definite failure |
| `ACCOUNT_BLOCKED` | `FAILED_PRECONDITION` | definite failure |
| `ACCOUNT_NOT_FOUND` | `NOT_FOUND` | definite failure |
| `REFERENCE_VOIDED` | `FAILED_PRECONDITION` | definite failure (operation was never applied) |
| `NOTHING_TO_REVERSE` | `FAILED_PRECONDITION` | bug (invariant broken) |
| `REFERENCE_CONFLICT` | `INVALID_ARGUMENT` | bug |
| `CURRENCY_MISMATCH` | `INVALID_ARGUMENT` | definite failure |

### Chaos engine

Chaos configuration lives in memory because it is test configuration, not business state. It starts from env vars (all zero by default) and is replaced at runtime with `SetChaosConfig`.

| Field | Meaning |
| --- | --- |
| `down` | Every RPC except the admin ones returns `UNAVAILABLE` immediately |
| `latency_min_ms`, `latency_max_ms` | Uniform random sleep before the operation |
| `reject_rate` | Probability of returning `UNAVAILABLE` without touching the database |
| `late_apply_rate` | Probability of sleeping `slow_ms` first, then applying normally. The client has timed out by then |
| `lost_response_rate` | Probability of applying and committing, then sleeping `slow_ms` before answering. The client has timed out |
| `slow_ms` | Default 3000. Must exceed the Orchestrator's `BANK_CALL_TIMEOUT_MS` (2000) |
| `seed` | Seed for the PRNG; the same seed gives the same injected failures |

Rules:

- One uniform draw per request from a seeded PRNG (`chaos/prng.ts`, mulberry32). Cumulative thresholds in this order: `reject_rate`, then `late_apply_rate`, then `lost_response_rate`; anything above is a normal request. `SetChaosConfig` rejects configs where the three rates sum to more than 1.
- Modes apply to `Debit`, `Credit` and `ReverseDebit`. `Resolve` and `GetOperation` honour only `down`, latency and `reject_rate`. Admin RPCs (`CreateAccount`, `GetAccount`, `SetChaosConfig`, `GetChaosConfig`) are exempt from chaos.
- The bank must **not** check whether the client cancelled. A late apply that lands after the client gave up is exactly the case being tested.
- Count every injected failure in the metric `chaos_injected_total{mode}`.

### The Mock Bank must never

- Apply the same `(reference_id, operation)` twice.
- Let a balance go negative (the `CHECK` constraint and the conditional `UPDATE` both guard this).
- Keep balances or operations in memory.

## Protobuf contracts

Create these three files verbatim under `proto/`. All amounts are `int64` paise. All errors use gRPC status codes plus the `x-error-code` trailer described in section 14. Enum values are prefixed so `buf lint` passes. Keep the package names; the generated TypeScript imports depend on them.

### `proto/bank/v1/bank.proto`

```proto
syntax = "proto3";

package switchpay.bank.v1;

import "google/protobuf/empty.proto";
import "google/protobuf/timestamp.proto";

service BankService {
  rpc Debit(MoneyOperationRequest) returns (MoneyOperationResponse);
  rpc Credit(MoneyOperationRequest) returns (MoneyOperationResponse);
  rpc ReverseDebit(ReverseDebitRequest) returns (MoneyOperationResponse);
  rpc Resolve(ResolveRequest) returns (ResolveResponse);
  rpc GetOperation(GetOperationRequest) returns (GetOperationResponse);

  // Admin and test support. Exempt from chaos injection.
  rpc CreateAccount(CreateAccountRequest) returns (Account);
  rpc GetAccount(GetAccountRequest) returns (Account);
  rpc SetChaosConfig(ChaosConfig) returns (ChaosConfig);
  rpc GetChaosConfig(google.protobuf.Empty) returns (ChaosConfig);
}

enum OperationType {
  OPERATION_TYPE_UNSPECIFIED = 0;
  OPERATION_TYPE_DEBIT = 1;
  OPERATION_TYPE_CREDIT = 2;
  OPERATION_TYPE_REVERSE_DEBIT = 3;
}

enum OperationStatus {
  OPERATION_STATUS_UNSPECIFIED = 0;
  OPERATION_STATUS_APPLIED = 1;
  OPERATION_STATUS_VOIDED = 2;
  OPERATION_STATUS_NOT_FOUND = 3;
}

message MoneyOperationRequest {
  string reference_id = 1; // transfer id (UUID); the idempotency key of the operation
  string account_id = 2;
  int64 amount = 3;        // paise, greater than 0
  string currency = 4;     // INR
}

message ReverseDebitRequest {
  string reference_id = 1;
}

message MoneyOperationResponse {
  string bank_txn_id = 1;
  OperationStatus status = 2;
  int64 balance_after = 3;
  google.protobuf.Timestamp applied_at = 4;
}

message ResolveRequest {
  string reference_id = 1;
  OperationType operation = 2; // DEBIT or CREDIT only
}

message ResolveResponse {
  OperationStatus status = 1; // APPLIED or VOIDED, never NOT_FOUND
}

message GetOperationRequest {
  string reference_id = 1;
  OperationType operation = 2;
}

message GetOperationResponse {
  OperationStatus status = 1;
  string account_id = 2;
  int64 amount = 3;
}

message Account {
  string account_id = 1;
  string holder_name = 2;
  int64 balance = 3;
  string currency = 4;
  string status = 5; // ACTIVE or BLOCKED
}

message CreateAccountRequest {
  string account_id = 1;
  string holder_name = 2;
  int64 opening_balance = 3;
  string currency = 4;
  string status = 5; // defaults to ACTIVE when empty
}

message GetAccountRequest {
  string account_id = 1;
}

message ChaosConfig {
  bool down = 1;
  uint32 latency_min_ms = 2;
  uint32 latency_max_ms = 3;
  double reject_rate = 4;
  double late_apply_rate = 5;
  double lost_response_rate = 6;
  uint32 slow_ms = 7;
  uint32 seed = 8;
}
```

### `proto/ledger/v1/ledger.proto`

```proto
syntax = "proto3";

package switchpay.ledger.v1;

import "google/protobuf/empty.proto";
import "google/protobuf/timestamp.proto";

service LedgerService {
  rpc PostJournal(PostJournalRequest) returns (PostJournalResponse);
  rpc GetJournal(GetJournalRequest) returns (Journal);
  rpc ListJournals(ListJournalsRequest) returns (ListJournalsResponse);
  rpc GetBalance(GetBalanceRequest) returns (AccountBalance);
  rpc GetTrialBalance(google.protobuf.Empty) returns (TrialBalanceResponse);
}

enum EntryDirection {
  ENTRY_DIRECTION_UNSPECIFIED = 0;
  ENTRY_DIRECTION_DEBIT = 1;
  ENTRY_DIRECTION_CREDIT = 2;
}

message EntryLine {
  string account_code = 1;
  EntryDirection direction = 2;
  int64 amount = 3; // paise, greater than 0
}

message PostJournalRequest {
  string idempotency_key = 1;
  string reference_id = 2;
  string kind = 3;
  string description = 4;
  string currency = 5;
  repeated EntryLine lines = 6;
}

message PostJournalResponse {
  Journal journal = 1;
  bool replayed = 2;
}

message Journal {
  string journal_id = 1;
  string idempotency_key = 2;
  string reference_id = 3;
  string kind = 4;
  string description = 5;
  string currency = 6;
  repeated EntryLine lines = 7;
  google.protobuf.Timestamp created_at = 8;
}

message GetJournalRequest {
  string journal_id = 1;
}

message ListJournalsRequest {
  string reference_id = 1;
}

message ListJournalsResponse {
  repeated Journal journals = 1;
}

message GetBalanceRequest {
  string account_code = 1;
}

message AccountBalance {
  string account_code = 1;
  string account_type = 2;  // ASSET or LIABILITY
  int64 debit_total = 3;
  int64 credit_total = 4;
  int64 balance = 5;        // normal-side balance, see section 7
  string currency = 6;
}

message TrialBalanceResponse {
  repeated AccountBalance accounts = 1;
  int64 total_debits = 2;
  int64 total_credits = 3;
  bool balanced = 4;
}
```

### `proto/orchestrator/v1/orchestrator.proto`

```proto
syntax = "proto3";

package switchpay.orchestrator.v1;

import "google/protobuf/timestamp.proto";

service TransferService {
  rpc CreateTransfer(CreateTransferRequest) returns (CreateTransferResponse);
  rpc GetTransfer(GetTransferRequest) returns (Transfer);
}

enum TransferState {
  TRANSFER_STATE_UNSPECIFIED = 0;
  TRANSFER_STATE_INITIATED = 1;
  TRANSFER_STATE_DEBIT_SENT = 2;
  TRANSFER_STATE_DEBITED = 3;
  TRANSFER_STATE_CREDIT_SENT = 4;
  TRANSFER_STATE_CREDITED = 5;
  TRANSFER_STATE_SUCCESS = 6;
  TRANSFER_STATE_FAILED = 7;
  TRANSFER_STATE_REVERSING = 8;
  TRANSFER_STATE_REVERSED = 9;
  TRANSFER_STATE_NEEDS_MANUAL_REVIEW = 10;
}

message Party {
  string bank_id = 1;
  string account_id = 2;
}

message CreateTransferRequest {
  string client_id = 1;        // set by the Gateway from the JWT, never from the body
  string idempotency_key = 2;
  Party payer = 3;
  Party payee = 4;
  int64 amount = 5;
  string currency = 6;
  string note = 7;
}

message CreateTransferResponse {
  Transfer transfer = 1;
  bool replayed = 2;
}

message GetTransferRequest {
  string transfer_id = 1;
  string client_id = 2;        // a client can only read its own transfers; otherwise NOT_FOUND
}

message Transfer {
  string transfer_id = 1;
  TransferState state = 2;
  Party payer = 3;
  Party payee = 4;
  int64 amount = 5;
  string currency = 6;
  string note = 7;
  string failure_code = 8;
  string failure_message = 9;
  google.protobuf.Timestamp created_at = 10;
  google.protobuf.Timestamp updated_at = 11;
}
```

The database stores the state as text (`DEBIT_SENT`). `grpc/handlers.ts` in the Orchestrator converts between the enum and the text. Never renumber or reuse a field number.

## Database schemas

Each service has its own database and migrations folder. Use these statements as written. Conventions: `timestamptz` for every timestamp, `bigint` for every money column, `CHECK` constraints for every enum-like text column, and no foreign keys across databases.

**Migration runner** (`packages/common/src/migrate.ts`): runs at service start, takes `pg_advisory_lock(727274)`, creates `schema_migrations(filename text primary key, applied_at timestamptz)`, applies each unapplied `NNNN_name.sql` file in filename order inside one transaction, and aborts startup if any fails. A migration is never edited after it is merged; changes go in a new file.

### Orchestrator: `services/orchestrator/migrations/0001_init.sql`

```sql
CREATE TABLE transfers (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id         text        NOT NULL,
  idempotency_key   text        NOT NULL,
  request_hash      text        NOT NULL,
  payer_bank_id     text        NOT NULL,
  payer_account_id  text        NOT NULL,
  payee_bank_id     text        NOT NULL,
  payee_account_id  text        NOT NULL,
  amount            bigint      NOT NULL CHECK (amount > 0),
  currency          char(3)     NOT NULL DEFAULT 'INR',
  note              text,
  state             text        NOT NULL CHECK (state IN (
                      'INITIATED','DEBIT_SENT','DEBITED','CREDIT_SENT','CREDITED',
                      'SUCCESS','FAILED','REVERSING','REVERSED','NEEDS_MANUAL_REVIEW')),
  failure_code      text,
  failure_message   text,
  version           integer     NOT NULL DEFAULT 1,
  attempts          integer     NOT NULL DEFAULT 0,
  next_attempt_at   timestamptz NOT NULL DEFAULT now(),
  lease_owner       text,
  lease_expires_at  timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT transfers_idempotency_uniq UNIQUE (client_id, idempotency_key)
);

CREATE INDEX transfers_recovery_idx ON transfers (next_attempt_at)
  WHERE state IN ('INITIATED','DEBIT_SENT','DEBITED','CREDIT_SENT','CREDITED','REVERSING');

CREATE INDEX transfers_state_idx ON transfers (state);

CREATE TABLE transfer_events (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  transfer_id  uuid        NOT NULL REFERENCES transfers (id),
  from_state   text,
  to_state     text        NOT NULL,
  reason       text        NOT NULL,
  detail       jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX transfer_events_transfer_idx ON transfer_events (transfer_id, id);
```

### Mock Bank: `services/mockBank/migrations/0001_init.sql`

```sql
CREATE TABLE accounts (
  account_id   text        PRIMARY KEY,
  holder_name  text        NOT NULL,
  balance      bigint      NOT NULL CHECK (balance >= 0),
  currency     char(3)     NOT NULL DEFAULT 'INR',
  status       text        NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','BLOCKED')),
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE operations (
  reference_id  text        NOT NULL,
  operation     text        NOT NULL CHECK (operation IN ('DEBIT','CREDIT','REVERSE_DEBIT')),
  status        text        NOT NULL CHECK (status IN ('APPLIED','VOIDED')),
  bank_txn_id   uuid        NOT NULL DEFAULT gen_random_uuid(),
  account_id    text,
  amount        bigint      CHECK (amount > 0),
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (reference_id, operation),
  CONSTRAINT applied_has_money CHECK (
    status = 'VOIDED' OR (account_id IS NOT NULL AND amount IS NOT NULL))
);

CREATE INDEX operations_account_idx ON operations (account_id, created_at);
```

`VOIDED` rows are the tombstones written by `Resolve`; they have no account or amount. `scripts/initBankDbs.sql` runs once in `postgres-banks` (mounted into `/docker-entrypoint-initdb.d/`) and contains `CREATE DATABASE bank_a; CREATE DATABASE bank_b;`.

### Ledger: `services/ledger/migrations/0001_init.sql`

```sql
CREATE TABLE accounts (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code        text        NOT NULL UNIQUE,
  type        text        NOT NULL CHECK (type IN ('ASSET','LIABILITY')),
  currency    char(3)     NOT NULL DEFAULT 'INR',
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE journals (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key  text        NOT NULL UNIQUE,
  request_hash     text        NOT NULL,
  reference_id     text        NOT NULL,
  kind             text        NOT NULL,
  description      text,
  currency         char(3)     NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX journals_reference_idx ON journals (reference_id, created_at);

CREATE TABLE entries (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  journal_id  uuid        NOT NULL REFERENCES journals (id),
  account_id  bigint      NOT NULL REFERENCES accounts (id),
  direction   char(1)     NOT NULL CHECK (direction IN ('D','C')),
  amount      bigint      NOT NULL CHECK (amount > 0),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX entries_account_idx ON entries (account_id);
CREATE INDEX entries_journal_idx ON entries (journal_id);

-- Append-only: no UPDATE or DELETE, ever.
CREATE FUNCTION forbid_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'table % is append-only', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER journals_append_only BEFORE UPDATE OR DELETE ON journals
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER entries_append_only BEFORE UPDATE OR DELETE ON entries
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Every journal must balance, checked at commit time.
CREATE FUNCTION assert_journal_balanced() RETURNS trigger AS $$
DECLARE
  d bigint;
  c bigint;
BEGIN
  SELECT COALESCE(SUM(amount) FILTER (WHERE direction = 'D'), 0),
         COALESCE(SUM(amount) FILTER (WHERE direction = 'C'), 0)
    INTO d, c FROM entries WHERE journal_id = NEW.journal_id;
  IF d <> c THEN
    RAISE EXCEPTION 'journal % unbalanced: debits % credits %', NEW.journal_id, d, c;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER entries_balanced
  AFTER INSERT ON entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_journal_balanced();
```

### Ledger: `services/ledger/migrations/0002_seed_accounts.sql`

```sql
INSERT INTO accounts (code, type) VALUES
  ('receivable:bank_a', 'ASSET'),
  ('receivable:bank_b', 'ASSET'),
  ('payable:bank_a',    'LIABILITY'),
  ('payable:bank_b',    'LIABILITY'),
  ('transit',           'LIABILITY');
```

## Transfer lifecycle

&#91;embedded content: transfer state machine · 10 states, 4 terminal\]

A transfer moves forward one persisted state at a time and ends in `SUCCESS`, `FAILED`, `REVERSED` or `NEEDS_MANUAL_REVIEW`. No transition ever leaves a terminal state, and a timeout never changes the current state.

### Transition table

| State | Action | On success | On definite failure | On unknown outcome |
| --- | --- | --- | --- | --- |
| `INITIATED` | Save the intent before any external call | `DEBIT_SENT` | none | none |
| `DEBIT_SENT` | Payer bank `Debit`, then Ledger `debit-leg` | `DEBITED` | `FAILED` | Stay; retry inline, then recovery, then `Resolve` |
| `DEBITED` | Save the intent to call the payee bank | `CREDIT_SENT` | none | none |
| `CREDIT_SENT` | Payee bank `Credit`, then Ledger `credit-leg` | `CREDITED` | `REVERSING` | Stay; retry inline, then recovery, then `Resolve` |
| `CREDITED` | Finalize | `SUCCESS` | none | none |
| `REVERSING` | Payer bank `ReverseDebit`, then Ledger `reversal` | `REVERSED` | `NEEDS_MANUAL_REVIEW` (only for a bug) | Stay; retried with backoff until it works |

A state such as `DEBIT_SENT` means the debit was attempted and its outcome is not yet recorded. `DEBITED` means the payer bank confirmed **and** the Ledger `debit-leg` is posted. The same holds for `CREDIT_SENT` and `CREDITED`.

### Walkthrough: success (12,500 paise from `bank_a` to `bank_b`)

1. The Gateway authenticates, rate-limits and validates, then calls `CreateTransfer`.
2. The Orchestrator inserts the transfer as `INITIATED` and moves it to `DEBIT_SENT`.
3. `bank_a.Debit` applies. The Orchestrator posts `debit-leg` to the Ledger and the transfer becomes `DEBITED`.
4. The transfer moves to `CREDIT_SENT`. `bank_b.Credit` applies, `credit-leg` is posted, the transfer becomes `CREDITED`.
5. The transfer becomes `SUCCESS` and the Gateway answers `201`.

Net effect: the payer has 12,500 less at `bank_a`, the payee has 12,500 more at `bank_b`, and `transit` is back to zero.

### Walkthrough: payee account does not exist

1. Steps 1 to 3 above, so the payer has been debited.
2. `bank_b.Credit` answers `NOT_FOUND`. The transfer moves to `REVERSING` with failure code `PAYEE_ACCOUNT_NOT_FOUND`.
3. `bank_a.ReverseDebit` refunds the payer. The Orchestrator posts the `reversal` journal.
4. The transfer becomes `REVERSED` and the Gateway answers `422`.

### Walkthrough: the Orchestrator crashes mid-transfer

1. `bank_a` applied the debit, but the Orchestrator died before saving `DEBITED`. The row still says `DEBIT_SENT`.
2. Within `LEASE_MS` (15 seconds) the lease expires. A recovery worker claims the transfer.
3. It repeats `Debit` with the same reference id. The bank returns the original result without debiting again.
4. It posts `debit-leg`, saves `DEBITED` and carries on to `SUCCESS`. A client that retried with the same `Idempotency-Key` sees that same transfer.

## Idempotency

A retry must never move money twice. Three independent layers enforce it, each with its own key and its own database constraint.

| Layer | Key | Enforced by | Effect of a duplicate |
| --- | --- | --- | --- |
| Client to Orchestrator | `(client_id, Idempotency-Key)` | `UNIQUE` constraint on `transfers` | The existing transfer is returned; no second saga starts |
| Orchestrator to Bank | `(reference_id = transfer id, operation)` | Primary key of the bank's `operations` table | The original bank result is returned; the balance changes once |
| Orchestrator to Ledger | `idempotency_key = transfer:{id}:{leg}` | `UNIQUE` on `journals.idempotency_key` | The original journal is returned; entries are inserted once |

### Rules

1. **Scope.** An idempotency key belongs to the authenticated client. The same string used by two clients is two unrelated keys.
2. **Fingerprint.** Each request is hashed with SHA-256 over canonical JSON (sorted keys) of payer, payee, amount, currency and note. The same key with a different fingerprint is rejected with 409 `IDEMPOTENCY_KEY_REUSED` and never touches the existing transfer.
3. **Same key, same body** always resolves to the same transfer, whatever its state. The replay returns the transfer as it is now, not a stored copy of the first HTTP response, so a transfer that was `202 PENDING` on the first call can be `SUCCEEDED` on the retry.
4. **Concurrency.** Two simultaneous identical requests are arbitrated by the unique index. The winner drives the saga. The loser sees the conflict, polls the row for up to `REPLAY_WAIT_MS`, and returns the latest state. Only the winner (or later the recovery worker) ever drives the saga.
5. **Retention.** Keys live on the `transfers` row and are kept forever in phase 1. Expiry is out of scope.
6. **Internal keys are derived, not random.** Bank reference ids and ledger keys come from the transfer id, so a retry after a crash regenerates the identical key.

### Client guidance (put this in the README)

- Create one fresh key (UUID v4) per payment intent and reuse it for every retry of that intent.
- Retry on network errors, 429 (after `Retry-After`), 503 and 504.
- Never reuse a key for a different payment. A 409 means exactly that.
- A `202` means the transfer is still in progress. Poll `GET /v1/transfers/{id}` until `status` is terminal.

## Concurrency, failures and recovery

### Concurrency control

| Hazard | Where | Mechanism |
| --- | --- | --- |
| Two debits spending the same funds | Mock Bank | One atomic conditional `UPDATE ... WHERE balance >= amount` |
| Duplicate client request racing the original | Orchestrator | `UNIQUE (client_id, idempotency_key)` with `INSERT ... ON CONFLICT DO NOTHING` |
| Two workers driving the same transfer | Orchestrator | Lease (`lease_owner`, `lease_expires_at`) |
| A worker writing after it lost the lease | Orchestrator | Compare-and-set on `version` and `state` (below) |
| A late bank request racing `Resolve` | Mock Bank | Primary key `(reference_id, operation)`: whichever inserts first wins |
| Duplicate ledger journal | Ledger | `UNIQUE` on `journals.idempotency_key` |
| Hot account serializing all transfers | Ledger | Balances derived from append-only entries, no balance row |

Every transfer state change uses this exact statement. Zero rows updated means another worker moved the transfer, so throw `StaleTransferError`, stop driving and do not retry the write:

```sql
UPDATE transfers
   SET state = $3, version = version + 1, attempts = 0,
       failure_code = COALESCE($4, failure_code), failure_message = COALESCE($5, failure_message),
       lease_expires_at = now() + ($6 || ' milliseconds')::interval,
       updated_at = now()
 WHERE id = $1 AND version = $2 AND lease_owner = $7
RETURNING *;
```

The same transaction then inserts the `transfer_events` row. A terminal state also clears `lease_owner` and `lease_expires_at`.

**Leases.** `LEASE_MS` defaults to 15000. The creating request owns the lease from the insert. The recovery worker can only claim a transfer whose lease is null or expired. Each successful CAS renews the lease. The lease owner is INSTANCE\_ID plus a random token generated for each drive attempt, so two drivers inside one process never share a lease.

### Isolation levels

All writes run at `READ COMMITTED`. Each invariant is guarded by one atomic statement or one key conflict, never by read-then-write logic, so `SERIALIZABLE` would add retry loops without adding protection. Read-only aggregates (`GetBalance`, `GetTrialBalance`) run at `REPEATABLE READ READ ONLY` for a consistent snapshot. Record this reasoning in `ADR-004`.

### Recovery claim query

```sql
UPDATE transfers
   SET lease_owner = $1,
       lease_expires_at = now() + ($2 || ' milliseconds')::interval
 WHERE id IN (
   SELECT id FROM transfers
    WHERE state IN ('INITIATED','DEBIT_SENT','DEBITED','CREDIT_SENT','CREDITED','REVERSING')
      AND next_attempt_at <= now()
      AND (lease_expires_at IS NULL OR lease_expires_at < now())
    ORDER BY next_attempt_at
    LIMIT $3
    FOR UPDATE SKIP LOCKED)
RETURNING *;
```

### Failure scenarios

The code and the tests must handle every row. No scenario may create or destroy money.

| # | Scenario | What happens | Final state |
| --- | --- | --- | --- |
| 1 | Payer bank rejects the debit: insufficient funds | Definite failure, nothing to undo | `FAILED` / `INSUFFICIENT_FUNDS` |
| 2 | Payer account missing or blocked | Definite failure | `FAILED` / `PAYER_ACCOUNT_NOT_FOUND` or `PAYER_ACCOUNT_BLOCKED` |
| 3 | Debit not applied, response is `UNAVAILABLE` or a timeout | Inline retries, then `yield`. Recovery repeats the debit. After 3 attempts `Resolve` returns `VOIDED` | `FAILED` / `DEBIT_NOT_CONFIRMED`, or continues if a retry succeeded |
| 4 | Debit applied but the response is lost | The retry returns the original `APPLIED` result; saga continues | `SUCCESS` (or the credit-side outcome) |
| 5 | Debit arrives late, after the client gave up | `Resolve` either sees `APPLIED` or writes the tombstone. A late request then fails with `REFERENCE_VOIDED`, so it never applies after being voided | Continues, or `FAILED` / `DEBIT_NOT_CONFIRMED` |
| 6 | Orchestrator crashes after the bank applied the debit, before `DEBITED` was saved | Stays `DEBIT_SENT`. Lease expires, recovery repeats the idempotent debit, gets the original result, posts the ledger leg | Continues to `SUCCESS` |
| 7 | Ledger is down after a successful bank debit | Stays `DEBIT_SENT`, retried with backoff, no money lost | Continues when the Ledger returns |
| 8 | Payee account missing or blocked | Credit is a definite failure, so `REVERSING`: refund the payer, post the reversal journal | `REVERSED` / `PAYEE_ACCOUNT_NOT_FOUND` or `PAYEE_ACCOUNT_BLOCKED` |
| 9 | Credit outcome unknown after retries | `Resolve` on the payee bank. `APPLIED` continues to `CREDITED`. `VOIDED` goes to `REVERSING` | `SUCCESS`, or `REVERSED` / `CREDIT_NOT_CONFIRMED` |
| 10 | Orchestrator crashes in `CREDIT_SENT` | Same recovery as scenario 6, on the credit side | `SUCCESS` or `REVERSED` |
| 11 | `ReverseDebit` fails transiently | Stays `REVERSING`, retried with backoff until it works | `REVERSED` (or `NEEDS_MANUAL_REVIEW` after 20 attempts) |
| 12 | Client retries while the first request is still running | Returns the latest state; no second saga | Same transfer |
| 13 | An Orchestrator instance is killed with many transfers in flight | Leases expire within `LEASE_MS`; any instance's recovery worker finishes them all | All terminal |
| 14 | Recovery exhausted, or the Ledger rejects a journal as invalid | Moves to `NEEDS_MANUAL_REVIEW`, increments an alert metric. The chaos test requires zero of these | `NEEDS_MANUAL_REVIEW` |

## Errors, deadlines and retries

### Error contract

Every gRPC error carries the gRPC status code, a trailer `x-error-code` (an upper-case constant from this document) and a human-readable message. Use `makeGrpcError(code, errorCode, message)` to send one and `errorCodeOf(err)` to read one.

### Classification

One function, `classify(err, target)` in `packages/common/src/grpc/errors.ts`, decides what any error from a downstream call means. `target` is `'bank'` or `'ledger'` because the same status can mean different things.

| Class | Matches | Saga reaction |
| --- | --- | --- |
| `DEFINITE_FAILURE` | From a bank: `FAILED_PRECONDITION` (except `NOTHING_TO_REVERSE`), `NOT_FOUND`, `INVALID_ARGUMENT` with `CURRENCY_MISMATCH` | Take the failure path for that step |
| `BUG` | `INVALID_ARGUMENT` otherwise, `NOTHING_TO_REVERSE`, any `NOT_FOUND` or `FAILED_PRECONDITION` or `ALREADY_EXISTS` from the ledger, `UNIMPLEMENTED`, `PERMISSION_DENIED`, `UNAUTHENTICATED` | `NEEDS_MANUAL_REVIEW`, never retried |
| `UNKNOWN_OUTCOME` | `UNAVAILABLE`, `DEADLINE_EXCEEDED`, `CANCELLED`, `INTERNAL`, `UNKNOWN`, `RESOURCE_EXHAUSTED`, `ABORTED`, `DATA_LOSS`, and any non-gRPC error such as a socket reset | Retry the same idempotent request, then `yield`; recovery resolves it |

When in doubt, classify as `UNKNOWN_OUTCOME`. It is the safe default because `Resolve` can always settle it.

### Failure codes

Stored in `transfers.failure_code`, with a readable `failure_message`. A bank answer of `REFERENCE_VOIDED` on a debit or credit is treated exactly like `Resolve` returning `VOIDED`.

| Code | Source | Resulting state |
| --- | --- | --- |
| `INSUFFICIENT_FUNDS` | Bank debit | `FAILED` |
| `PAYER_ACCOUNT_NOT_FOUND` | Bank debit, `NOT_FOUND` | `FAILED` |
| `PAYER_ACCOUNT_BLOCKED` | Bank debit | `FAILED` |
| `DEBIT_NOT_CONFIRMED` | `Resolve` returned `VOIDED`, or debit got `REFERENCE_VOIDED` | `FAILED` |
| `PAYEE_ACCOUNT_NOT_FOUND` | Bank credit, `NOT_FOUND` | `REVERSED` |
| `PAYEE_ACCOUNT_BLOCKED` | Bank credit | `REVERSED` |
| `CREDIT_NOT_CONFIRMED` | `Resolve` returned `VOIDED`, or credit got `REFERENCE_VOIDED` | `REVERSED` |
| `CURRENCY_MISMATCH` | Bank debit or credit | `FAILED` at debit, `REVERSED` at credit |
| `RECOVERY_EXHAUSTED` | 20 recovery attempts used | `NEEDS_MANUAL_REVIEW` |
| `LEDGER_REJECTED` | Ledger returned a `BUG`-class error | `NEEDS_MANUAL_REVIEW` |
| `BANK_INVARIANT_VIOLATION` | `ReverseDebit` returned a `BUG`-class error | `NEEDS_MANUAL_REVIEW` |

### Deadlines

Every gRPC call sets a deadline through `callUnary`. No call may run without one.

| Call | Timeout | Env var |
| --- | --- | --- |
| Gateway to Orchestrator `CreateTransfer` | 10000 ms | `ORCHESTRATOR_TIMEOUT_MS` |
| Gateway to Orchestrator `GetTransfer` | 3000 ms | none, constant |
| Orchestrator to bank (`Debit`, `Credit`, `ReverseDebit`, `Resolve`) | 2000 ms | `BANK_CALL_TIMEOUT_MS` |
| Orchestrator to Ledger `PostJournal` | 2000 ms | `LEDGER_CALL_TIMEOUT_MS` |
| Inline saga budget inside `CreateTransfer` | 8000 ms | `SAGA_INLINE_BUDGET_MS` |
| Replay wait for a duplicate request | 2000 ms | `REPLAY_WAIT_MS` |

Constraints the config loaders must enforce at startup: `SAGA_INLINE_BUDGET_MS` is smaller than `ORCHESTRATOR_TIMEOUT_MS`, and the Mock Bank `slow_ms` is larger than `BANK_CALL_TIMEOUT_MS`.

### Retry policy

- **Inline retries:** `INLINE_BANK_RETRIES` and `INLINE_LEDGER_RETRIES` (default 2 extra attempts each), delays from `withRetry` with `baseMs = 100`, `maxMs = 800`, full jitter. Only for `UNKNOWN_OUTCOME`. Safe because every bank and ledger call is idempotent.
- **Recovery retries:** delay `min(1000 * 2^attempts, 60000)` ms plus up to 20 percent jitter, stored in `next_attempt_at`.
- **Never retried:** `DEFINITE_FAILURE` and `BUG`.
- gRPC's built-in retry policy stays disabled (`grpc.enable_retries: 0`) so all retries are explicit and counted in metrics.

## Configuration and deployment

Every service reads configuration from environment variables through `loadConfig(zodSchema)` and refuses to start on a missing or invalid value. Commit `.env.example` containing every variable below with its default. Common to all services: `NODE_ENV` (default `development`) and `LOG_LEVEL` (default `info`).

### Environment variables

**Gateway**

| Variable | Default |
| --- | --- |
| `HTTP_PORT` | `8080` |
| `JWT_SECRET` | required, at least 32 characters |
| `JWT_TTL_SECONDS` | `900` |
| `API_CLIENTS` | required JSON array of `{client_id, client_secret}` |
| `REDIS_URL` | `redis://redis:6379` |
| `RATE_LIMIT_RPS` / `RATE_LIMIT_BURST` | `100` / `200` |
| `ORCHESTRATOR_ADDR` | `orchestrator:50051` |
| `ORCHESTRATOR_TIMEOUT_MS` | `10000` |
| `MAX_TRANSFER_AMOUNT` | `10000000` |

**Orchestrator**

| Variable | Default |
| --- | --- |
| `GRPC_PORT` / `HTTP_PORT` | `50051` / `9101` |
| `DATABASE_URL` | `postgres://orch:orch@postgres-orchestrator:5432/orchestrator_db` |
| `BANK_ENDPOINTS` | `bank_a=bank-a:50061,bank_b=bank-b:50062` |
| `LEDGER_ADDR` | `ledger:50052` |
| `MAX_TRANSFER_AMOUNT` | `10000000` |
| `BANK_CALL_TIMEOUT_MS` / `LEDGER_CALL_TIMEOUT_MS` | `2000` / `2000` |
| `INLINE_BANK_RETRIES` / `INLINE_LEDGER_RETRIES` | `2` / `2` |
| `SAGA_INLINE_BUDGET_MS` | `8000` |
| `REPLAY_WAIT_MS` | `2000` |
| `LEASE_MS` | `15000` |
| `RECOVERY_POLL_MS` / `RECOVERY_BATCH` / `RECOVERY_CONCURRENCY` | `1000` / `20` / `5` |
| `RESOLVE_AFTER_ATTEMPTS` / `MAX_RECOVERY_ATTEMPTS` | `3` / `20` |
| `INSTANCE_ID` | container hostname |

**Ledger**

| Variable | Default |
| --- | --- |
| `GRPC_PORT` / `HTTP_PORT` | `50052` / `9102` |
| `DATABASE_URL` | `postgres://ledger:ledger@postgres-ledger:5432/ledger_db` |

**Mock Bank** (one set per instance)

| Variable | `bank-a` | `bank-b` |
| --- | --- | --- |
| `BANK_ID` | `bank_a` | `bank_b` |
| `GRPC_PORT` / `HTTP_PORT` | `50061` / `9111` | `50062` / `9112` |
| `DATABASE_URL` | `postgres://banks:banks@postgres-banks:5432/bank_a` | `postgres://banks:banks@postgres-banks:5432/bank_b` |

Both banks also read `CHAOS_SEED` (`42`), `CHAOS_DOWN` (`false`), `CHAOS_LATENCY_MIN_MS` and `CHAOS_LATENCY_MAX_MS` (`0`), `CHAOS_REJECT_RATE`, `CHAOS_LATE_APPLY_RATE`, `CHAOS_LOST_RESPONSE_RATE` (`0`) and `CHAOS_SLOW_MS` (`3000`).

### Docker Compose

| Service | Build or image | Host ports | Starts after (healthy) |
| --- | --- | --- | --- |
| `postgres-orchestrator` | `postgres:16` | 5433 | none |
| `postgres-ledger` | `postgres:16` | 5434 | none |
| `postgres-banks` | `postgres:16`, mounts `scripts/initBankDbs.sql` | 5435 | none |
| `redis` | `redis:7-alpine` | 6379 | none |
| `ledger` | Dockerfile, `SERVICE=ledger` | 50052, 9102 | `postgres-ledger` |
| `bank-a` | Dockerfile, `SERVICE=mockBank` | 50061, 9111 | `postgres-banks` |
| `bank-b` | Dockerfile, `SERVICE=mockBank` | 50062, 9112 | `postgres-banks` |
| `orchestrator` | Dockerfile, `SERVICE=orchestrator` | 50051, 9101 | `postgres-orchestrator` |
| `gateway` | Dockerfile, `SERVICE=gateway` | 8080 | `redis`, `orchestrator` |

The Orchestrator does not wait for the Ledger or the banks, because gRPC channels reconnect and a transfer that cannot reach a bank simply yields. Health checks:

- Postgres: `pg_isready -U <user>`. Redis: `redis-cli ping`.
- Node services: `wget -qO- http://localhost:<HTTP_PORT>/readyz`, interval 5 s, 10 retries. `/readyz` returns 200 once the database answers and migrations have run (Gateway: Redis answers and the Orchestrator channel is connected).
- Use named volumes for the three Postgres containers. `docker compose down -v` is the full reset.

All host ports are published so tests and `k6` can reach every service from outside Docker.

### Dockerfile (one file for every service)

```dockerfile
FROM node:20-alpine AS build
WORKDIR /app
COPY . .
RUN npm ci && npx buf generate && npx tsc -b

FROM node:20-alpine AS runtime
ARG SERVICE
ENV SERVICE=${SERVICE} NODE_ENV=production
WORKDIR /app
COPY --from=build /app /app
RUN npm prune --omit=dev
USER node
CMD ["sh", "-c", "node services/${SERVICE}/dist/main.js"]
```

Each service finds its migrations with `path.resolve(__dirname, '..', 'migrations')`, which resolves to `services/<name>/migrations` both locally and in the image.

### Root npm scripts

| Script | Command |
| --- | --- |
| `proto:gen` | `buf generate` |
| `proto:lint` | `buf lint` |
| `build` | `npm run proto:gen && tsc -b` |
| `lint` | `eslint . && prettier --check .` |
| `typecheck` | `tsc -b` |
| `test` | `vitest run --dir packages --dir services` (unit tests, no Docker needed) |
| `test:integration` | `vitest run tests/integration` (needs the stack) |
| `test:chaos` | `vitest run tests/chaos` (needs the stack) |
| `stack:up` | `docker compose up -d --build --wait` |
| `stack:down` | `docker compose down -v` |
| `seed` | `tsx scripts/seed.ts` (creates 10 accounts per bank, `A001` to `A010`, 10,000,000 paise each; idempotent) |
| `invariants` | `tsx scripts/checkInvariants.ts` (runs invariants I1 to I6 against the live stack) |
| `load` | `k6 run load/transfer.k6.js` |

## Testing and verification

The invariant test is the proof that the project is real. It is also the source of the numbers on the resume, so it must be exactly as strict as written here.

### Layers

| Layer | Location | Runs against | Covers |
| --- | --- | --- | --- |
| Unit | `services/*/test`, `packages/common/test` | no I/O | Transition map, `classify()`, hashing and canonical JSON, journal validation, backoff bounds, PRNG determinism, chaos threshold logic |
| Integration | `tests/integration` | Compose stack | Happy path, validation, idempotency, failure paths, rate limiting |
| Chaos | `tests/chaos` | Compose stack | Crash recovery, the invariant test |
| Load | `load/transfer.k6.js` | Compose stack | Throughput and latency |

### Test helpers (`tests/helpers`)

| File | Provides |
| --- | --- |
| `stack.ts` | Wait for readiness; `killService(name)` and `startService(name)` through the `docker compose` CLI |
| `gatewayClient.ts` | Cached token, `createTransfer(body, key)`, `getTransfer(id)` |
| `bankAdmin.ts` | gRPC clients for both banks (ports 50061 and 50062): `createAccount`, `getAccount`, `setChaos`, `getOperation` |
| `ledgerClient.ts` | `getTrialBalance`, `getBalance`, `listJournals` |
| `invariants.ts` | `snapshotBaseline()` and one function per invariant below |

### Required integration tests

- **happyPath**: a cross-bank transfer reaches `SUCCESS`; both balances change by exactly the amount; the ledger shows two journals; a same-bank transfer also works.
- **validation**: missing `Idempotency-Key`, malformed body, same payer and payee, unknown bank, amount above the maximum, missing or expired token.
- **idempotency**: replay returns the same id with `Idempotent-Replay: true`; a different body with the same key returns 409; 50 concurrent identical requests produce exactly one transfer and one bank debit; two clients using the same key do not collide.
- **failurePaths**: insufficient funds gives `FAILED`; a missing payee account gives `REVERSED` with the payer refunded; a bank set to `down` for a few seconds still ends in `SUCCESS` once it returns; `lost_response_rate = 1` ends in `SUCCESS` with a single debit; `late_apply_rate = 1` never leaves a transfer applied after being voided; stopping the Ledger leaves transfers pending and they complete after it restarts.

### Invariants

All invariants are computed against a **baseline snapshot** taken before the run, over the accounts the test created. That lets tests repeat on a stack that already has data. No other traffic may hit the stack during a run.

| ID | Invariant | How to check |
| --- | --- | --- |
| I1 | Every journal balances and the ledger as a whole is zero-sum | `GetTrialBalance.balanced` is true, and a direct SQL check on `ledger_db` finds no journal where debits differ from credits |
| I2 | Money is conserved | Sum of all test customer balances across both banks equals the baseline sum; no balance is negative |
| I3 | Nothing is left in transit | The `transit` balance equals its baseline once every transfer is terminal |
| I4 | The ledger agrees with each bank | For each bank: (sum of its customer balances minus baseline) plus (change in `receivable:bank` minus change in `payable:bank`) equals zero |
| I5 | Every transfer had exactly-once effects | See the table below |
| I6 | Everything finished cleanly | No transfer in a non-terminal state and zero in `NEEDS_MANUAL_REVIEW` |
| I7 | Replays are idempotent | Each sampled duplicate request returned the same transfer id and the same final state |

**I5, by final state.** Use `Bank.GetOperation(reference_id = transfer id, operation)` and `Ledger.ListJournals(reference_id = transfer id)`:

| Final state | Payer bank `DEBIT` | Payee bank `CREDIT` | Payer bank `REVERSE_DEBIT` | Ledger journals |
| --- | --- | --- | --- | --- |
| `SUCCESS` | exactly one `APPLIED` | exactly one `APPLIED` | none | `debit-leg` and `credit-leg` |
| `REVERSED` | exactly one `APPLIED` | none `APPLIED` (absent or `VOIDED`) | exactly one `APPLIED` | `debit-leg` and `reversal` |
| `FAILED` | none `APPLIED` (absent or `VOIDED`) | none | none | none |

### Crash recovery test (`tests/chaos/crashRecovery.test.ts`)

1. Set both banks to latency 200 to 400 ms so transfers are slow enough to be caught mid-flight.
2. Send 200 transfers concurrently.
3. After about 1 second run `docker compose kill orchestrator`, wait 3 seconds, then start it again.
4. Clear chaos. Poll every transfer until terminal (timeout 90 s).
5. Assert I1 to I6.

### Invariant test (`tests/chaos/invariant.test.ts`)

Parameters come from env with these defaults: `TRANSFER_COUNT=10000` (CI uses 1000), `CONCURRENCY=100`, `ACCOUNTS_PER_BANK=20`, `OPENING_BALANCE=1000000`.

1. Create the test accounts on both banks and take the baseline snapshot.
2. Configure both banks: latency 5 to 50 ms, `reject_rate` 0.05, `late_apply_rate` 0.02, `lost_response_rate` 0.03, `slow_ms` 3000, `seed` 42.
3. Generate transfers with a seeded PRNG: random payer and payee among all test accounts of both banks, amount 1 to 50000 paise (many will hit insufficient funds, which is intended). Make 5 percent target a non-existent payee account to force reversals, and send 5 percent as duplicates of an earlier request, fired concurrently.
4. Run at the configured concurrency. At 25, 50 and 75 percent of progress, kill the Orchestrator and restart it 2 seconds later. The client retries any 5xx or network error with the **same** key, up to 10 times, 500 ms apart.
5. When every request has an answer, clear chaos and poll every transfer until terminal (timeout 180 s).
6. Assert I1 to I7 and print a summary: count per final state, duplicates sent, injected chaos events per mode, recovery runs, p50 and p95 request latency, total duration.

The test passes only if every invariant holds and no transfer needs manual review.

### Load test (`load/transfer.k6.js`)

- `npm run seed -- --load` creates accounts `L0001` to `L0200` on each bank with 1,000,000,000 paise each.
- Scenario `constant-arrival-rate`: 200 iterations per second for 2 minutes, 100 pre-allocated VUs, at most 400. Each iteration posts a cross-bank transfer with a unique `Idempotency-Key`, random accounts and an amount of 100 to 10000 paise.
- Checks: status is 201, 202 or 422. Starting thresholds: `http_req_failed < 1%` and `p(95) < 500 ms` with chaos off. Treat these as targets to tune towards.
- After each run, execute `npm run invariants`. A load number only counts if the invariants still hold.
- Record results in `docs/benchmarks.md`: machine, commit hash, configuration, requests per second, p50, p95, p99 and error rate. **Every number on the resume must come from this file.** Never invent or round up a number.

## Observability, CI and documentation

### Logging

`pino` JSON to stdout. Standard fields: `service`, `level`, `time`, `msg`, `request_id`, and when known `transfer_id`, `from_state`, `to_state`, `bank_id`, `operation`, `outcome`, `duration_ms`. Write one line per state transition and one per downstream call result. Never log tokens, secrets or full request bodies.

### Metrics

Every service serves Prometheus metrics at `/metrics` on its HTTP port. `instrument()` adds `grpc_requests_total{method, code}` and `grpc_request_duration_seconds{method}` to every gRPC service.

| Service | Metric | Type | Labels |
| --- | --- | --- | --- |
| Gateway | `http_requests_total` | counter | `method`, `route`, `status` |
| Gateway | `http_request_duration_seconds` | histogram | `method`, `route` |
| Gateway | `rate_limit_rejections_total`, `rate_limit_fail_open_total` | counter | none |
| Orchestrator | `transfers_total` | counter | `final_state` |
| Orchestrator | `transfer_duration_seconds` | histogram | `final_state` |
| Orchestrator | `saga_step_duration_seconds` | histogram | `step` (`debit`, `credit`, `reverse`, `ledger`) |
| Orchestrator | `downstream_calls_total` | counter | `target`, `operation`, `outcome` (`ok`, `definite`, `unknown`, `bug`) |
| Orchestrator | `recovery_runs_total` | counter | `result` (`advanced`, `yielded`, `resolved_applied`, `resolved_voided`, `exhausted`) |
| Orchestrator | `transfers_in_flight` | gauge | `state` |
| Orchestrator | `manual_review_total` | counter | `reason` |
| Ledger | `journals_posted_total` | counter | `kind`, `replayed` |
| Mock Bank | `bank_operations_total` | counter | `operation`, `result` |
| Mock Bank | `chaos_injected_total` | counter | `mode` |

### CI: `.github/workflows/ci.yml`

1. **`static`**: checkout, Node 20, `npm ci`, `buf lint`, `buf breaking --against '.git#branch=main'` (pull requests only), `npm run lint`, `npm run build`, `npm test`.
2. **`integration`** (needs `static`): `npm run stack:up`, `npm run test:integration`, then `TRANSFER_COUNT=1000 npm run test:chaos`. On failure upload `docker compose logs` as an artifact. Always run `npm run stack:down`.
3. **`nightly`** (schedule and `workflow_dispatch`): the full `TRANSFER_COUNT=10000` chaos test.

### README, in this order

1. What it is, in three lines.
2. Architecture diagram.
3. Quick start: `npm run stack:up`, `npm run seed`, then curl examples for token, transfer and replay.
4. How correctness is proven: the invariant list and the command to run it.
5. Failure scenarios handled (a short version of the table in section 13).
6. Benchmarks, copied from `docs/benchmarks.md`.
7. Design decisions and tradeoffs, linking the ADRs.
8. "What I built and why": five lines added after each milestone.

### Diagrams in `docs/diagrams/` (Mermaid source, rendered to PNG for the README)

`architecture.mmd`, `state-machine.mmd`, `sequence-happy-path.mmd`, `sequence-credit-fails.mmd`, `sequence-crash-recovery.mmd`.

### Architecture decision records (`docs/decisions/`)

One page each: context, decision, consequences, alternatives considered. Write them as the matching code lands.

| ADR | Decision |
| --- | --- |
| 001 | Orchestrated saga instead of two-phase commit |
| 002 | `Resolve` with tombstones to settle unknown outcomes |
| 003 | Derived ledger balances, no hot balance row |
| 004 | `READ COMMITTED` for writes, `REPEATABLE READ` for aggregates |
| 005 | Idempotency stored on the transfer row, in three layers |
| 006 | The rate limiter fails open |
| 007 | Database per service; one shared Postgres only for the mock banks |
| 008 | Recovery by lease and `SKIP LOCKED` polling, not a message queue, in phase 1 |

## Milestones and acceptance criteria

Build in this order, one milestone per Claude Code session. A milestone is done only when every acceptance item passes. Most of the work is in M3, M5 and M6.

| Milestone | Read first | Scope | Acceptance |
| --- | --- | --- | --- |
| **M0 Scaffold** | 2, 3, 9, 15, 17 | npm workspaces, tsconfig, eslint, prettier, buf config, the three `.proto` files, `@switch/common` (config, logger, httpServer, db, migrate, hash, time, grpc helpers), Dockerfile, Compose with three Postgres containers and Redis, CI `static` job | `npm run build`, `npm run lint` and `npm test` pass; unit tests exist for `canonicalJson`, `backoffMs` and `classify`; the four infrastructure containers become healthy |
| **M1 Ledger** | 7, 10, 14 | Migrations, all five RPCs, validation, metrics, health | Tests pass for: balanced journal posts; unbalanced rejected in app code **and** by the database trigger (raw SQL insert fails); duplicate key replays; same key with a different body returns `ALREADY_EXISTS`; 100 concurrent same-key calls create one journal; `UPDATE` and `DELETE` on entries fail |
| **M2 Mock Bank** | 8, 10, 14 | Migrations, every RPC, chaos engine, metrics, health | Tests pass for: debit, credit and reverse idempotency; insufficient funds leaves no operation row; 50 concurrent debits against funds for 10 produce exactly 10 successes; `Resolve` tombstone beats a later debit and a committed debit beats `Resolve`; each chaos mode behaves as specified and is deterministic for a given seed |
| **M3 Orchestrator core** | 6, 11, 13, 14 | Migrations, repos, `transition()` with CAS and events, saga success path, definite-failure paths, bank and ledger clients, `CreateTransfer` and `GetTransfer`. No recovery worker yet | Unit tests of transitions and the saga using fakes; integration tests through gRPC for `SUCCESS`, `FAILED` (insufficient funds) and `REVERSED` (missing payee) including the `transfer_events` trail |
| **M4 Gateway** | 5, 14 | All endpoints, JWT auth, validation, error mapping, Redis rate limiter, readiness | `happyPath` and `validation` integration tests pass; rate limiting returns 429 with `Retry-After`; Redis outage fails open |
| **M5 Idempotency and unknown outcomes** | 6, 12 | Replay and conflict handling, concurrent duplicates, inline retries, `yield` | `idempotency` integration tests pass; `lost_response_rate = 1` ends in `SUCCESS` with one debit |
| **M6 Recovery** | 6, 13 | Recovery worker, leases, claim query, `Resolve` path, backoff, manual review | `failurePaths` integration tests pass, including bank down then up, Ledger stopped then started, late apply, and an Orchestrator kill mid-transfer |
| **M7 Chaos and invariants** | 16 | `tests/helpers/invariants.ts`, `crashRecovery` and `invariant` tests, `scripts/checkInvariants.ts` | The 10,000-transfer invariant test passes twice in a row with different test seeds, and `npm run invariants` is green afterwards |
| **M8 Load and metrics** | 16, 17 | k6 script, `seed --load`, complete metrics | `docs/benchmarks.md` holds real measured numbers and the invariants held during the run |
| **M9 Polish** | 17, 20 | README, diagrams, ADRs, full CI including nightly | Every box in section 20 is ticked |

### Prompt template for each milestone

```text
Read ARCHITECTURE.md fully, then implement ONLY milestone M<n> (<name>).
Follow sections <numbers from the table> exactly: same file paths, schemas, proto files, error codes and env vars.
Do not start other milestones. Do not add anything the document does not list.
When done: run the acceptance commands and paste their output, list every place you had to deviate from the document (there should be none), and add 5 lines to the README under "What I built and why".
```

After each milestone, read the five README lines and make sure you can explain them out loud. That is what makes the project safe to put on a resume.

## Phase 2 extensions

Start these only after the phase 1 definition of done (section 20) is met. Each is independent. They are listed in order of resume value.

1. **Transactional outbox and Kafka.** Orchestrator migration `0002_outbox.sql` adds `outbox(id bigint identity primary key, aggregate_id uuid, event_type text, payload jsonb, created_at timestamptz, published_at timestamptz null)`. Terminal transitions insert an event in the same transaction (`transfer.succeeded`, `transfer.failed`, `transfer.reversed`). A relay loop selects `WHERE published_at IS NULL ORDER BY id LIMIT 100 FOR UPDATE SKIP LOCKED`, publishes to topic `transfer-events` keyed by transfer id (`kafkajs`, idempotent producer, `acks=all`), then sets `published_at`. Delivery is at-least-once; consumers deduplicate by event id. Add a single-node KRaft Kafka to Compose.
2. **Notification service** (`services/notification`). Kafka consumer group `notification`, a dedupe table keyed by event id, a simulated webhook call with exponential-backoff retries, and a dead-letter topic `transfer-events.dlq` after 5 failed attempts.
3. **Reconciliation service** (`services/reconciliation`). Add the bank RPC `GetStatement(from, to)`. A scheduled job (default every 5 minutes) compares each bank's statement with ledger journals by reference id, classifies breaks as missing in ledger, missing at bank or amount mismatch, stores them in a `reconciliation_breaks` table and exposes a `GetReport` RPC.
4. **Tracing and dashboards.** OpenTelemetry (`@opentelemetry/sdk-node` with gRPC, HTTP and `pg` instrumentation) exporting OTLP to Jaeger in Compose. Prometheus and Grafana with committed dashboard JSON: throughput, latency, in-flight transfers, recovery activity, injected chaos.
5. **Ledger balance snapshots.** Periodic snapshot rows so `GetBalance` reads only entries after the latest snapshot.
6. **Kubernetes manifests** for `kind` or `minikube` (optional).

## Definition of done

Phase 1 is finished when every box below is ticked.

- [ ] `npm run stack:up` starts all services with no manual steps, and `npm run seed` creates demo accounts
- [ ] Every proto file, schema, env var, endpoint and error code matches this document
- [ ] Unit and integration tests pass locally and in CI
- [ ] The 10,000-transfer invariant test passes twice in a row with different test seeds; invariants I1 to I7 hold; zero transfers need manual review
- [ ] The crash recovery test passes
- [ ] k6 results are recorded in `docs/benchmarks.md` and the invariants still held during the load run
- [ ] README sections are complete, diagrams are rendered, and all eight ADRs are written
- [ ] Every milestone has its five "What I built and why" lines, and I can explain each one without looking

### Shortcuts that are not allowed

If Claude Code proposes any of these, reject it. Each one removes something an interviewer will ask about.

- Merging services, sharing a database between services, or replacing gRPC with HTTP between services
- Using an ORM, keeping state in memory, or mocking Postgres in integration tests
- Skipping the `*_SENT` write-ahead states, or calling a bank before the intent is committed
- Treating a timeout as a failure instead of an unknown outcome
- Removing `Resolve` and its tombstones, or replacing leases and compare-and-set with plain updates
- Storing a running balance in the ledger, or allowing the ledger to be updated or deleted
- Using floating-point numbers for money
- Lowering the transfer count, loosening an invariant, or skipping a test because it is hard
- Using `any` or `@ts-ignore`
- Inventing or rounding up a benchmark number
