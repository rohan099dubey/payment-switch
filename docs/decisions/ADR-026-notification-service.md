# ADR-026 — Notification service: details section 19 leaves open

- **Status:** Accepted
- **Date:** 2026-10-07
- **Milestone:** P2-2 (phase 2, item 2)
- **Type:** Clarification

## Context

Section 19, item 2: "**Notification service** (`services/notification`). Kafka consumer
group `notification`, a dedupe table keyed by event id, a simulated webhook call with
exponential-backoff retries, and a dead-letter topic `transfer-events.dlq` after 5 failed
attempts." It consumes the events P2-1 publishes (ADR-025): at-least-once delivery, with
`event_id` in the header `event-id` and in the value. The rest is open. The rule for an
ambiguity is the stricter option.

## Decisions

| Topic | Decision | Why |
|---|---|---|
| Its own database | `notification_db` in a **dedicated** container, `postgres-notification` (host port 5436) | ADR-007: every service owns its database, and only the mock banks (external stand-ins) share a container. This service is part of the switch |
| Dedupe table | `processed_events(event_id bigint PRIMARY KEY, transfer_id uuid, event_type, outcome DELIVERED or DEAD_LETTERED, attempts, last_error, processed_at)`, written with `ON CONFLICT DO NOTHING` | Section 19 says "keyed by event id". The primary key, not application logic, arbitrates two consumers racing during a rebalance (the project's idempotency rule) |
| Processing order | (1) Skip if `event_id` is already in `processed_events` (counted as a duplicate). (2) Call the webhook, up to **5 attempts**, backing off `WEBHOOK_RETRY_BASE_MS * 2^(n-1)` (200, 400, 800, 1,600 ms). (3) Success: insert `DELIVERED`. All 5 failed: publish to `transfer-events.dlq`, **then** insert `DEAD_LETTERED`. (4) The offset is committed after the handler returns | Every step is safe to repeat. A crash before the insert redelivers the message, which repeats the webhook call (and the dead-letter publish). The webhook gets the event id as its `Idempotency-Key`, and dead-letter readers deduplicate by event id |
| Attempt log | `webhook_attempts(event_id, attempt, ok, error, attempted_at)`, one row per call | It is durable proof of the retry count and the backoff spacing, which the tests check. A real system needs this audit trail anyway |
| The simulated webhook | An in-process `WebhookPort` with a simulated implementation. A delivery fails when (a) the payee account id starts with `whfail-` (every attempt), (b) it starts with `whflaky-` (the first 2 attempts only), or (c) a seeded random draw is below `WEBHOOK_FAILURE_RATE` (default 0, seed `WEBHOOK_SEED`, mulberry32 as in the mock banks). Optional `WEBHOOK_LATENCY_MS` | Section 19 says "simulated". The account-id rules are deterministic, so tests can force "always fails" and "recovers on attempt 3" through the public API without a test-only control endpoint. The random rate exists for chaos runs. A real HTTP adapter would implement the same port |
| Dead letters | Topic `transfer-events.dlq`, key = transfer id, value = the original event, headers `event-id`, `event-type`, `dlq-reason`, `attempts`. The idempotent producer uses `acks=all`. The service creates both topics at startup if they are missing | Nothing is lost: the reason and the attempt count travel with the event |
| Malformed message | No valid `event-id`: published straight to the dead-letter topic with `dlq-reason: INVALID_MESSAGE`, then committed | Retrying a message that can never be processed would block the partition forever |
| Consumer | kafkajs 2.2.4, `groupId: notification`, `fromBeginning: true` (a new group reads the whole topic, so no event published before the service first started is skipped), one message at a time per partition, offsets committed after the handler | At-least-once, as section 19 says. One at a time keeps "dedupe, then act" simple and correct |
| Ports | HTTP 9103 for `/healthz`, `/readyz` (the database answers **and** the consumer has joined the group), `/metrics`. No gRPC | Nothing calls the service: it is a pure consumer |
| Metrics | `notifications_total{outcome}` (`delivered`, `dead_lettered`, `duplicate`, `invalid`), `webhook_attempts_total{result}` (`ok`, `failed`) | What an operator watches |
| Invariant **I9** | Every **published** outbox event has exactly one `processed_events` row once the stack is quiet. It is `DELIVERED` unless the payee's account id starts with `whfail-`, the only rule that always fails. Checked by `npm run invariants` (unscoped and `--since`) and by both chaos tests, which wait for the consumer to catch up first | It extends the proof one hop further: an event committed with a transfer reaches its outcome exactly once. Delivery itself is at-least-once; the record is exactly once |

## Consequences

- One more Postgres container and one more Node service in the stack and in CI.
- Blocking retries hold up the partition for at most 3 s (200 + 400 + 800 + 1,600 ms) per
  failing event, so later events wait. That is fine at this scale, and it keeps per-key
  order. A production system would park the event in a retry topic instead.
- The webhook is simulated, so "delivered" means the simulation accepted it. The port is
  where a real HTTP client would go.

## Alternatives considered

- **A separate mock-merchant HTTP service as the webhook target.** More realistic, but a
  sixth deployable with its own control API, only to say yes or no. Section 19 says
  "simulated".
- **A retry topic instead of blocking retries.** Better at scale; more topics and
  consumers than section 19 asks for.
- **Dedupe in Redis.** It could evict entries and so allow a double delivery. Section 19
  says "a dedupe table", and durable state lives in Postgres.
