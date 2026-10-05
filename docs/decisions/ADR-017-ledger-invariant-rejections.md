# ADR-017 — Ledger database-invariant rejections are `FAILED_PRECONDITION`, not `INTERNAL`

- **Status:** Accepted
- **Date:** 2026-10-05
- **Milestone:** M3 (raised in M1, `PROGRESS.md` open question 2)
- **Type:** Addition the spec does not cover (one new `x-error-code`, no contract or schema change)

## Context

The Ledger's database refuses invalid data on its own: the append-only triggers and the
deferred "journal balances" constraint trigger `RAISE EXCEPTION` (SQLSTATE `P0001`), and
`entries` has `CHECK` constraints (`23514`). Application validation in
`domain/validate.ts` should make these unreachable, so they only fire if that code has
a bug.

When they did fire, the raw `pg` error reached `instrument()`, which maps any
unexpected error to gRPC `INTERNAL`. Section 14 classifies `INTERNAL` from the Ledger as
`UNKNOWN_OUTCOME`. The Orchestrator would therefore **retry** a journal that the database
can never accept: three inline attempts, then 20 recovery attempts with backoff of up to
60 s, and only then `NEEDS_MANUAL_REVIEW` / `RECOVERY_EXHAUSTED`. The money is safe
either way, but the failure would take tens of minutes to surface, and it would surface
under the wrong reason.

Section 6 says "a Ledger answer of `INVALID_ARGUMENT` or `FAILED_PRECONDITION` is a `bug`,
never retried", and section 13 scenario 14 says "the Ledger rejects a journal as invalid →
`NEEDS_MANUAL_REVIEW`". The spec clearly intends this case to be a `BUG`, but it does not
say which status the Ledger should send.

## Decision

The stricter option: the Ledger maps its own database-invariant rejections during
`PostJournal` to **gRPC `FAILED_PRECONDITION` with `x-error-code:
LEDGER_INVARIANT_VIOLATION`**, which `classify(…, 'ledger')` already treats as `BUG`. The
Orchestrator moves the transfer to `NEEDS_MANUAL_REVIEW` / `LEDGER_REJECTED` immediately.

- Only `pg` `DatabaseError`s with SQLSTATE `P0001` (`raise_exception`) or `23514`
  (`check_violation`) are mapped (`databaseRejectionOf` in `repo/journalRepo.ts`). Both
  are deterministic for a given request, so a retry can never succeed.
- Everything else is still `INTERNAL`, and so still `UNKNOWN_OUTCOME`: connection loss,
  shutdown (`57P01`), serialization failures and deadlocks (`40001`, `40P01`) are
  transient, and the safe default is to retry. `23505` (unique violation) cannot occur on
  the idempotency key, because that insert uses `ON CONFLICT DO NOTHING`.
- The repo returns an outcome (`rejected_by_database`) and the handler throws, following
  the existing "repo returns outcomes, handlers throw" rule.

### Rejected alternatives

- **Leave it `INTERNAL`.** Safe but slow, and the reason recorded would be
  `RECOVERY_EXHAUSTED` instead of `LEDGER_REJECTED`, which hides the actual bug.
- **Reuse `INVALID_ARGUMENT` / `JOURNAL_INVALID`.** That code means "application
  validation refused the request". Keeping a separate code shows *which* layer caught
  the problem. A database rejection means validation itself is broken, which is the more
  serious finding.
- **Map every `DatabaseError` to `FAILED_PRECONDITION`.** That would turn transient
  database failures into permanent manual reviews. It looks strict, but it is unsafe.
- **Raise a custom SQLSTATE from the triggers.** This would mean editing applied
  migrations (refused by the checksum, ADR-014) or adding trigger replacements in a new
  migration, which is more change for the same result.

## Consequences

- Unit test `services/ledger/test/repo/journalRepo.test.ts` pins which SQLSTATEs map and
  which do not, and that the resulting status classifies as `BUG`.
- The path cannot be reached through the real gRPC API without a validation bug. It was
  verified end to end during the M3 mutation check: a Ledger copy with the balance check
  removed from `validate.ts` returned `FAILED_PRECONDITION` /
  `LEDGER_INVARIANT_VIOLATION`, and nothing was committed. See `SESSION_LOG.md`, M3.
