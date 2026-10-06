# ADR-005 — Idempotency stored on the transfer row, in three layers

- **Status:** Accepted
- **Date:** 2026-10-04 (from ARCHITECTURE.md)
- **Milestone:** M5

## Context

A retry must never move money twice. Retries are not an edge case here — they are the
designed response to `503`, `504`, a network error, and to any unknown outcome inside
the saga. The client is explicitly told to retry with the same `Idempotency-Key`, and
the recovery worker re-runs saga steps by design.

So every call that can move money has to be safe to repeat, at three different
boundaries.

## Decision

Three independent layers, each with its own key and its own **database constraint**.
None relies on application logic.

| Layer | Key | Enforced by | On duplicate |
|---|---|---|---|
| Client to Orchestrator | `(client_id, Idempotency-Key)` | `UNIQUE` on `transfers` | existing transfer returned, no second saga |
| Orchestrator to Bank | `(reference_id = transfer id, operation)` | primary key of `operations` | original bank result returned, balance moves once |
| Orchestrator to Ledger | `transfer:{id}:{leg}` | `UNIQUE` on `journals.idempotency_key` | original journal returned, entries inserted once |

Supporting rules:

- **Scope.** A key belongs to the authenticated client. The same string from two clients
  is two unrelated keys.
- **Fingerprint.** `request_hash = sha256Hex(canonicalJson(...))` over payer, payee,
  amount, currency and note. The same key with a different fingerprint is rejected
  `409 IDEMPOTENCY_KEY_REUSED` and never touches the existing transfer.
- **Replay returns current state, not a stored response.** A request that was `202
  PENDING` on the first call can return `SUCCEEDED` on the retry.
- **Internal keys are derived, never random.** Bank reference ids and ledger keys come
  from the transfer id, so a retry after a crash regenerates the identical key. This is
  what makes crash recovery work at all.
- **Concurrency** is arbitrated by the unique index. The winner drives the saga; the
  loser polls the row for up to `REPLAY_WAIT_MS` and returns the latest state. A replay
  never drives the saga.

## Consequences

- Idempotency keys live on the `transfers` row and are kept forever in phase 1. Expiry
  is out of scope; the table grows without bound, which is acceptable at this scale and
  would need revisiting in production.
- Because the key is stored with the transfer rather than in a separate cache, there is
  no TTL to tune and no second store to keep consistent.
- The response to a replay is computed fresh, so clients must tolerate the status
  changing between retries. The README has to say this explicitly.

## Alternatives considered

- **A dedicated `idempotency_keys` table with stored responses.** Lets a replay return
  the byte-identical original response, but needs TTL management and would return a
  stale `PENDING` after the transfer had already succeeded. Rejected.
- **Redis for idempotency.** Redis holds no money or transfer state in this design, by
  rule. An eviction would permit a double spend.
- **Random per-attempt bank reference ids.** Would break crash recovery entirely — the
  retry could not recognise its own earlier attempt.

## As built (checked in M9, 2026-10-07)

- All three layers are database constraints as listed. A replay polls the row every
  100 ms for up to `REPLAY_WAIT_MS` while the transfer is in flight, and never drives it.
- Proven by `tests/integration/idempotency.test.ts`: replay header, `409` on a different
  body, 50 concurrent duplicates, two clients with the same key, `202` then `200` on a
  later replay. The 10,000-transfer test sends 5% of its requests as concurrent
  duplicates and checks I7.
