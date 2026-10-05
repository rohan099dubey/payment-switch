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
