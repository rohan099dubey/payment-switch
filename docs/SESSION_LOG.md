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
