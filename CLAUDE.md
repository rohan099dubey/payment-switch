# CLAUDE.md

## Session protocol — do this first, every session

This project is too large for one context window. It is built one milestone per
session, and the files below exist so a session with zero prior context can orient
itself cheaply. Follow this order:

1. **Read `docs/CONTEXT.md`.** Always, first, before anything else. It is ~150 lines
   and tells you what this is, where the project stands, and what the rules are.
2. **Read `docs/PROGRESS.md`.** Find the active milestone and its first unchecked box.
   That box is your task.
3. **Read only the `ARCHITECTURE.md` sections that milestone names** (the "Read first"
   column in `PROGRESS.md`). Do *not* read the whole file — it is ~38k tokens and
   reading it in full costs a quarter of the session for no benefit.
4. **Work the milestone.** Only that milestone. Never start the next one.
5. **Before claiming done:** run `npm run lint && npm run typecheck && npm test`, plus
   that milestone's acceptance commands. Paste the real output. Tick each box in
   `docs/PROGRESS.md` individually — a box is ticked only when its specific assertion
   has been observed passing, never because the milestone "feels" complete.
6. **At session end:** append an entry to `docs/SESSION_LOG.md` (gotchas and decisions
   especially — that is the memory the next session cannot reconstruct) and update the
   status row in `docs/PROGRESS.md`.

If `ARCHITECTURE.md` is ambiguous, choose the stricter option and write a short ADR in
`docs/decisions/`. If you deviate from `ARCHITECTURE.md` for any reason, that is also
an ADR, and it gets listed under "Active deviations" in `docs/CONTEXT.md`. The spec is
never edited in place.

## Project rules

- Read `ARCHITECTURE.md` before every task. It is the source of truth. Do not deviate
  or simplify.
- Implement only the milestone named in the prompt. Do not start later milestones.
- TypeScript strict, CommonJS, **Node 22** (see `ADR-009`; the spec says 20, which is
  EOL), npm workspaces. Raw SQL with `pg`. gRPC with `@grpc/grpc-js` and the generated
  code in `packages/proto-gen`.
- Money is `bigint` paise. Never floats.
- Every transfer state change is a compare-and-set on `version` plus a
  `transfer_events` row, in one transaction.
- Before saying a milestone is done, run: `npm run lint && npm run typecheck && npm test`,
  plus the acceptance commands listed for that milestone.
- If `ARCHITECTURE.md` is ambiguous, choose the stricter option and write a short ADR
  in `docs/decisions/`.

## Never do these

Each one removes something the design exists to demonstrate. If you are about to
propose one, stop and re-read the relevant `ARCHITECTURE.md` section instead.

- Merging services, sharing a database between services, or replacing gRPC with HTTP
  between services.
- Using an ORM, keeping durable state in memory, or mocking Postgres in integration
  tests.
- Skipping the `*_SENT` write-ahead states, or calling a bank before the intent is
  committed.
- Treating a timeout as a failure instead of an unknown outcome.
- Removing `Resolve` and its tombstones, or replacing leases and compare-and-set with
  plain `UPDATE`s.
- Storing a running balance in the ledger, or allowing a journal or entry to be updated
  or deleted.
- Using floating-point numbers for money.
- Lowering the transfer count, loosening an invariant, or skipping a test because it is
  hard.
- Using `any` or `@ts-ignore`.
- Inventing or rounding up a benchmark number. Every figure comes from
  `docs/benchmarks.md`, measured.
