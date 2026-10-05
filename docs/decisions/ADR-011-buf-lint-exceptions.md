# ADR-011 — Four `buf lint` STANDARD exceptions for the verbatim contracts

- **Status:** Accepted
- **Date:** 2026-10-05
- **Milestone:** M0
- **Type:** **Deviation from ARCHITECTURE.md**

## Context

`ARCHITECTURE.md` makes three demands that cannot all hold at once:

1. Section 9: the three `.proto` files are created **verbatim**, with packages
   `switchpay.{bank,ledger,orchestrator}.v1`.
2. Section 3: they live at `proto/bank/v1/bank.proto`, `proto/ledger/v1/ledger.proto`,
   `proto/orchestrator/v1/orchestrator.proto`.
3. Section 2: `buf.yaml` sets lint `STANDARD`, and `buf lint` must pass (M0 checklist).

Run as written, `buf lint` reports 32 violations across four rules:

| Rule | Why the verbatim contract trips it |
|---|---|
| `PACKAGE_DIRECTORY_MATCH` | package `switchpay.bank.v1` is in `bank/v1`, not `switchpay/bank/v1` |
| `RPC_REQUEST_STANDARD_NAME` | `Debit(MoneyOperationRequest)`, `GetChaosConfig(google.protobuf.Empty)`, ... |
| `RPC_RESPONSE_STANDARD_NAME` | `GetJournal` returns `Journal`, `GetTransfer` returns `Transfer`, ... |
| `RPC_REQUEST_RESPONSE_UNIQUE` | `Debit` and `Credit` share `MoneyOperationRequest`; `SetChaosConfig` takes and returns `ChaosConfig` |

The spec plainly intended lint to pass ("enum values are prefixed so `buf lint`
passes"), so these are oversights, not choices.

## Decision

Keep `STANDARD` and add an `except` list naming exactly those four rules. The contracts
stay byte-for-byte as specified and the directory layout stays as specified. Every
other `STANDARD` rule (enum zero values and prefixes, field naming, service suffix,
package versioning, and so on) remains enforced.

## Consequences

- Generated TypeScript names are exactly what later sections of the spec expect
  (`MoneyOperationRequest`, `Account`, `Transfer`, ...), so nothing downstream changes.
- Shared request types (`MoneyOperationRequest` for both `Debit` and `Credit`) mean a
  future field added for one RPC appears on the other. Accepted: the two operations are
  deliberately symmetric, and `buf breaking` (`FILE`) still guards compatibility.
- Any new `.proto` file is held to the same reduced set; there is no per-file override.

## Alternatives considered

- **Rename messages to `DebitRequest`/`DebitResponse` and so on.** Passes lint without
  exceptions, but breaks "verbatim" and changes every generated type name that sections
  6 to 8 reference. Rejected: larger deviation.
- **Move files to `proto/switchpay/bank/v1/`.** Fixes only one of the four rules and
  breaks the section 3 layout. Rejected.
- **Drop to the `MINIMAL` or `BASIC` category.** Silences these, but also silently drops
  every other STANDARD rule. Rejected: less strict than naming the four exceptions.
