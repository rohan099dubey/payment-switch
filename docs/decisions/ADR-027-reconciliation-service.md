# ADR-027 — Reconciliation service: details section 19 leaves open

- **Status:** Accepted
- **Date:** 2026-10-07
- **Milestone:** P2-3 (phase 2, item 3)
- **Type:** Clarification, plus two additive RPCs beyond the spec's list (a ledger query and an on-demand run)

## Context

Section 19, item 3: "**Reconciliation service** (`services/reconciliation`). Add the bank
RPC `GetStatement(from, to)`. A scheduled job (default every 5 minutes) compares each
bank's statement with ledger journals by reference id, classifies breaks as missing in
ledger, missing at bank or amount mismatch, stores them in a `reconciliation_breaks` table
and exposes a `GetReport` RPC." Several things are left open. Some of them make the
literal reading incomplete: "missing at bank" means a journal with no bank operation, and
no existing Ledger RPC can enumerate journals by time.

## Decisions

| Topic | Decision | Why |
|---|---|---|
| What is matched | One **leg** per (bank, reference id, operation): `TRANSFER_DEBIT_LEG` ↔ the payer bank's `DEBIT`, `TRANSFER_CREDIT_LEG` ↔ the payee bank's `CREDIT`, `TRANSFER_REVERSAL` ↔ the payer bank's `REVERSE_DEBIT`. The bank is taken from the journal's `receivable:` or `payable:` line. Only `APPLIED` bank operations count; a `VOIDED` tombstone moved no money | That is the exact meaning of each journal (section 7). Matching by reference id **and** operation, not reference id alone, is the stricter reading: a debit must match a debit leg |
| Classes | `MISSING_IN_LEDGER` (an applied bank operation with no journal), `MISSING_AT_BANK` (a journal whose bank operation is not applied), `AMOUNT_MISMATCH` (both exist, the amounts differ) | Section 19 |
| `GetStatement` | `BankService.GetStatement(from, to, page_size, page_token)`: the `APPLIED` operations with `from ≤ created_at < to`, ordered by (created_at, reference_id, operation), at most `page_size` (≤ 1,000) per page, with an opaque cursor | The spec's RPC. Paging is required, not optional: a busy window holds tens of thousands of operations, which is more than gRPC's default 4 MB message limit |
| Ledger side | **Added** `LedgerService.ListJournalsByTime(from, to, page_size, page_token)`, read-only, same paging | "Missing at bank" means a journal with no bank operation. Starting from bank statements alone can never find a journal whose reference no bank knows. Additive and read-only, so `buf breaking` passes and nothing that exists changes |
| Time windows | A run covers `[from, to)`, with `to = now − RECON_SETTLE_MS` (default 120 s). Each candidate's counterpart is looked up **by reference, at any time** (`ListJournals`, `GetOperation`), so a leg straddling the window edge is never a false break | A saga posts the journal a few milliseconds after the bank applies. Reading both sides by window alone would flag every leg on the edge |
| Break lifecycle | `reconciliation_breaks` holds one row per (bank, reference, operation), `UNIQUE`, with status `OPEN` or `RESOLVED`. Every run re-checks the open breaks, and one whose counterpart has since appeared becomes `RESOLVED` | A transfer that recovery finishes later (a ledger outage, say) is a transient break. Recording it and then resolving it is truthful. Silently ignoring it is not |
| Schedule | Every `RECON_INTERVAL_MS` (default **300,000**, the spec's 5 minutes). Each run continues from the previous run's `to` (stored in `reconciliation_runs`); the first run starts at `RECON_INITIAL_FROM` (default: when the service first started) | No gaps, no double coverage. Pointing it at history is an explicit choice |
| On-demand run | **Added** `ReconciliationService.RunReconciliation(from, to)`: runs synchronously over an explicit window and returns the run summary | Tests (and operators) cannot wait 5 minutes. The scheduled job and this RPC share one code path |
| `GetReport` | `GetReport(status, reference_ids, limit)` returns the open (or all) breaks, optionally filtered by reference ids, plus the latest run (window, counts, duration) | Section 19 |
| Its own database | `reconciliation_db` in a dedicated `postgres-reconciliation` (host port 5437). gRPC 50053, HTTP 9104 | ADR-007 |
| Invariant **I10** | For a set of transfers, after a reconciliation run covering their time: **no `OPEN` break** carries one of their reference ids. Checked by both chaos tests (which trigger a run over the run's window) and by `npm run invariants` (against the breaks already recorded) | It shows that the books an outsider can see (bank statements against ledger journals) agree, independently of the invariants computed inside the switch |

Traffic that bypasses the switch is a **true** break, and reconciliation reports it. That
includes the Ledger and Mock Bank integration tests, which post journals or move money
directly, and the two red-test transfers of 2026-10-07. I10 is therefore always scoped to
transfers the switch made. Unscoped, the report correctly lists that direct traffic.

## Consequences

- Two more containers (the service and its Postgres) in the stack and in CI.
- A break can open and later resolve while recovery is still finishing a transfer, and
  the report shows both states honestly. `RECON_SETTLE_MS` keeps that rare.
- `ListJournalsByTime` exposes journal history to one more internal reader; it is
  read-only and paged.

## Alternatives considered

- **Reconcile from bank statements only.** It cannot detect a journal that no bank
  operation backs, which is half of the spec's "missing at bank".
- **Read the ledger's database directly.** It violates database-per-service (ADR-007).
- **Unpaged `GetStatement`.** It breaks on a busy window (the 4 MB gRPC limit).
- **No on-demand run.** It makes the service untestable without waiting 5 minutes.
