# ADR-015 — The ledger also forbids `TRUNCATE`

- **Status:** Accepted
- **Date:** 2026-10-05
- **Milestone:** M1
- **Type:** **Deviation from ARCHITECTURE.md** (one added migration)

## Context

Section 7 says the Ledger must never "update or delete a journal or entry (database
triggers enforce this)". Section 10's `0001_init.sql` implements that with
`BEFORE UPDATE OR DELETE ... FOR EACH ROW` triggers.

Postgres does not fire row-level triggers for `TRUNCATE`. So `TRUNCATE entries` (or
`TRUNCATE journals CASCADE`) deletes every row in one statement and passes every
trigger the spec defines. The append-only guarantee had a hole exactly where it matters
most: the whole ledger, gone at once.

## Decision

Add `services/ledger/migrations/0003_forbid_truncate.sql`:

```sql
CREATE TRIGGER journals_no_truncate BEFORE TRUNCATE ON journals
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER entries_no_truncate BEFORE TRUNCATE ON entries
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
```

It reuses the spec's own `forbid_mutation()` function, so the error is the same:
`table <name> is append-only`. `0001` and `0002` stay verbatim. The spec allows new
migrations ("adding a bank later means adding two accounts in a new migration"), so a
new file is the right place.

## Consequences

- `TRUNCATE` on either table fails, and the M1 integration tests assert it.
- A full reset is still `docker compose down -v`, which drops the volume rather than
  rewriting history inside the database.
- A superuser can still drop the triggers. Defending against the database owner is out of
  scope; the goal is that no ordinary statement can rewrite history.

## Alternatives considered

- **Revoke `TRUNCATE` privilege.** The service connects as the table owner, and owners
  keep the right to truncate. Rejected: it would not actually stop anything.
- **Leave it as the spec wrote it.** Rejected: the spec's stated rule is "never delete",
  and this is the stricter reading of it.
