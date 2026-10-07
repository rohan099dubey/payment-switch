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

---

## 2026-10-06 — Session 2 (continued) — M4 Gateway

**Status at end:** M4 `DONE`, all 16 boxes ticked. Same session as M3. The owner said
"continue" after M3, which (as in Session 1) overrides the one-milestone-per-session note.

**Done**
- `services/gateway` (`@switch/gateway`) in the §3 layout: `app.ts` (`buildApp(deps)`,
  every dependency injected), `config`, `metrics`, `mappers`,
  `plugins/{requestId,auth,rateLimit,errorHandler}`, `routes/{auth,transfers,health}`,
  `clients/orchestratorClient`, `lua/tokenBucket.lua`, `main`. Compose service `gateway`
  (waits for Redis and a healthy Orchestrator) with development `JWT_SECRET` / `API_CLIENTS`.
- ADR-019: `@fastify/jwt` 10.2.2 instead of 9 (critical `fast-jwt` advisories), plus the
  details §5 leaves open.
- Unit tests: 147 in `services/gateway/test`, in-process via `app.inject` with a fake
  Orchestrator, a fake limiter and a log sink.
- Integration tests: `happyPath` (9), `validation` (16), `gateway` (8: the Lua script in
  real Redis, 429s, Redis outage fails open, `/readyz` with Redis or the Orchestrator
  stopped, metrics, a scan of the Gateway's docker logs for secrets).
- Helpers: `tests/helpers/{gatewayClient,bankAdmin,stack}.ts` (partial M7 helpers).

**Verification**
```text
npm run lint          -> eslint clean; "All matched files use Prettier code style!"
npm run typecheck     -> exit 0
npm test              -> Test Files 26 passed (26) / Tests 538 passed (538)
npm run stack:up      -> 9/9 healthy (adds gateway)
npm run test:integration -> Test Files 7 passed (7) / Tests 133 passed (133), ~35 s
docker compose stop gateway -> "gateway shutting down" / "gateway stopped", exit=0
npm audit             -> found 0 vulnerabilities (after the @fastify/jwt 10 switch)
```

**Mutation check.** Every mutant was caught.
- Built copy on port 8180 (`GATEWAY_URL=http://localhost:8180`): a SUCCESS replay answers
  201, the Idempotency-Key minimum drops to 1 character, GET is not rate limited. The
  three failures were exactly the replay test (201 vs 200), the short-key test (422 vs
  400) and the 429 test (0 rejections). Each mutant had a distinct assertion.
- Source mutants, one at a time, against the unit suite: fail closed instead of open (1
  failed), the secret is ignored for a known client (2), `sub` is not checked against
  `API_CLIENTS` (1), `UNAVAILABLE` maps to 500 (3), the `Authorization` header is logged
  (1). Sources were restored and the hashes checked.

**Decisions**
- **`@fastify/jwt` 10.2.2** (ADR-019 §1). `npm audit` flagged v9's `fast-jwt` with 2
  critical advisories, including an auth bypass. v10 still targets Fastify 5.
- **`buildApp(deps)` with ports**, mirroring the Orchestrator's saga. The whole HTTP
  surface (auth, mapping, rate-limit hook, request ids, log content) is unit-tested with
  no sockets; the integration tests then prove the real wiring.
- **The rate limiter depends on a two-method `ScriptRunner` interface**, not on ioredis's
  `Redis`. The fake in unit tests needs no cast, and ioredis satisfies it structurally.
- **The `/readyz` and outage tests really stop containers** (`docker compose stop redis`
  / `orchestrator`) and restore them in `finally` plus `afterAll`. Integration files run
  one at a time, so no other file sees the outage.

**Gotchas**
- **`@fastify/jwt` reads a numeric `expiresIn` as seconds.** The first draft passed
  `ttl * 1000`, which made tokens valid for 10 days. The unit test asserting
  `exp = iat + 900` caught it.
- **Fastify 5.12 deprecates `disableRequestLogging` and `requestIdLogLabel`** (FSTDEP023).
  Use `logController: new LogController({...})`.
- **ioredis defaults queue commands while disconnected**, so a Redis outage would hang
  requests instead of failing open. It needs `enableOfflineQueue: false` and
  `commandTimeout`.
- **A stopped Compose container's DNS name stops resolving**, so gRPC calls to it wait
  out their deadline (504) rather than failing fast (503). The test accepts either,
  each with its correct mapping.
- **A mutant run can poison a fixed test key.** The G4 mutant accepted the key `short` and
  registered a real transfer (client `test-client-a`, key `short`, FAILED), which would
  have made the "nothing registered" assertion fail forever. That key is now unique per
  run. Never use fixed keys in assertions that a buggy run could falsify.
- **Docker Desktop stopped between M3 and M4** (overnight). The first M4 integration run
  failed on connections, not assertions. I relaunched it via
  `Start-Process "C:\Program Files\Docker\Docker\Docker Desktop.exe"`.
- The 202 test (payer bank `down`) leaves its transfer in `DEBIT_SENT` with nothing
  debited. M6's recovery worker will retry the debit (bank up by then) and finish it.
  Until M6, each integration run adds one such row.

**Next action**
- **M5 Idempotency & unknown outcomes.** Read §6 and §12. Most of the mechanism already
  exists from M3, so M5 is mainly its acceptance tests through the Gateway. Use separate,
  warmed connections for the 50 concurrent identical requests. Leave the
  `lost_response_rate = 1` box for M6 (ADR-010).

**Open questions**
- None.

---

## 2026-10-06 — Session 2 (continued) — M5 Idempotency & unknown outcomes

**Status at end:** M5 `DONE`, all 9 boxes ticked. One box (`lost_response_rate = 1`) was
**moved to M6**, not left open (below). Same session, after the owner's "continue".

**Done**
- No production code changed. M3 had already built every M5 mechanism (§6 pseudocode).
  M5 proves them against the real stack in `tests/integration/idempotency.test.ts` (14
  tests):
  - fingerprint: a different amount, note or payee with the same key gets 409 and
    leaves the transfer untouched; an absent note and `""` are the same fingerprint;
  - 50 concurrent identical requests over warmed, separate connections: one 201, 49
    replays with status 200, one row, one `APPLIED` debit row at the bank, exactly one
    `Debit ok` in the Orchestrator's own `downstream_calls_total`, and one linear event
    trail;
  - 10 concurrent requests with one key and different amounts: one 201, nine 409s;
  - a replay while in flight (bank latency chaos): it returns as soon as the original
    lands (200), or after `REPLAY_WAIT_MS` with 202 PENDING plus `Location`, and a later
    replay is 200 SUCCEEDED (rule 3's 202 → 200);
  - a replay never drives: a yielded transfer, replayed after the bank is back up, gets
    no event carrying the replay's request id;
  - inline retries: a seeded `reject_rate` gives one `unknown` and then one `ok` Debit;
    a definite failure makes exactly one Debit call; bank `down` makes exactly 3 Debit
    attempts, then a yield (`attempts` 1, `next_attempt_at - updated_at` within 2000–2400 ms,
    lease cleared).
- `tests/tsconfig.json` now references `services/mockBank` too. The test imports the
  bank's own `mulberry32` to choose a seed (reject, then pass) instead of copying the PRNG.

**Verification**
```text
idempotency.test.ts   -> Tests 14 passed (14), 4 runs in a row (timing-sensitive tests are stable)
npm run lint          -> clean; npm run typecheck -> exit 0
npm test              -> Test Files 26 passed (26) / Tests 538 passed (538)
npm run stack:up      -> 9/9 healthy
npm run test:integration -> Test Files 8 passed (8) / Tests 147 passed (147), ~41 s
```

**Mutation check** (`.mutant/run.sh`: each mutant gets its own Orchestrator on 50151
behind an unmodified local Gateway on 8180). Every mutant was caught:
M1 fingerprint never compared → 4 failed; M2 replay does not wait → 3; M3 replay
leases and drives → 1 (the request-id test); M4 no inline bank retries → 2; M5 yield
keeps the lease → 1; M6 no `ON CONFLICT` → 10.

**Decisions**
- **The `lost_response_rate = 1` box moved from M5 to M6** (ADR-010 amendment). It needs
  the recovery worker, and §16 lists it under `failurePaths`. Leaving it unticked in M5
  would have meant either a half-done milestone, which the merge policy forbids, or a
  premature tick. M6 also gained an added box: recovery must finish the `DEBIT_SENT`
  transfers the 202 tests leave behind.
- **"Never drives" is checked through `transfer_events.detail.request_id`**, not through
  the state. After M6, recovery may legitimately advance that transfer during the
  replay's wait, so a state assertion would become flaky. The request-id assertion stays
  true. M3's mutant (a replay that drives) proves the assertion can fail.

**Gotchas**
- **The whole Compose stack had exited (code 0) between M4 and M5**, after Docker
  restarted. The first M5 run failed with `ECONNREFUSED 127.0.0.1:50061` before any
  assertion. Run `npm run stack:up` first and check with `docker compose ps -a`.
- The mutation driver's output cuts test titles at "> ", so "(202 -> 200)" printed as
  "200)". That is cosmetic.

**Next action**
- **M6 Recovery.** Read §6 and §13. `claimDue`, `acquireLease`, `yieldTransfer` and
  `advance(…, {mode: 'recovery'})` already exist. Build `recovery/worker.ts`, the `Resolve`
  path, `MAX_RECOVERY_ATTEMPTS`, the `transfers_in_flight` gauge and `recovery_runs_total`,
  then the `failurePaths` tests, including the box moved from M5.

**Open questions**
- None.

---

## 2026-10-06 — Session 2 (continued) — M6 Recovery

**Status at end:** M6 `DONE`. All 12 implementation boxes and all 8 acceptance boxes are
ticked, including the one moved from M5 and the added "202 leftovers are finished" box.

**Done**
- `services/orchestrator/src/recovery/worker.ts`: `RecoveryWorker` (poll, claim, 5 lanes,
  in-flight gauge, stop with grace) and `recoveryAction` (pure: exhaust, resolve or advance).
- `SagaEngine.settle` (the `Resolve` branches) and `SagaEngine.exhaust`. `BankPort.resolve`
  in `clients/bankClients.ts`. Repo: `renewLease`, `countInFlight`, `createRecoveryStore`.
  Metrics: `recovery_runs_total{result}`, `transfers_in_flight{state}`. `main.ts` starts
  the worker and stops it on SIGTERM after the gRPC server.
- Event detail now records `driver` and `lease_owner` (ADR-020).
- Tests: `test/recovery/worker.test.ts` (39), `test/metrics.test.ts` (2), and
  `tests/integration/failurePaths.test.ts` (8): definite failures; a bank down 3 s → SUCCESS;
  the Ledger stopped with 3 transfers → pending (debit applied, no leg) → all SUCCESS after
  restart; `lost_response_rate = 1` → SUCCESS through `Resolve` APPLIED, one debit;
  `late_apply_rate = 1` with `slow_ms` 45 s → FAILED / `DEBIT_NOT_CONFIRMED`, all 9 late
  debits refused with `REFERENCE_VOIDED`, balance untouched; an Orchestrator killed with
  SIGKILL mid-transfer → a second instance (spawned on 50151) finishes it, with every
  recovery event dated after the dead lease's expiry; nothing older than 5 minutes left
  in flight.
- ADR-020.

**First run of the worker against the shared database:** it drained 148 leftovers in under
20 s. 117 synthetic rows from M3's repo tests (payer `A1`, which exists at no bank) went
to `FAILED` / `PAYER_ACCOUNT_NOT_FOUND`, moving no money. 31 transfers left `DEBIT_SENT` by
the M4/M5 202 tests went to SUCCESS. A cross-database check showed exactly 31
`DEBIT APPLIED` + 31 `CREDIT APPLIED` and 31 + 31 ledger legs.

**Verification**
```text
npm run lint          -> clean; npm run typecheck -> exit 0
npm test              -> Test Files 28 passed (28) / Tests 579 passed (579)
npm run stack:up      -> 9/9 healthy
npm run test:integration -> Test Files 9 passed (9) / Tests 155 passed (155), 204 s and 213 s
                         (two consecutive clean runs after the quiesce fix below)
failurePaths alone    -> Tests 8 passed (8), 175 s (first run)
docker compose stop orchestrator -> "shutting down" / "stopped", exit=0
non-terminal transfers afterwards -> 0
```

**Mutation check**, each mutant on its own against `test/recovery`. All were caught:
R1 `VOIDED` treated as `APPLIED` → 2 failed; R2 `REVERSING` settled by `Resolve` → 4;
R3 no exhaustion → 6; R4 drive although the lease lapsed → 1; R5 a voided credit is not
refunded → 1; R6 `Resolve` one attempt late → 9. Sources were restored and hash-checked.

**Decisions** (details in ADR-020)
- `Resolve` lives in the saga (`settle`), so it shares the CAS, logging, metrics and
  stale-lease handling. The worker only chooses the action.
- One lease token per claim (the §13 query takes one `$1`), plus `renewLease` immediately
  before each drive, because a late batch item can outlive its lease.
- Exhaustion is checked first, in every state including `REVERSING` (scenario 11).
- **Two earlier tests changed for live recovery.** M4's 202 test now waits for recovery to
  finish it (SUCCESS, exactly one debit) instead of asserting "no money moved". M5's
  "replay never drives" test accepts 200 as well as 202, because recovery may legitimately
  finish the transfer during the replay's wait; the request-id assertion is what proves it.
- **The repo-level tests park their synthetic rows** (`next_attempt_at = 'infinity'`)
  while they run, so a test that expires a lease cannot race the worker. They release the
  rows in `afterAll`, with payers that exist at no bank, so recovery fails them and moves
  nothing. The CAS race test no longer has a `NEEDS_MANUAL_REVIEW` contender.

**Gotchas**
- **Docker Desktop was down again** at the start of M6 (third time this session). Relaunch
  it with `Start-Process "C:\Program Files\Docker\Docker\Docker Desktop.exe"` and run
  `npm run stack:up`.
- **A historical synthetic `NEEDS_MANUAL_REVIEW` row exists** (client
  `m3repo-f543949b-client-32`, created 2026-10-05, `failure_code` NULL). It came from M3's
  old CAS race test. I left it alone: changing state outside the CAS would be worse. **M7's
  invariant I6 must be computed against the run's baseline**, which the spec already says,
  or it will count this row.
- TypeScript narrows `this.stopping` to `false` inside `while (!this.stopping)` and then
  calls a later `if (this.stopping)` "unnecessary" (lint), because it cannot see the
  mutation across `await`. Read the flag through a method.
- A stopped container's name stops resolving, so while the Ledger is down every ledger
  call waits out its full 2 s deadline. The three Ledger-outage transfers take about 6.5 s
  each to answer 202 (still inside the 10 s Gateway deadline).
- **Live recovery pollutes global counters.** A full run failed once with `Debit unknown`
  delta 6 instead of 3: while the test held `bank_a` down, the worker was also retrying an
  earlier test's pending transfer. Recovery's bank calls also consume chaos PRNG draws.
  Tests that measure a global counter or depend on the PRNG sequence now call `quiesce()`
  first (wait until no transfer is in flight). M7 must do the same around baselines.
- The late-apply test has to wait for the late requests themselves (about 71 s after
  creation), not just for the transfer's final state. Otherwise "never applied after
  voided" is only proven for the requests that arrived before the test ended.

**Next action**
- **M7 Chaos & invariants.** Read §16. Write `tests/helpers/invariants.ts`
  (`snapshotBaseline()`, then I1–I7 against it), `ledgerClient.ts`, `killService`, then
  `scripts/checkInvariants.ts` and the two `tests/chaos` files.

**Open questions**
- None.

---

## 2026-10-06 — Session 2 (continued) — M7 Chaos & invariants

**Status at end:** M7 `DONE`, all 12 boxes ticked.

**Done**
- Helpers: `tests/helpers/invariants.ts` (`snapshotBaseline`, `loadTransfers`,
  `collectEvidence` via `GetOperation` and `ListJournals`, `checkI1`–`checkI7`,
  `checkScoped`), `ledgerClient.ts` (`LedgerReader`), `chaosRun.ts` (quiesce, accounts,
  the section 16 retrying client, `awaitAllTerminal`, `evaluate`), `stack.ts`
  (`killService`, `waitReady`), `bankAdmin.ts` (`getOperation`, `clearChaos`).
- `tests/chaos/crashRecovery.test.ts` and `tests/chaos/invariant.test.ts` follow the
  section 16 steps. `scripts/checkInvariants.ts` (`npm run invariants [-- --since ISO]`)
  has its own composite tsconfig in the root references.
- `tests/helpers/invariants.test.ts`: 20 no-I/O unit tests of the checks. The unit project
  now also includes `tests/helpers/**/*.test.ts` (a small extension of ADR-013).
- `npm run test:chaos` passes `--silent=false`. vitest 5 hides console output from passing
  tests, and a project-level `silent: false` is ignored.
- ADR-021 records the interpretations.

**Results (measured, from the run logs)**
```text
crash recovery (200 transfers, SIGKILL after ~1 s, restart 3 s later), two runs:
  run 1: http {201: 30, 503: 170} -> 200 registered, 200 SUCCESS, 170 finished by recovery; I1-I6 PASS
  run 2: http {503: 200}          -> 200 registered, 200 SUCCESS, 200 finished by recovery; I1-I6 PASS
invariant test, 1,000 transfers (CI size): seeds 101 and 102 PASS I1-I7
invariant test, 10,000 transfers, chaos seed 42, three Orchestrator kills:
  TEST_SEED=1: 10,486 requests, 486 duplicate keys, 520 ghost payees, 0 unanswered
               final SUCCESS 9,467 / REVERSED 518 / FAILED 15 (INSUFFICIENT_FUNDS); 0 manual review
               chaos injected (bank_a+bank_b): reject 1,102, late_apply 491, lost_response 724
               recovery finished 295 transfers (888 events); p50 544 ms, p95 2,687 ms; 109 s total
               I1-I7 PASS
  TEST_SEED=2: 10,486 requests, 486 duplicate keys, 528 ghost payees, 0 unanswered
               final SUCCESS 9,397 / REVERSED 524 / FAILED 79; 0 manual review
               chaos injected: reject 1,098, late_apply 491, lost_response 720
               recovery finished 290 transfers (845 events); p50 505 ms, p95 2,649 ms; 104 s total
               I1-I7 PASS
npm run invariants -- --since 2026-10-06T13:30:00Z -> 24,597 transfers, I1-I6 PASS, exit 0
npm run lint / typecheck  -> clean / exit 0
npm test                  -> Test Files 29 passed (29) / Tests 599 passed (599)
npm run stack:up          -> 9/9 healthy
npm run test:integration  -> Test Files 9 passed (9) / Tests 155 passed (155), 213 s
```
Both seeds produced exactly 486 duplicate keys. I checked that this is a coincidence, not
a broken seed: recomputing the workloads offline gives different payers, payees and
amounts from the very first transfer, and different ghost counts (520 vs 528).

**The unscoped `npm run invariants` fails, and that is a real finding** (ADR-021). Its
first run reported I3 and I4 off by exactly −175,000 and 6 `REVERSED` transfers with no
reversal journal. I traced every row to the **M3 mutation run** (2026-10-05,
18:40:31–18:41:00), whose mutant Orchestrator ran against the shared databases. Mutant B
(no reversal journal) gives 6 × +12,500; mutant E (debit leg credits `payable`) gives
20 × −12,500. The sum is −175,000, exact to the paise. The one synthetic
`NEEDS_MANUAL_REVIEW` row (the M3 repo test) makes I6 fail as well. Nothing the real code
did is involved. The ledger is append-only, so the clean fix is a fresh stack
(`npm run stack:down && npm run stack:up`). That deletes every development database, so
**it is the owner's decision**; it is not done.

**Decisions** (details in ADR-021)
- Chaos tests: invariants against a baseline over the run's accounts, plus the run's
  transfers by idempotency-key prefix. They quiesce first, because live recovery would
  otherwise move money during the measurement.
- `npm run invariants`: I2–I4 evaluated per transfer from the evidence, because the
  databases also hold direct Ledger and bank test traffic. `--since` limits the scope.
- **A request still failing after its 10 × 500 ms retries is sent again later** with the
  same key, and the test still requires every request to end with an answer. A
  kill-and-restart takes about 5 s on Docker Desktop (2 s wait, then about 1.7 s for
  `docker compose start` alone). The Gateway reconnects in about 0.1 s once the
  Orchestrator is up, so no code is the bottleneck. One 1,000-transfer run without the
  resend failed on 11 unanswered requests; with it, every run so far needed no resend
  (`gaveUpAfterRetries: 0`), but the path exists for when Docker is slow.
- I5 is stricter than the table: amounts must match, and `FAILED` must have no credit or
  refund row at all, not merely none applied.

**Gotchas**
- **Mutation runs must never use the shared databases.** The M3 run left permanently
  inconsistent books (append-only, so they cannot be fixed in place). Future mutation
  checks need their own Postgres (for example a throwaway Compose project name).
- vitest 5: `console.log` from passing tests is hidden unless `--silent=false` is given
  on the CLI; the project-level option does nothing.
- An Orchestrator kill also resets its in-process counters, so recovery activity is
  counted from `transfer_events.detail.driver` instead.
- The I3 baseline differs between runs (1,199,198, then 1,264,636) because the integration
  suite's Ledger tests post `transit` journals directly. Baseline-relative checks are
  unaffected, which is why they are baseline-relative.

**Next action**
- **M8 Load & metrics.** Read §16 (load test) and §17. `scripts/seed.ts --load`, then
  `load/transfer.k6.js` (is k6 installed?). Record measured numbers only, in
  `docs/benchmarks.md`.

**Open questions**
- Should the development stack be reset (`npm run stack:down && npm run stack:up`) to
  clear the M3 mutation artifacts? It is the owner's call (it deletes data).

---

## 2026-10-06 — Session 2 (continued) — M8 Load & metrics

**Status at end:** M8 `DONE`, all 6 boxes ticked.

**Done**
- k6 v2.2.0 installed with `winget install k6` (the owner chose winget over the Docker
  image when asked). It lives at `C:\Program Files\k6\` and is on the machine PATH for new
  shells.
- `scripts/seed.ts`: `npm run seed` creates demo `ACC001`–`ACC005` per bank;
  `npm run seed -- --load` creates `L0001`–`L0200` per bank with 1,000,000,000 paise each.
  Idempotent: a second run created 0.
- `load/transfer.k6.js`: the §16 scenario, spread over the four dev API clients (ADR-022).
  `eslint.config.mjs` declares the k6 globals for `load/`.
- `tests/integration/metrics.test.ts`: 24 checks that each §17 metric is exposed by its
  service with the specified type and label set.
- `docs/benchmarks.md`: three measured rows and the bottleneck analysis. ADR-022.

**Results (measured; full detail in `docs/benchmarks.md`)**
```text
machine: Ryzen 7 7840HS (8C/16T), 15.2 GB, Windows 11, Docker Desktop 29.6.1 / WSL2; commit 9f985fa; chaos off
target 200/s (spec): 129.7/s achieved, 8,233 dropped, p50 3.05 s, p95 3.37 s, p99 3.51 s, errors 0.00 %
target 100/s:        99.97/s, p50 85.4 ms, p95 564.1 ms, p99 792.2 ms, errors 0.00 %
target  75/s:        74.99/s, p50 71.9 ms, p95 95.7 ms, p99 132.4 ms, errors 0.00 % (both thresholds met)
after each run: npm run invariants -- --since <start> -> all invariants hold (15,768 / 12,001 / 9,000 transfers, all SUCCESS)
npm run lint / typecheck -> clean / exit 0
npm test                 -> Test Files 29 passed (29) / Tests 599 passed (599)
npm run test:integration -> Test Files 10 passed (10) / Tests 179 passed (179), 208 s
```

**Bottleneck (measured, not guessed)**
- `docker stats` under the 200/s target: Orchestrator 102–106 % CPU (one core, Node's
  event loop); everything else has headroom.
- A diagnostic run with the Orchestrator at `LOG_LEVEL=warn` (temporary Compose
  override file in the scratchpad, reverted afterwards) gave the same 131/s, so logging is
  not the cause.
- A V8 CPU profile (`node -r <preload>` using `inspector`; `--cpu-prof` does not write on
  Windows when the process is killed) showed no single hotspot: socket writes ~14 %,
  grpc-js plus HTTP/2 ~14 %, pg ~6 %, pino ~5.5 %.

**Decisions** (ADR-022)
- The load is spread over four API clients, because one client's 100 rps bucket would
  make the run measure the limiter.
- I added runs at 100/s and 75/s to locate the knee, because the spec's single 200/s run
  saturated. All three rows are measured; nothing is extrapolated.
- No tuning was attempted. The fix the design supports (more Orchestrator instances
  behind round-robin gRPC LB) is out of M8's scope, so `benchmarks.md` claims no number
  for it.

**Gotchas**
- `Stop-Process` on Windows kills Node outright, so `--cpu-prof` never writes. Use an
  inspector preload that stops the profiler after a timer.
- In git-bash, a quoted-delimiter heredoc still mangled `'\'` in a JS file. Use the Write
  tool for scripts containing backslashes.
- The unscoped `npm run invariants` still reports the M3 mutation artifacts (ADR-021).
  The owner has not decided on a stack reset, so every check here is `--since`.

**Next action**
- **M9 Polish.** Read §17 and §20. README in §17 order (numbers only from
  `docs/benchmarks.md`), the rendered diagrams, the CI `integration` and `nightly` jobs,
  the eight spec ADRs (several are stubs from Session 0), and every milestone's five lines.

**Open questions**
- Development stack reset for the M3 artifacts: still the owner's call.

---

## 2026-10-07 — Session 2 (end) — Audit after the application was terminated

**Status at end:** M0–M8 `DONE`; M9 `NOT_STARTED`. Nothing was lost.

**Checked**
- Git: `git fsck` clean, working tree clean, no stash; the worktree and `main` are both at
  `1bd68c5`, with every milestone commit M0–M8 present.
- No stray files (`.mutant/`, `.seedcheck.ts`, Compose overrides) and no leftover node
  processes on the mutant or profiling ports (50151, 9201, 8180, 50152, 9202).
- All nine containers had exited with code 0 (a clean stop); `npm run stack:up` → 9/9
  healthy. No non-terminal transfers; migrations intact; both banks' chaos off; Orchestrator
  `LOG_LEVEL=info`.
- PROGRESS: M0–M8 have no unticked boxes (only M9 and the definition of done remain).
  22 ADRs, all Accepted. README has five lines for each of M0–M8. Every file in the §3
  layout exists.
- After a clean rebuild (dist and generated code deleted): build, lint and typecheck pass;
  unit 599/599; integration 179/179; the crash recovery test passes (200/200 SUCCESS, all
  finished by recovery); `npm run invariants -- --since <run start>` → all invariants hold.

**Findings, for M9**
- `services/{ledger,mockBank,orchestrator}/src/main.ts` each run `pool.query('SELECT 1')`
  for `/readyz`. That is SQL outside `repo/`, against §3's convention. Move it into a
  repo-level `ping()` during M9.
- Still the owner's call: resetting the development stack to clear the M3 mutation
  artifacts (ADR-021). Until then, use `npm run invariants -- --since`.
- Worktree `.claude/worktrees/project-overview-build-6d2112` (branch at `d384266`, M2)
  belongs to another session; it was left alone.

**Next action**
- **M9 Polish**, in a fresh session (the owner asked for one). Read §17 and §20.

---

## 2026-10-07 — Session 3 — M9 Polish

**Status at end:** M9 `DONE`, all 7 boxes ticked (6 from the spec plus the audit finding).
Definition of done: 6 of 8 ticked; 2 open, and neither can be checked from this machine.

**Done**
- README: the 8 sections in §17 order. The quick start's curl output was captured from
  the live stack (201, 200 replay, 409, 422 reversal). §5 lists every scenario with the
  test that exercises it. §6 is copied from `docs/benchmarks.md`, checked by a script that
  looked up every number. §7 covers ADRs 001–023. M9's five lines were added. The M8 line
  said "p95 96 ms" and "about 130/s"; it now gives the exact 95.7 ms and 129.7/s (no
  rounding, per the forbidden list).
- Five PNGs in `docs/diagrams/` (mermaid-cli 12.0.0 via `npx`, local Chrome, ADR-023 has
  the command). `*.png binary` added to `.gitattributes`.
- `.github/workflows/ci.yml`: `integration` (push/PR) and `nightly` (schedule +
  `workflow_dispatch`, two seeds + unscoped invariants) jobs. actionlint: 0 errors.
- ADRs 001–008 were already complete pages. Each gained an "As built" section. ADR-023
  records this milestone's choices.
- Audit finding fixed: `ping(pool)` in `balanceRepo.ts`, `accountsRepo.ts` and
  `transfersRepo.ts`; no `.query(` remains outside `repo/` in any service's `src/`.

**Results (measured, this session, final code)**
```text
npm run lint / typecheck -> clean / exit 0
npm test                 -> Test Files 29 passed (29) / Tests 599 passed (599)
npm run stack:up         -> 9/9 healthy; every /readyz 200 (8080, 9101, 9102, 9111, 9112)
npm run test:integration -> Test Files 10 passed (10) / Tests 179 passed (179), 225 s
invariants --since 2026-10-06T21:29:00Z (after integration) -> 65 transfers, all hold
TRANSFER_COUNT=10000 TEST_SEED=1 test:chaos -> 2/2; 10,486 requests, 520 ghosts,
    9,466 SUCCESS / 519 REVERSED / 15 FAILED, 0 manual review, I1-I7 PASS; crash 200/200
TRANSFER_COUNT=10000 TEST_SEED=2 test:chaos -> 2/2; 10,486 requests, 528 ghosts,
    9,393 SUCCESS / 523 REVERSED / 84 FAILED, 0 manual review, I1-I7 PASS; crash 200/200
invariants --since 2026-10-06T21:29:00Z (after both) -> 20,465 transfers, all hold
clean-room project payment-switch-fresh (ADR-023):
    stack:up 9/9 healthy, exit 0; seed "10 created", then "0 created, 10 already existed"
    test:integration 179/179; TRANSFER_COUNT=1000 test:chaos 2/2 (958 / 42, I1-I7)
    unscoped npm run invariants -> 1,265 transfers, all invariants hold, exit 0
    removed with down -v --rmi local; development stack restarted 9/9, its volumes intact
```

**Decisions** (ADR-023)
- The nightly job runs the 10,000-transfer test twice, with seeds 1 and 2, so every night
  re-checks the definition-of-done item itself. It ends with an unscoped
  `npm run invariants`, which is valid because a CI stack is always fresh.
- mermaid-cli is not a dependency. Puppeteer would download a browser on every `npm ci`.
- DoD item 2 ("everything matches the spec") was checked by script against §5, §7–§10,
  §14 and §15, so I did not have to read those sections whole. The only differences are
  the ADR-recorded deviations.
- DoD "tests pass in CI" stays unticked: CI has never run, and a local clean-room run is
  not CI. DoD "explainable without notes" stays unticked because only the owner can
  check it.

**Gotchas**
- **`#` in a Mermaid participant label starts a comment.** `Orchestrator #1` and
  `Orchestrator #2` both rendered as "Orchestrator", so the crash-recovery diagram
  lost its point, with no error shown. Always look at the rendered PNG.
- **A clean-room stack without touching the dev stack:** `COMPOSE_PROJECT_NAME=<other>`
  overrides the file's `name:` and gives fresh volumes. The ports are fixed, so
  `docker compose -p payment-switch stop` the dev stack first (that keeps its data), and
  tear the other project down with an explicit `-p`. `tests/helpers/stack.ts` inherits
  the variable, so the chaos test kills the right Orchestrator.
- The same seed does not give identical final counts across runs (seed 1: 9,467/518/15
  in M7, 9,466/519/15 now). Which payer has funds at the moment of its debit depends on
  how 100 concurrent requests interleave. The invariants hold every time, and the README
  says so.
- The unscoped `npm run invariants` on a **fresh** stack passes even after the
  integration suite (its synthetic rows are released and finished, ADR-020). That
  confirms ADR-021's diagnosis: on the dev stack only the M3 mutation artifacts fail.
- A fresh worktree has no `node_modules` or generated code: `npm ci && npm run build`
  first, or `tsc -b` fails on an empty `packages/proto-gen`.

**Next action**
- Nothing is left in phase 1 that this machine can check. The owner decides on a GitHub
  remote: push, watch `static` and `integration`, and trigger `nightly` once by hand. Phase
  2 (§19) starts only after the two open DoD boxes are ticked.

**Open questions**
- Reset the development stack to clear the M3 artifacts (ADR-021)? The owner's call. It
  has not been done.
- Add a GitHub remote? The owner's call. Nothing has been pushed.

---

## 2026-10-07 — Session 3 (continued) — Open items after M9

**Status at end:** unchanged: M0–M9 `DONE`, definition of done 6 of 8. The owner said
not to wait on them for required work that cannot damage the project.

**Done**
- **Backup for the dev stack reset (ADR-021).** `pg_dumpall` of `postgres-orchestrator`,
  `postgres-ledger` and `postgres-banks` (about 300 MB), stored outside the repo in
  `D:\WORK\DEV\PROJECTS\PaymentSwitch_DEL_backups\2026-10-07-pre-reset\`. It was
  restored into a throwaway `postgres:16` and every check matched live: transfers 97,576,
  events 583,286, journals 195,531, entries 391,062 / 5,590,912,458 paise, and both banks'
  account counts and balance sums. Restore steps are in `RESTORE.md` next to the dumps.

**Not done, and why**
- **The reset itself.** `npm run stack:down` (deletes the volumes) was denied by the
  auto-mode classifier as irreversible local destruction. It was not retried by any other
  route. The owner runs `npm run stack:down && npm run stack:up && npm run seed`, then
  `npm run invariants` unscoped should pass.
- **The GitHub remote.** `gh` is not installed, and Windows Credential Manager holds two
  different GitHub identities. Creating the repo needs the owner's login, and Claude must
  not pick an identity or extract a stored token.

**Gotchas**
- PostgreSQL 16's `pg_dumpall` now writes `\restrict` / `\unrestrict` lines with a random
  key, which is why each dump ends in a random-looking token before the completion
  comment. That is expected, not corruption.

---

## 2026-10-07 — Session 3 (continued) — First CI runs; the exactly-once bug they found (ADR-024)

**Status at end:** M0–M9 `DONE`. Definition of done **7 of 8**; the last box ("explainable
without notes") is the owner's to confirm. `main` = `origin/main`. All three CI jobs green.

**Done**
- The owner reset the dev stack (backup first) and ran `gh auth login` / `gh auth refresh
  -s workflow` as `rohan099dubey`. I created the **private** repo
  `rohan099dubey/payment-switch` and added `origin`. A repo-local credential helper
  (`gh auth git-credential`) makes git authenticate as `rohan099dubey`, not the second
  identity in Credential Manager. I pushed `main`.
- First push run: `static` + `integration` green. First `nightly`: seed 1 green, **seed 2
  red**.
- Root cause from the uploaded `compose-logs-nightly` artifact (timeline in ADR-024): a
  Debit timed out (`late_apply`), the retry was refused (`INSUFFICIENT_FUNDS`), the
  transfer `FAILED`, then the first Debit applied. Rejections leave no operation row
  (§8), so nothing fenced the reference. The credit leg has the same hole.
- Red first: two `failurePaths` tests play the late Debit/Credit after the terminal
  state. Both `APPLIED` on the old code.
- Fix (ADR-024): `failFenced` in `saga.ts` calls `Resolve` before any definite-failure
  branch; `settle` now shares `resolveLeg` / `onResolution` / `unresolved`. The unit test
  that pinned the old behaviour ("a definite failure after an unknown one is taken") is
  replaced by 7 fence tests. A skip-the-fence mutant fails 14. Two orchestrator
  integration assertions now require the `VOIDED` tombstone instead of "no row".
- Diagrams (`state-machine`, `sequence-credit-fails`) re-rendered with the fence.
  README, CONTEXT (rule 2, deviation table) and the ADR-021 amendment updated.

**Results (measured)**
```text
local, c5a82c1: lint/typecheck clean; unit 605/605; integration 181/181
  seed 1: 9,466 SUCCESS / 518 REVERSED / 16 FAILED, I1-I7, 0 manual review; crash 200/200
  seed 2: 9,399 / 521 / 80, I1-I7, 0 manual review; crash 200/200
  invariants --since 2026-10-07T06:41:27Z -> 20,469 transfers, all hold
GitHub, 17c5e9e (before the fix):
  push 37580346433: static OK (29 unit files), integration OK (10 files; chaos 1000: 958/42; crash 192 of 200 registered)
  nightly 37581136799: seed 1 OK; seed 2 FAIL: I2 40,000,000 -> 39,958,307; I5 b9bb6ea6 FAILED with DEBIT APPLIED
GitHub, c5a82c1 (the fix):
  push 37584320506: static (unit 605/605), integration (181/181; chaos 1000 2/2)
  nightly 37584333954: seed 1 9,468/520/12; seed 2 9,407/525/68; unscoped invariants over 20,400 transfers: all hold
```

**Decisions**
- Fence on **every** definite refusal, not only after an observed timeout: an earlier
  attempt may come from a driver that crashed and left no trace. (ADR-024)
- The fix is in the switch, not the bank. The bank stands in for an external system with
  a fixed contract (§8, the M2 acceptance tests). The switch uses the RPC the bank already
  offers.
- DoD item 4 was re-justified with runs on the fixed code. It had passed on the buggy code
  too (M7, M9): two green chaos runs did not prove the bug absent, and the nightly found
  it. PROGRESS says so in that box.

**Gotchas**
- **I ran the red tests against the shared dev stack.** Because the bug was real, they
  left two permanently inconsistent transfers (`c9346799`, `5c784905`, ±1,000 paise); the
  unscoped checker reports exactly those. A red test against code with a known money bug
  is a mutation run: use a throwaway Compose project (ADR-023), as the M7 gotcha already
  said.
- The unscoped checker fails for about 15 s right after `test:integration`: the
  `orchestratorRepo` synthetic rows still hold their insert-time lease. Timing, not a bug;
  ADR-021 amendment.
- The crash test can register fewer than it sends (192 of 200 on the GitHub runner): a
  request that hits a dead Orchestrator before its row exists gets a retry-safe 503 and has
  no effects. I7's sample count likewise depends on the kill timing (54 vs 151).
- `gh` installed by winget is on the Windows PATH, but MSYS2 UCRT64 does not inherit it.
  Use PowerShell, or add the winget `Packages\...\bin` folder to `~/.bashrc`.
- Without the `workflow` scope, GitHub rejects a push that contains `.github/workflows/*`:
  `gh auth refresh -s workflow`.
- GitHub logs keep ANSI codes as literal `^[[..m` text; strip them before grepping counts.
- Python in a bash heredoc: `\2` or `\b` inside a normal string becomes a control
  character (it mangled a Windows path twice). Use `chr(92)`, or write the script with the
  Write tool.

**Next action**
- The owner confirms the last DoD box; then phase 2 (§19) may start. Optionally the owner
  resets the dev stack again to clear the two red-test transfers.

**Open questions**
- None about the design.

---

## 2026-10-07 — Session 3 (continued) — P2-1 Transactional outbox & Kafka

**Status at end:** all P2-1 boxes but the CI one ticked. Phase 1 was closed first: the
owner confirmed the last DoD box, so the definition of done is 8/8. Branch
`claude/p2-1-outbox-kafka`.

**Done**
- `0002_outbox.sql`, `domain/outboxEvents.ts`, `repo/outboxRepo.ts`, `outbox/relay.ts`,
  `clients/kafkaPublisher.ts`, wiring in `main.ts` (the relay stops after recovery on
  SIGTERM), config `KAFKA_BROKERS` / `OUTBOX_POLL_MS`, three metrics, Kafka in Compose.
  `casTransition` inserts the event for a terminal transition in its own transaction.
- Invariant **I8** in the shared helpers: both chaos tests (`evaluate` waits for the
  outbox to drain) and `npm run invariants`. The cutoff is `schema_migrations.applied_at`
  of `0002_outbox.sql`: the history is not backfilled.
- Tests: 25 new unit tests (event mapping, relay against fakes, config, I8, `readQuery`);
  `tests/integration/outbox.test.ts` (8, including a Kafka outage); the metrics test
  pins the three new metrics. ADR-025 records the interpretations.

**Results (measured)**
```text
lint / typecheck / buf lint clean; unit 630/630; integration 192/192 (11 files)
outbox.test against a dual-write mutant (throwaway project ps-mutant-outbox): 3 failed / 5 passed, as intended
TRANSFER_COUNT=10000 test:chaos, seed 1: 9,469 / 518 / 13, I1-I8, crash 200/200 with I8 (0 read retries)
TRANSFER_COUNT=10000 test:chaos, seed 2: 9,396 / 524 / 80, I1-I8, crash 200/200 with I8 (0 read retries)
npm run invariants -- --since 2026-10-07T08:36:46Z -> 20,400 transfers, I1-I6 and I8 hold
smoke: transfer -> outbox row published 313 ms later; created_at equal to the terminal event's
```

**Decisions** (ADR-025)
- Every terminal state emits an event, including `NEEDS_MANUAL_REVIEW` (stricter than the
  spec's three examples). The database enforces one event per transfer.
- `apache/kafka:3.9.1`, not 4.x: kafkajs 2.2.4 (the last release, 2023) predates the
  protocol versions 4.0 removed.
- Kafka is not a dependency of the Orchestrator (no `depends_on`, readiness ignores it).
  The outage test proves that payments continue.
- The relay holds its `FOR UPDATE` transaction across the send, as the spec's query
  requires. It is bounded by the producer timeouts, and only outbox rows are locked.

**Gotchas**
- **Two 10,000-transfer runs failed with `read ECONNRESET` in the test harness** (the
  first ledger-database connection, at the very end). Diagnosed rather than retried
  blindly: Postgres logged nothing (the connection never reached it), `TIME_WAIT` stayed
  under 61 (not port exhaustion), the database never restarted, and the checker on a
  fresh connection held over 20,455 transfers. This is Docker Desktop's port forwarder
  on Windows. The fix is `readQuery`: read-only verification queries retry only
  connection-level errors, at most twice, and log each retry (ADR-021 amendment). The
  next two runs logged 0 retries. CI on Linux has no Docker Desktop.
- kafkajs warns "Limiting retries for the idempotent producer may invalidate EoS". That
  is expected here: a failed send drops the producer and the outbox retries the batch
  (ADR-025). Set `DefaultPartitioner` explicitly, or kafkajs warns about the v2 default.
- The Orchestrator starts before Kafka, so its first `InitProducerId` can hit "the
  coordinator is loading". The relay retries; harmless.
- Adding a second `child({ component })` in pino duplicates the key in the JSON line.
  Use a different field name (`subsystem`).
- The dual-write mutant ran in a throwaway Compose project, following the red-test rule
  from earlier today.

**Next action**
- Push, then watch `static` + `integration` and a manual `nightly` on GitHub. Tick the CI
  box, merge P2-1 to `main`, then P2-2 (the notification service, §19 item 2).

**Open questions**
- None.
- **First PR CI of P2-1: `integration` failed one Gateway test** (191/192). The CI
  Compose logs showed 68 `Command timed out` fail-opens during the 450-request burst,
  with Redis healthy. The 250 ms ioredis timeout (ADR-019) mistook event-loop lag for an
  outage and let about 15% of the burst past the limiter. The fix is 1,000 ms; a dead
  Redis still fails open at once (no offline queue). The test now also requires
  `rate_limit_fail_open_total` to stay unchanged during the burst. A 1 ms mutant fails
  it (355 passed against a limit of 303). ADR-019 amendment.

---

## 2026-10-07 — Session 3 (continued) — P2-1 merged; P2-2 Notification service

**Status at end:** P2-1 `DONE` and on `main` (`4c813fb`; PR rohan099dubey/payment-switch#1).
P2-2: every box ticked but CI. Branch `claude/p2-2-notification`.

**Done**
- P2-1 closed in a temporary `git worktree` (the CI tick and `DONE`), so the uncommitted
  P2-2 work never touched P2-1's history. `main` was fast-forwarded and checked in the main
  checkout (build, lint, typecheck, unit 630/630), then pushed.
- `services/notification` (ADR-026): its own `postgres-notification`, `processed_events`
  (PRIMARY KEY `event_id`) and `webhook_attempts`, a simulated webhook, 5 attempts with
  200·2^n ms backoff, `transfer-events.dlq`, consumer group `notification`, invariant I9.
- Both Kafka services now create only missing topics: kafkajs logs an error for every
  topic that already exists, which looked like a failure on every restart.

**Results (measured)**
```text
backlog: the new consumer group processed 51,878 events exactly once; 74 duplicates (relay redeliveries) dropped
unit 657/657; integration 200/200 (12 files)
TRANSFER_COUNT=10000 test:chaos seed 1: 9,467 / 519 / 14, I1-I9, I9 10,000 delivered (one read reset retried)
TRANSFER_COUNT=10000 test:chaos seed 2: 9,403 / 523 / 74, I1-I9, I9 10,000 delivered
npm run invariants -- --since 2026-10-07T11:53:36Z -> 20,484 transfers, I1-I6, I8, I9 hold
unscoped checker: I9 over 51,909 published events (51,906 delivered, 3 dead-lettered)
```

**Gotchas**
- **My Kafka test helper `JSON.parse`d every value.** The malformed-message dead letter
  (`not an event`) made it throw inside kafkajs's `eachMessage`, so the read stalled and
  the test timed out. The service was right: the console consumer showed the dead letter.
  A Kafka handler must never throw on data it does not control.
- **Two more Docker Desktop transport effects** (ADR-021 amendment). A 450-request burst
  sometimes never fully reaches the Gateway: its logs showed 445 of 450 arrivals in the
  failing runs and all 450 in the passing ones. The test client now has a timeout and
  retries only when no HTTP response arrived, which is the README's own client rule.
- The `GetBalance` integration test measured global totals while recovery finished an
  earlier test's transfer (exactly +1,000 paise). It now waits for a quiet stack.
- Python `\n` inside a bash heredoc can become a real newline in a TS template literal.
  Check with `cat -A`.

**Next action**
- P2-2 PR and CI (including a manual `nightly`), then merge, then P2-3 reconciliation
  (§19 item 3). Design note: finding "missing at bank" needs the ledger's journals for a
  time window, which no ledger RPC offers yet. That will be an additive, read-only Ledger
  RPC, with an ADR.

---

## 2026-10-07 — Session 3 (continued) — P2-2 merged; P2-3 Reconciliation service

**Status at end:** P2-2 `DONE` and on `main` (`c27e782`; PR rohan099dubey/payment-switch#2,
nightly 37620676547 green with I9). P2-3: every box but CI ticked. Branch
`claude/p2-3-reconciliation`.

**Done**
- Contracts, all additive (`buf breaking` against `main` clean): bank `GetStatement`, ledger
  `ListJournalsByTime` (added, ADR-027), new `reconciliation.proto`. Keyset paging helpers in
  `@switch/common`. Index migrations on both sides.
- `services/reconciliation`: legs, the reconciler (window candidates, the missing side looked
  up by reference, duplicates summed, open breaks re-checked), set-based break upsert, an
  advisory-locked runner, a scheduler (5 min, 120 s settle), gRPC `GetReport` and
  `RunReconciliation`, three metrics, its own Postgres. Invariant I10.

**Results (measured)**
```text
first run over today's dev data: 185,876 statement lines vs 185,664 journals in 57 s -> 763 breaks;
  exactly 2 are switch transfers (c9346799, 5c784905: the red-test transfers, MISSING_IN_LEDGER 1,000)
  the other 761 are direct bank or Ledger test traffic (none is a UUID transfer id)
unit 9 reconciler tests, plus paging and I10; a window-only mutant fails 5
integration 212/212 (13 files); reconciliation.test 7/7
TRANSFER_COUNT=10000 test:chaos seed 1: 9,469 / 519 / 12, I1-I10 (I10: 0 open breaks of 10,000)
TRANSFER_COUNT=10000 test:chaos seed 2: 9,400 / 524 / 76, I1-I10
npm run invariants -- --since 2026-10-07T12:45:02Z -> 20,487 transfers, I1-I6 and I8-I10 hold
unscoped checker: I10 flags the same 2 transfers as I4/I5 (two independent views agree)
```

**Gotchas**
- The test client's transport retry fired 18 and 40 times in the two chaos runs (POST with no
  response in 20 s). Checked rather than assumed: the Gateway's own logs show a maximum of
  6,989 ms over 23,086 transfer requests in that window, none over 10 s. So these were
  connections lost in Docker Desktop's port forwarding, very likely while `docker compose
  kill/start` restarted the Orchestrator. The retry recovers lost connections; it hides no
  slowness. Retries reuse the same `Idempotency-Key` (I7 checks every replay).
- Reconciliation reports traffic that bypassed the switch as true breaks (the bank and
  Ledger tests call those services directly). That is correct, so I10 is scoped to switch
  transfers.

**Next action**
- P2-3 PR, CI with `nightly`, merge; then P2-4 tracing and dashboards (§19 item 4):
  OpenTelemetry 0.223 (sdk-node, OTLP proto, gRPC/HTTP/pg instrumentation) to Jaeger 2.11,
  Prometheus 3.7, Grafana 12.2 with committed dashboard JSON.
