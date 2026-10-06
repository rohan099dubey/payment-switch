# ADR-007 — Database per service; one shared Postgres only for the mock banks

- **Status:** Accepted
- **Date:** 2026-10-04 (from ARCHITECTURE.md)
- **Milestone:** M0

## Context

Four services need persistence: the Orchestrator (transfers and their audit trail), the
Ledger (books), and two bank instances (customer balances and operations). The Gateway
needs none.

Sharing one database would be simpler to run locally and would allow a single
transaction to span, say, a transfer state change and a ledger journal — which would
make parts of the saga unnecessary.

## Decision

**Every service owns its own database and nobody reads another's.** No foreign keys
cross a database boundary. All cross-service access is gRPC.

Container layout:

| Container | Databases | Why |
|---|---|---|
| `postgres-orchestrator` | `orchestrator_db` | the switch's own state |
| `postgres-ledger` | `ledger_db` | the switch's own books |
| `postgres-banks` | `bank_a`, `bank_b` | the banks are *external* systems |

The two banks share one container deliberately: they stand in for third-party
institutions whose internals the switch has no access to. Giving them a container each
would be more realistic still, but adds nothing testable while costing startup time and
memory on a laptop. The Orchestrator and Ledger each get a dedicated container because
they are the system under test and the isolation boundary must be real.

## Consequences

- No transaction can span the Orchestrator and the Ledger. That is the point: it forces
  the saga and the idempotent journal posting to be correct rather than relying on a
  shared commit.
- Posting a ledger leg can fail independently of the state change, which is why
  `DEBITED` means "bank confirmed **and** ledger leg posted" and why `DEBIT_SENT` is
  retried until both are true.
- Three Postgres containers plus Redis to start locally. `docker compose down -v` is the
  full reset.
- Integration tests must talk to each service through its real interface, which is why
  all host ports are published.

## Alternatives considered

- **One Postgres, one schema per service.** Cheaper to run, but it makes cross-service
  transactions *possible*, and anything possible eventually gets used — collapsing the
  architecture the project exists to demonstrate.
- **A container per bank as well.** Marginally more faithful; rejected as cost without
  new behaviour, since the two banks already have fully separate databases and separate
  gRPC endpoints.
- **SQLite per service for tests.** Would require mocking Postgres behaviour the design
  depends on (`ON CONFLICT`, `FOR UPDATE SKIP LOCKED`, deferred constraint triggers).
  Explicitly forbidden.

## As built (checked in M9, 2026-10-07)

- `docker-compose.yml` has exactly the three Postgres containers in the table, plus
  Redis. No service has another's connection string, and all cross-service access is
  gRPC.
- The Compose project name is fixed (`payment-switch`), so every checkout of the
  repository shares one development stack and one set of volumes.
- Integration tests drive each service through its public interface. They touch a
  database directly only to test that database's own rules (for example, a raw insert
  the Ledger's balance trigger must reject) or to check what the service stored.
