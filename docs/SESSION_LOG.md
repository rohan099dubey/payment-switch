# SESSION LOG

Append-only narrative memory. Newest entry at the **bottom**. One entry per session.

This is the memory that `CONTEXT.md` (orientation) and `PROGRESS.md` (state)
deliberately do not carry: *why* a thing was done a certain way, and what bit you on
the way there. Gotchas are the highest-value content here — write down anything that
cost you more than ten minutes to figure out, because the next session cannot
reconstruct it.

## Entry template

```markdown
## YYYY-MM-DD — Session N — M<n> <name>

**Status at end:** <milestone + status>

**Done**
- ...

**Decisions**
- <decision> — <why>. (ADR-NNN if one was written.)

**Gotchas**
- <what surprised me, and the fix>

**Next action**
- <the single concrete next thing>

**Open questions**
- <anything unresolved>
```

---

## 2026-10-05 — Session 0 — Documentation & context scaffolding

**Status at end:** M0 `NOT_STARTED`. No implementation code exists yet, by design.

**Done**
- `git init` on `main` in `d:\WORK\DEV\PROJECTS\PaymentSwitch_DEL`.
- Renamed the build spec to `ARCHITECTURE.md` and added a 4-line "Amendments" header
  pointing at `docs/decisions/`. Content otherwise **verbatim** — the spec is never
  edited in place.
- Wrote `CLAUDE.md`: the spec's mandated rules plus a 6-step session protocol and the
  forbidden-shortcuts list. This is auto-loaded by Claude Code, so it is the mechanism
  that makes the whole context system fire.
- Wrote `docs/CONTEXT.md` (161 lines) — the cold-start primer.
- Wrote `docs/PROGRESS.md` — M0–M9 with every acceptance assertion as its own checkbox
  (~190 boxes) plus the phase-1 definition of done.
- Wrote ADR-001 to ADR-008 (stubs pre-filled from the spec's own reasoning), ADR-009
  (Node 22 / Fastify 5, decided) and ADR-010 (inline saga budget, open).
- Authored all five Mermaid diagrams, `docs/benchmarks.md` stub, `README.md` skeleton,
  `.gitignore`, `.nvmrc`.

**Decisions**
- **Node 22 LTS instead of Node 20; Fastify 5 instead of 4.** Node 20 reached EOL in
  April 2026, so the spec's "use exactly these choices" would ship an unpatched
  runtime. Zero code impact on a CommonJS/ES2022 target. → `ADR-009`
- **PostgreSQL stays at 16.** Supported until 2028; churning it buys nothing.
- **Repo docs are the durable truth; Claude's memory directory holds pointers only.**
  The memory dir is keyed to the working-directory path, so a session opened in a
  different directory would not load it. The repo docs therefore stand alone.
- **Authored the five Mermaid diagrams now rather than deferring to M9.** The spec's
  originals survive only as `[embedded content: ...]` placeholders — the actual
  diagrams are lost. Their content is fully recoverable from the spec's prose and
  tables, so recovering it while the spec was fresh in context was cheap.
- **Every acceptance criterion became an individual checkbox.** The spec states them as
  prose sentences bundling several assertions each (M1's single sentence contains six).
  Left as prose, "done" becomes a judgement call.

**Gotchas**
- The memory directory for this session is keyed to `d--WORK-DEV-PROJECTS-xyz`, but the
  working directory switched to `PaymentSwitch_DEL` partway through. A future session
  opened directly in `PaymentSwitch_DEL` gets a *different* memory directory and will
  **not** see those memory files. Do not rely on Claude memory for project state — that
  is exactly why `CONTEXT.md` and `PROGRESS.md` live in git.
- The dev machine has Node **v24.18.0**, not 22. Fine for an ES2022/CommonJS target, but
  Docker and CI pin `node:22-alpine`, so local test runs and CI runs are on different
  majors. If a test ever passes locally and fails in CI, check that first.
- Bash heredocs in this harness silently truncate past roughly 80–100 lines, producing a
  confusing `unexpected EOF while looking for matching quote` error. Write long files in
  chunks with `>>`.

**Next action**
- **M0 Scaffold.** Read `ARCHITECTURE.md` sections 2, 3, 9, 15, 17 (not the whole file),
  then work the M0 checklist in `docs/PROGRESS.md` top to bottom.

**Open questions**
- `ADR-010` — the inline saga budget does not close (8000 ms budget vs. a 12000 ms
  worst-case debit step), so `202` will be the common response under chaos. Decide
  during M3 whether to raise the budget, cut the inline retry counts, or accept `202`
  as normal and write the integration tests accordingly.

---

## 2026-10-05 — Session 1 — M0 Scaffold

**Status at end:** M0 `DONE`, 35 of 35 boxes ticked. Docker Desktop was not running at
the start; it was launched mid-session, and then the last box was verified.

**Done**
- Root: `package.json` (workspaces, all §15 scripts, `engines >=22`), `tsconfig.base.json`,
  solution `tsconfig.json`, `buf.yaml`, `buf.gen.yaml`, `eslint.config.mjs`
  (`strictTypeChecked`), `.prettierrc.json`, `.prettierignore`, `vitest.config.mts`,
  `Dockerfile`, `.dockerignore`, `docker-compose.yml` (4 infra containers), `.env.example`,
  `scripts/initBankDbs.sql`, `.github/workflows/ci.yml` (`static`).
- `proto/` — three files, verbatim from §9.
- `@switch/proto-gen` — subpath exports `@switch/proto-gen/{bank,ledger,orchestrator}/v1`
  via `exports` (runtime) + `typesVersions` (TS `node10` resolution).
- `@switch/common` — every file in the §2 table. 94 unit tests across 7 files.
- ADR-011, ADR-012, ADR-013 (all deviations, all listed in `CONTEXT.md`).

**Verification (clean slate: generated code, dist and tsbuildinfo deleted first)**
```text
npm run proto:lint   -> exit 0
npm run build        -> exit 0 (buf generate + tsc -b)
npm run lint         -> eslint clean; "All matched files use Prettier code style!"
npm run typecheck    -> exit 0
npm test             -> Test Files 7 passed (7) / Tests 94 passed (94)
docker compose config --quiet -> exit 0 (services: postgres-banks, postgres-ledger,
                                 postgres-orchestrator, redis)
npm run stack:up     -> exit 0; postgres-ledger, postgres-orchestrator, postgres-banks,
                        redis all "Healthy" (Docker 29.6.1)
psql on postgres-banks -> bank_a, bank_b present
host ports           -> orchestrator_db:5433, ledger_db:5434, bank_a/bank_b:5435 all
                        connect (postgres 16.15); redis-cli ping -> PONG
```

**Real-Postgres smoke of `db.ts` + `migrate.ts`** (scratch DB `m0_smoke`, dropped after;
script was a throwaway, not committed). All passed:
- Two concurrent `runMigrations` calls: the advisory lock serialised them, and each
  file was applied exactly once (`a` got both files, `b` got none).
- A re-run applies nothing.
- A failing migration (`SELECT 1/0` after DDL) rolls back fully and is not recorded.
- Editing an applied migration is refused (checksum mismatch).
- No advisory lock is left held after a failure.
- `withTransaction` commits; rolls back on throw; `REPEATABLE READ` + `readOnly`
  honoured (a write fails with "read-only transaction").
- `int8` arrives as a string; `BigInt()` is exact past 2^53.

These should become real integration tests once `tests/` exists (M7 helpers). For now
M1's ledger integration tests exercise `migrate.ts` for real.

**Decisions**
- **buf lint exceptions** — the verbatim protos violate four STANDARD rules (package dir,
  three RPC request/response naming rules). Named exceptions, not a weaker category. → ADR-011
- **ts-proto via `node`** — `node_modules/.bin/...` cannot run on Windows (see gotchas). → ADR-012
- **vitest projects** — `--dir` cannot be repeated. → ADR-013
- **Unit layer stays I/O-free.** `migrate.ts`, `db.ts` and `httpServer.ts` need a real
  Postgres and socket, so they have no unit tests yet. They get exercised for real in M1
  integration tests. Do not mock `pg` to cover them (CLAUDE.md forbids it).
- **Stricter-than-spec choices in common:** `canonicalJson` writes `bigint` as a bare
  number, so `12500n` and `"12500"` hash differently, and it throws on NaN, Map, Set and
  cycles. `migrate.ts` stores a sha256 checksum per migration and refuses to start if an
  applied file was edited. `withRetry` has no default `shouldRetry`. `callUnary` rejects
  a non-positive or infinite timeout. The logger redacts secrets, tokens and `body`.
- **`classify` falls back to `UNKNOWN_OUTCOME` for anything unlisted.** That covers
  `OK`-as-error, `OUT_OF_RANGE`, and `ALREADY_EXISTS` from a bank. This follows "when in
  doubt" in §14. The full 17-code × 2-target table is pinned in `errors.test.ts`.
- **Tests compile under their own composite project** (`packages/common/test/tsconfig.json`,
  `emitDeclarationOnly` into `dist/.test`), so `tsc -b` type-checks tests too. Services
  should copy this pattern: `src/` project with `rootDir: src` (the Dockerfile needs
  `dist/main.js`), plus a `test/` project that references it.
- **`test/` mirrors `src/`.** `src/grpc/errors.ts` is tested by `test/grpc/errors.test.ts`.
  Services follow the same rule (`src/domain/saga.ts` gets `test/domain/saga.test.ts`).
- **Every package sets `tsBuildInfoFile: "dist/tsconfig.tsbuildinfo"`.** That way
  deleting `dist/` is a complete clean. Services must copy this.
- **Prettier ignores `*.md` / `*.mmd`.** It would rewrap every docs table, and
  `ARCHITECTURE.md` must never be edited.
- **CI runs `proto:gen` before `lint`.** Type-aware lint needs generated code once
  services import it. `buf breaking` is skipped when `main` has no `proto/` yet.

**Gotchas**
- **npm 11.16 `allow-scripts`**: installs warn that postinstall scripts for
  `@bufbuild/buf`, `esbuild` and `protobufjs` were not run. They still work, because the
  binaries come from platform optional-deps. CI and Docker use Node 22's npm 10, which
  has no gate. If a binary ever goes missing locally, run
  `npm approve-scripts <pkg>`.
- **Windows + buf local plugins**: buf finds `protoc-gen-ts_proto.cmd`, but `cmd.exe`
  parses `node_modules/.bin/x` as `node_modules` plus a `/.bin` switch:
  `'node_modules' is not recognized`. Fixed by ADR-012.
- **vitest 5 + CommonJS root**: a `vitest.config.ts` warns that ESM syntax was loaded as
  CJS. Named `.mts` instead.
- **typescript-eslint 8.71** has no `allowBigInt` on `restrict-template-expressions`;
  `allowNumber` already covers bigint. `allowDefaultProject` files need
  `defaultProject: 'tsconfig.base.json'`, or strict-null rules error out.
- **zod 4**: `z.string().url()` is deprecated, so use `z.url()`. `strictTypeChecked`
  flags deprecated APIs as errors.
- **Stale tsbuildinfo**: with `rootDir: src`/`outDir: dist`, tsc writes
  `tsconfig.tsbuildinfo` next to `tsconfig.json`, outside `dist/`. Deleting only `dist/`
  then fails `tsc -b` with `TS6305 Output file ... has not been built from source`. Fixed
  by pinning `tsBuildInfoFile` inside `dist/`.
- **Postgres healthcheck**: `pg_isready` over the unix socket can report ready while
  init scripts are still running. Compose uses `-h 127.0.0.1` so `postgres-banks` is only
  healthy after `bank_a`/`bank_b` exist.

**Next action**
- **M1 Ledger**, in a fresh session. Read `ARCHITECTURE.md` §7, §10, §14 only. Create
  `services/ledger` following the package pattern above (`src/` + `test/` projects,
  `tsBuildInfoFile` in `dist/`), add it to the root `tsconfig.json` references, and add
  the `ledger` service to `docker-compose.yml`.

**Open questions**
- `ADR-010` is still open (resolve in M3).

---

## 2026-10-05 — Session 1 (continued) — M1 Ledger

**Status at end:** M1 `DONE`, all boxes ticked. Same session as M0: the owner asked to
continue here, which overrides the one-milestone-per-session note in `CLAUDE.md`.

**Done**
- `services/ledger`: `main.ts`, `config.ts`, `metrics.ts`, `grpc/{server,handlers}.ts`,
  `domain/{validate,journalHash}.ts`, `repo/{journalRepo,balanceRepo}.ts`, and
  migrations `0001` and `0002` (verbatim) plus `0003` (ADR-015).
- `ledger` service in `docker-compose.yml` (Dockerfile `SERVICE=ledger`, ports 50052 and
  9102, waits for `postgres-ledger` healthy, `wget /readyz` healthcheck).
- Unit tests: `services/ledger/test/domain/{validate,journalHash}.test.ts`.
- Integration tests: `tests/integration/ledger.test.ts`, 26 tests against the live
  container plus raw SQL on `ledger_db`. `tests/tsconfig.json` is a composite project
  in the root references, so tests are type-checked.
- Fixed M0's `migrate.ts` to match §10 (column `filename`, not `version`; the M0 session
  never read §10) and to apply all pending files in one transaction. → ADR-014

**Verification**
```text
docker compose build ledger   -> first real build of the Dockerfile: OK
npm run stack:up              -> 5/5 healthy (4 infra + ledger)
ledger first start            -> migrations applied: 0001_init.sql, 0002_seed_accounts.sql
ledger restart with 0003      -> migrations applied: 0003_forbid_truncate.sql only
                                 (0001/0002 checksums matched: Windows LF == container)
npm run test:integration      -> Tests 26 passed (26); re-run on a populated DB: 26 passed
docker compose stop ledger    -> "ledger shutting down" / "ledger stopped", exit code 0
```

**Mutation check (the tests can actually fail).** A copy of the Ledger with two planted
bugs ran on ports 50152/9202 against the same DB, with the suite pointed at it through
`LEDGER_GRPC_ADDR` and `LEDGER_HTTP_URL`:
1. Validation skips debits = credits. Result: "rejects an unbalanced journal in
   application code" failed. The DB trigger still rejected the journal
   (`unbalanced: debits 100 credits 99`), so nothing was committed.
2. Hash mismatch ignored on a key conflict. Result: "returns ALREADY_EXISTS /
   IDEMPOTENCY_KEY_REUSED" failed.

Exactly 2 failed, 24 passed. Then I restored the files (hash-identical to the backups)
and rebuilt.

**Decisions**
- **Repo returns outcomes, handlers throw gRPC errors.** `postJournal` returns
  `created | replayed | key_reused | unknown_accounts`. An unknown account throws a
  private error *inside* the transaction purely to roll it back, and is converted to an
  outcome outside it. `repo/` never imports gRPC.
- **Domain validation returns `{ok, reason}`, never throws**, so it has no transport
  dependency and unit tests need no gRPC.
- **No invented error codes.** `GetJournal` with a malformed id returns `NOT_FOUND` /
  `JOURNAL_NOT_FOUND` (no journal can have that id). `ListJournals` with an empty
  reference returns `[]`. `GetBalance` with an empty code returns `ACCOUNT_NOT_FOUND`.
- **Idempotency key length is counted in code points** (`Array.from(key).length`), and
  is unit-tested with emoji.
- **Balances are computed in SQL**, one statement for both `GetBalance` and
  `GetTrialBalance`, `CASE` on account type, `SUM` cast `::text` and converted with BigInt.
- **Health server listens dual-stack** (no host given), because `wget localhost` inside
  Alpine may resolve to `::1` first.
- **Integration project runs files serially** (`fileParallelism: false`, 30 s
  timeouts): every integration file shares one stack and asserts balance *deltas*.
- **Test isolation without resets:** every key and reference is `m1-<run uuid>-<uuid>`,
  so tests re-run on a populated DB and never need `down -v`.
- **Root devDependencies now include `pg` and `@grpc/grpc-js`**, because `tests/` is not
  a workspace and must not rely on hoisting.

**Gotchas**
- **`TRUNCATE` bypasses row-level triggers.** The spec's append-only triggers did not stop
  `TRUNCATE entries`. → ADR-015. The test runs inside `BEGIN … ROLLBACK`, so a missing
  trigger fails the test without wiping the ledger.
- **ts-proto enum decoding:** binary `decode` stores an unknown enum value as the raw
  number (e.g. `7`). Only `fromJSON` maps to `UNRECOGNIZED` (-1). Validation must reject
  any value that is not exactly `DEBIT` or `CREDIT`, and the unit test decodes real bytes
  `[0x10, 0x07]`.
- **`npm install -w <new workspace> <deps>`** on a workspace that is not yet linked
  installs the link but does **not** save the deps to its `package.json`. Run it twice,
  and check the file afterwards.
- **PowerShell `Set-Content -NoNewline` is unavailable in this harness.** Use
  `[IO.File]::WriteAllText`.
- **`SUM(bigint)` is `numeric`** in Postgres. Cast it `::text`, then BigInt.
- **For M3: a ledger DB-trigger rejection surfaces as gRPC `INTERNAL`**, because
  `instrument` maps unexpected errors to INTERNAL. `classify(…, 'ledger')` treats INTERNAL
  as `UNKNOWN_OUTCOME`, so the Orchestrator would *retry* a journal the database will
  never accept, then exhaust recovery into `NEEDS_MANUAL_REVIEW`. It only happens if app
  validation has a bug, and the outcome (manual review) is safe. But M3 should decide
  whether the Ledger maps Postgres `P0001` from its own triggers to
  `FAILED_PRECONDITION` (classified `BUG`, so manual review immediately). That needs an
  ADR, because the spec does not list the mapping.

**Next action**
- **M2 Mock Bank.** Read `ARCHITECTURE.md` §8, §10, §14. Mirror `services/ledger`
  exactly: package and tsconfig pattern, root references, a Compose service per instance
  (`bank-a`, `bank-b`, same image, `SERVICE=mockBank`), and
  `tests/integration/mockBank.test.ts` with run-unique ids.

**Open questions**
- `ADR-010` (inline saga budget), still open for M3.
- Ledger trigger error → gRPC status mapping (see gotchas), for M3.

---

## 2026-10-05 — Session 1 (continued) — M2 Mock Bank

**Status at end:** M2 `DONE`, all boxes ticked. Same session again, at the owner's request.

**Done**
- `services/mockBank` (`@switch/mock-bank`): `main.ts`, `config.ts`, `metrics.ts`,
  `grpc/{server,handlers}.ts`, `chaos/{chaos,prng}.ts`,
  `repo/{accountsRepo,operationsRepo}.ts`, and `migrations/0001_init.sql` (verbatim).
- `bank-a` and `bank-b` in Compose: the same Dockerfile (`SERVICE=mockBank`), chaos env
  shared through a YAML anchor, and one database each on `postgres-banks`.
- Unit tests: `test/chaos/{prng,chaos}.test.ts`, `test/config.test.ts`.
- Integration tests: `tests/integration/mockBank.test.ts`, 33 tests.
- ADR-016 covers what §8 leaves open.

**Verification**
```text
npm test                     -> Tests 142 passed (unit, all packages)
npm run stack:up             -> 7/7 healthy (4 infra + ledger + bank-a + bank-b)
bank-a / bank-b first start  -> each: migrations applied 0001_init.sql (own DB)
mockBank integration         -> Tests 33 passed (33), ~9.7 s (late/lost tests wait out slow_ms)
docker compose stop bank-a   -> "mock bank shutting down" / "stopped", exit code 0
```

**The race test was one-sided at first, and measuring caught it.** The first version
fired Debit and Resolve together on one gRPC channel. A probe script showed **Debit
won 200 of 200**: HTTP/2 on one connection delivers in send order. So the "tombstone
wins" branch was never exercised, and the test proved nothing beyond "committed Debit
beats Resolve". The fix uses a second channel and alternates the send order. Measured
split: debit-first 96/4, resolve-first 22/78, 0 inconsistent of 200. The test now
**asserts both branches occurred**. That assertion then failed once more for a second
reason: a *cold* second channel pays connection setup, so its calls always arrive late.
Warming it with one call fixed it, and it passed 5 of 5 runs.

**Mutation check.** A mutant bank ran on ports 50161/9211 against `bank_a`, with the suite
pointed at it through `BANK_A_GRPC_ADDR` / `BANK_A_HTTP_URL`:
1. `balance >= $2` removed from the Debit UPDATE → "insufficient funds" and "50
   concurrent debits" failed.
2. The Debit conflict branch ignores `VOIDED` → "tombstone beats Debit", "…beats
   Credit" and **the race test** failed. The one-sided race test could not have caught this.
3. `ChaosEngine.replace` stops reseeding → the same-seed determinism test failed.

Total: 6 failed, 27 passed. The files were restored hash-identical.

**Decisions** (details in ADR-016)
- Four added error codes: `INVALID_REQUEST`, `ACCOUNT_ALREADY_EXISTS`,
  `CHAOS_CONFIG_INVALID`, `BANK_UNAVAILABLE`.
- On a replay, `balance_after` is the balance at replay time; the schema does not
  store the original.
- Credit can return `CURRENCY_MISMATCH` (§14's failure table wins over §8's "only").
- `SetChaosConfig` enforces `slow_ms > BANK_CALL_TIMEOUT_MS` only when late or lost
  modes are on.
- Two PRNG streams (mode, latency); `down` draws nothing; `replace` reseeds.
- **BANK_ID, ports and DATABASE_URL are required** (no defaults), because the spec's
  values are per instance.
- **The repo returns outcomes, handlers throw.** Business rejections throw a private
  `Rejection` *inside* the transaction purely to roll back the operation row ("business
  rejections are not recorded"), and are converted to an outcome outside.
- **Registry default label `bank_id`**, so both instances' metrics are distinguishable
  once scraped together.

**Gotchas**
- **One gRPC channel serialises "concurrent" calls in send order.** To create real
  races at the database, use separate channels **and warm them first**. M5's
  concurrency tests (50 identical transfer requests) must remember this.
- **Float threshold sums:** `0.1 + 0.2 = 0.30000000000000004`, so a draw of exactly
  0.3 falls in late_apply, not lost_response. That is harmless, but tests must probe
  just off boundaries, and rate-sum validation needs an epsilon.
- **Chaos config is in memory per instance** (by design). Every integration test resets
  it in `afterEach` to the config read at startup, so a failing chaos test cannot leak
  `down: true` into the next one.
- **Integration suite timing:** the late-apply and lost-response tests each wait out
  `slow_ms` (2.1 s). Keep the number of such tests small.

**Next action**
- **M3 Orchestrator core.** Read §6, §11, §13, §14. **First decide the two open
  questions** in `PROGRESS.md` (ADR-010 budget; ledger trigger → gRPC status), because
  M3's integration tests depend on both. Then the `services/ledger` and
  `services/mockBank` layout again.

**Open questions**
- `ADR-010` (inline saga budget): M3.
- Ledger trigger error mapping: M3.

---

## 2026-10-06 — Session 2 — M3 Orchestrator core

**Status at end:** M3 `DONE`, all boxes ticked. Both open questions resolved.

**Done**
- Resolved the two open questions *before* writing M3 code (owner stated no preference,
  so the stricter option both times):
  - **ADR-010:** keep every spec number and accept `202` as normal, but make the inline
    budget a **hard bound**. Section 6 checks the deadline only at the top of the loop,
    so a step starting at 7.9 s could run for 12 s more and answer after the Gateway's
    10 s deadline. Now every attempt's deadline is `min(per-call timeout, budget left)`,
    no attempt starts with less than 100 ms left, and retry sleeps are capped at the
    deadline. M5's `lost_response_rate = 1` box is explicitly deferred to the M6 session.
  - **ADR-017:** the Ledger maps its own `P0001` (trigger `RAISE`) and `23514` (CHECK)
    to `FAILED_PRECONDITION` / `LEDGER_INVARIANT_VIOLATION`, which `classify` already
    reads as `BUG`. Everything else stays `INTERNAL`, so it is still retried.
- `services/orchestrator` (`@switch/orchestrator`): `config`, `metrics`, `main`,
  `grpc/{server,handlers}`, `domain/{states,transitions,saga,policy,failureCodes,validate,transfer}`,
  `repo/{transfersRepo,eventsRepo}`, `clients/{bankClients,ledgerClient}`, and migration
  `0001_init.sql` (diffed against §10: verbatim). Compose service `orchestrator` (waits for
  its Postgres, the Ledger and both banks to be healthy).
- ADR-018 records the details the spec leaves open (CAS also matches `state`, unrecognised
  bank errors are bugs, event reason vocabulary, yield semantics, extra startup checks).
- Unit tests: 239 in `services/orchestrator/test` (transition map with all 100 pairs,
  `transition()`, saga with in-memory fakes, validation and hash, journal templates, config)
  plus 10 in `services/ledger/test/repo/journalRepo.test.ts`.
- Integration tests: `tests/integration/orchestrator.test.ts` (25, through gRPC with the real
  banks and Ledger) and `orchestratorRepo.test.ts` (16, the repo SQL against real Postgres).
  Also `tests/helpers/transfers.ts` (`awaitTerminal`, the ADR-010 polling helper).

**Verification**
```text
npm run lint          -> eslint clean; "All matched files use Prettier code style!"
npm run typecheck     -> tsc -b, exit 0
npm test              -> Test Files 20 passed (20) / Tests 391 passed (391)
npm run stack:up      -> 8/8 healthy (4 infra + ledger + bank-a + bank-b + orchestrator)
orchestrator start    -> "migrations applied" ["0001_init.sql"], "orchestrator started"
npm run test:integration -> Test Files 4 passed (4) / Tests 100 passed (100), ~13 s
docker compose stop orchestrator -> "orchestrator shutting down" / "orchestrator stopped", exit=0
```

**Mutation check.** Every mutant was caught, and each one was isolated so that one could
not mask another.
- Built `dist/` copied to a scratch dir, run on 50151/9201 against the real DB, banks and
  Ledger. The suite was pointed at it through `ORCHESTRATOR_GRPC_ADDR` / `ORCHESTRATOR_HTTP_URL`:
  (A) CAS writes no event, (C) `SAME_ACCOUNT` check dropped, (D) `GetTransfer` not scoped
  to the client, (E) debit-leg credits `payable` instead of `transit`. Result: 7 failed,
  18 passed. **(B) "reversal journal never posted" was masked by E in that run**, because
  the REVERSED test failed on E's delta first. Re-run alone, B failed exactly that test.
- Source mutants with the unit/repo suites. U1 "unknown outcome treated as definite
  failure" (the forbidden timeout-is-failure bug), run alone: 5 failed. U2 "deadline not
  clipped to the budget", alone: 2 failed. CAS on `id + version` only: 4 repo tests
  failed. `SUCCESS -> FAILED` allowed: 5 failed. All files restored, hash-verified.
- ADR-017 end to end: a Ledger copy with the balance check removed from `validate.ts`
  (50152/9202). An unbalanced journal returned status 9 (`FAILED_PRECONDITION`) /
  `LEDGER_INVARIANT_VIOLATION` / "SQLSTATE P0001 … unbalanced: debits 100 credits 99", and
  0 journals were committed. The ledger suite against it: exactly 1 failed ("rejects in
  application code").

**Decisions**
- **`advance` implements the whole section 6 loop now, including inline retries and
  `yield`.** The alternative was a deliberately degraded M3 saga with no unknown-outcome
  handling, which would have to be rewritten in M5, and a saga that cannot represent
  "unknown" is the bug the design exists to prevent. The M5 boxes ("inline retries",
  "yield()") stay **unticked**: the code exists, but M5's acceptance tests must observe it.
- **Ports, not clients, in the domain.** `SagaEngine` depends on `BankPort`,
  `LedgerPort`, `SagaStore`, `Clock` and `SagaObserver` interfaces. `clients/` and
  `repo/` implement them. The unit tests use fakes that apply the **same CAS guard as the
  SQL**, so the saga is tested against the real contract, not a looser one.
- **Hang scripts advance a fake clock.** A fake call that "hangs" advances time by the
  call's own timeout and then throws `DEADLINE_EXCEEDED`. The budget arithmetic is
  therefore exercised for real, with no wall-clock sleeps (239 tests in about 1 s).
- **Repo-level SQL tests import `services/orchestrator/src`.** `tests/tsconfig.json` now
  references the orchestrator project. `claimDue` is tested inside `BEGIN … ROLLBACK` with
  `next_attempt_at = '-infinity'`, so it never leases another run's rows, and our rows
  always sort first.
- **Business failures carry evidence.** Event `detail` holds `error_code`, `bank_id`,
  `bank_txn_id` and `journal_id`, and the integration tests assert on them.

**Gotchas**
- **`transfer_id` appeared twice in log lines.** pino does not dedupe child bindings: the
  handler bound it, and `transition()` logged it again. Fix: the saga gets the unbound
  request logger and adds `transfer_id` itself. Watch for this in M6, where the recovery
  worker builds its own loggers.
- **Combined mutants mask each other.** The first mutation run put five bugs in one copy.
  The REVERSED test failed on the ledger-delta assertion (mutant E) before reaching the
  journal assertion that catches B. Run mutants one at a time, or at least check that
  every mutant has a *distinct* failing assertion.
- **Bash heredocs truncate again** (as Session 0 warned). A three-file heredoc silently
  cut the third file to 2 lines. Use the Write tool for anything longer than ~80 lines,
  and check `wc -l` after generated files.
- **A background `node dist/main.js` stopped with `Stop-Process` reports exit 127.** That
  is expected, not a crash.
- `cd` inside a Bash call changes the session's working directory for later calls. Use
  absolute paths or a subshell.

**Next action**
- **M4 Gateway.** Read `ARCHITECTURE.md` §5 and §14. Mirror the service layout. A
  `CreateTransfer` response with a non-terminal transfer maps to `202` + `Location`
  (ADR-010). Its `happyPath` tests should use the same `awaitTerminal` polling discipline.

**Open questions**
- None.
