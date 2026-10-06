# ADR-006 — The rate limiter fails open

- **Status:** Accepted
- **Date:** 2026-10-04 (from ARCHITECTURE.md)
- **Milestone:** M4

## Context

The Gateway rate-limits each client with a token bucket held in Redis, implemented as a
Lua script run with `EVALSHA` so that check-and-decrement is atomic. Redis is a separate
process and can be unreachable.

When the limiter cannot reach Redis it must either reject the request (fail closed) or
allow it (fail open). The choice decides what a Redis outage does to the payment system.

## Decision

**Fail open.** If Redis is unreachable the limiter allows the request, logs a warning,
and increments `rate_limit_fail_open_total`.

Availability of payments beats strictness of limits. A rate limit exists to protect the
system from excessive load; it is not a correctness control. Failing closed would turn a
Redis outage into a total payment outage — converting a degraded-protection problem into
a complete loss of service.

Nothing about correctness depends on the limiter. Redis never stores money or transfer
state, and idempotency is enforced by Postgres constraints (ADR-005), so an unlimited
burst cannot cause a double spend. It can only cause load.

## Consequences

- A Redis outage means unlimited request rates until it recovers. The downstream
  services are protected by their own deadlines, connection pools and the Orchestrator's
  `SAGA_INLINE_BUDGET_MS`, not by the limiter.
- `rate_limit_fail_open_total` must be alerted on in any real deployment — it is the
  only signal that protection has silently stopped.
- An integration test is required for this path (M4): with Redis stopped, requests still
  succeed and the counter increments.

## Alternatives considered

- **Fail closed.** Safer for the backend, catastrophic for the product: a cache outage
  would stop all payments. Appropriate for an authentication or authorization check, not
  for a load control.
- **In-process fallback bucket.** Would keep approximate limiting during an outage, but
  per-instance counters do not compose across replicas, and it means durable-ish state
  in memory — against the project's rules. Possible future refinement, not phase 1.
- **Fail open only for a short grace period, then closed.** More defensible in
  production, but it adds a timer and a second failure mode to test for little benefit
  at this scale.

## As built (checked in M9, 2026-10-07)

- `services/gateway/src/plugins/rateLimit.ts`: the Lua token bucket runs with
  `EVALSHA` and Redis's own `TIME`; any Redis error lets the request through, logs a
  warning and increments `rate_limit_fail_open_total`.
- Proven by `tests/integration/gateway.test.ts`: with Redis stopped, transfers still
  succeed and the counter increments.
