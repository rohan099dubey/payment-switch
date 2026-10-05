# ADR-014 — `schema_migrations` records a checksum per migration

- **Status:** Accepted
- **Date:** 2026-10-05
- **Milestone:** M1 (the runner was written in M0 and corrected here)
- **Type:** **Deviation from ARCHITECTURE.md** (one added column)

## Context

Section 10 specifies the migration runner's table as
`schema_migrations(filename text primary key, applied_at timestamptz)`. It also says "a
migration is never edited after it is merged; changes go in a new file". But nothing
enforces that. An edited `0001_init.sql` would be silently skipped on existing databases
and applied in its new form on fresh ones, so two environments would drift apart without
any error.

Section 10 also says pending files are applied "in filename order inside one
transaction". That could mean one transaction per file or one for the whole batch. Per
`CLAUDE.md`, the stricter reading wins: one transaction for the batch.

## Decision

```sql
CREATE TABLE IF NOT EXISTS schema_migrations (
  filename   text PRIMARY KEY,
  checksum   text NOT NULL,          -- added: sha256 of the file's contents
  applied_at timestamptz NOT NULL DEFAULT now()
);
```

- At startup, every already-applied file is re-hashed. A mismatch aborts startup with
  `migration <file> was modified after being applied (checksum mismatch)`.
- All pending files apply in one transaction, so a failure leaves the schema exactly as
  it was before startup.

## Consequences

- Editing a merged migration fails loudly on the next start against any database that
  already applied it.
- Checksums are over the exact bytes, so line endings matter. `.gitattributes` already
  forces `*.sql` to LF on every checkout, so Windows, Linux and Docker hash identically.
- None of the spec's migrations use statements that cannot run inside a transaction
  (e.g. `CREATE INDEX CONCURRENTLY`). A future one that needs this would require a
  runner change and a new ADR.

## Alternatives considered

- **Spec table exactly, no checksum.** Keeps the rule unenforced. Rejected: the rule is
  the spec's own, so enforcing it is the stricter option.
- **One transaction per file.** Lets a failed batch leave the schema half-migrated.
  Rejected.
