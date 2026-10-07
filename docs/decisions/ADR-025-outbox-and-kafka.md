# ADR-025 — Transactional outbox and Kafka: details section 19 leaves open

- **Status:** Accepted
- **Date:** 2026-10-07
- **Milestone:** P2-1 (phase 2, item 1)
- **Type:** Clarification, with one stricter-than-spec choice (an event for every terminal state)

## Context

Section 19, item 1, fixes the shape: migration `0002_outbox.sql` with
`outbox(id, aggregate_id, event_type, payload, created_at, published_at)`, an event
inserted by each terminal transition **in the same transaction**, a relay loop
(`SELECT ... WHERE published_at IS NULL ORDER BY id LIMIT 100 FOR UPDATE SKIP LOCKED`,
publish, set `published_at`), topic `transfer-events` keyed by transfer id, `kafkajs` with
an idempotent producer and `acks=all`, at-least-once delivery with consumers
deduplicating by event id, and a single-node KRaft Kafka in Compose. Everything else is
open. The rule for an ambiguity is the stricter option (CLAUDE.md).

## Decisions

| Topic | Decision | Why |
|---|---|---|
| Which transitions emit | **Every** terminal state: `SUCCESS` → `transfer.succeeded`, `FAILED` → `transfer.failed`, `REVERSED` → `transfer.reversed`, **and** `NEEDS_MANUAL_REVIEW` → `transfer.needs_manual_review` | Section 19 says "terminal transitions" and lists three examples. A transfer sent to manual review is the one an operator most needs to hear about, so leaving it out would be the looser reading |
| Table | The spec's six columns, with `NOT NULL` on all but `published_at`, `created_at DEFAULT now()`, a `CHECK` on the four event types, **`UNIQUE (aggregate_id)`**, and a partial index on `id WHERE published_at IS NULL` | Terminal states have no outgoing transitions, so a transfer has exactly one terminal event, and the database enforces that like every other invariant here. The partial index keeps the relay query cheap as published rows pile up. A future non-terminal event type would need a migration that relaxes the unique key |
| Same transaction | `casTransition` inserts the outbox row after the CAS `UPDATE` and the `transfer_events` insert, in the same `withTransaction`, with the payload built from the row the `UPDATE` returned | Section 19. A rolled-back CAS writes no event, and a committed one always has its event. Postgres `now()` is the transaction start, so the outbox row's `created_at` equals the terminal event's `created_at`. The integration test checks exactly that |
| Event id | `outbox.id`, a decimal string, sent as the Kafka header `event-id` and as `event_id` in the value | Section 19: "consumers deduplicate by event id". The bigint identity is unique and never reused |
| Message | Topic `transfer-events`; key = transfer id; headers `event-id`, `event-type`; value = JSON `{event_id, event_type, transfer_id, client_id, state, failure_code, amount, currency, payer, payee, occurred_at}` | **`amount` is a string of paise**: a JSON number would be a float in most consumers, which money must never be. `note` is left out: it is free text from the client and no consumer needs it |
| Relay | Runs in every Orchestrator instance, like recovery. Each iteration is one database transaction: claim up to 100 rows (the spec query), `send` them in one batch, `UPDATE outbox SET published_at = now()` for those ids, then commit. A failed send rolls back, so the rows stay unpublished and are retried. A full batch loops at once; otherwise the relay sleeps `OUTBOX_POLL_MS` (500). After a failure it backs off exponentially (up to 30 s) | `SKIP LOCKED` lets several instances share the work with no double claim. A crash after the send but before the commit republishes those events. That is the specified at-least-once delivery |
| A transaction open during the Kafka send | Accepted, because the spec's `FOR UPDATE` requires it. It is bounded by the producer's timeouts (connection 3 s, request 10 s, 3 retries), and the locks cover only outbox rows that nothing else writes | "Never hold a transaction across a gRPC call" (section 6) protects the saga's transfer rows. The relay never touches them |
| Producer | `kafkajs` 2.2.4, `idempotent: true`, `maxInFlightRequests: 1`, `acks: -1` (all), `DefaultPartitioner` (murmur2, as in the Java client), broker auto-create disabled. kafkajs warns that bounded retries "may invalidate EoS". That is expected: a failed send drops the producer and the batch is retried from the outbox, so delivery stays at-least-once, as specified. The relay creates the topic at startup (3 partitions, replication factor 1) if it is missing, retrying until it succeeds. kafkajs logs go to pino at `warn` | Section 19. An explicit topic means a misspelt topic fails loudly instead of creating a new one |
| Kafka version | **`apache/kafka:3.9.1`**, KRaft, single node | kafkajs 2.2.4 (the latest release, February 2023) predates Kafka 4.0, which removed several old protocol versions. 3.9.1 is the last 3.x line: it runs KRaft and still speaks every version kafkajs uses |
| Listeners | `kafka:9092` inside Compose, `localhost:9094` from the host (tests, a native second Orchestrator) | Kafka hands clients the advertised address, so each network needs its own |
| Coupling | **The Orchestrator does not depend on Kafka.** No `depends_on`, readiness ignores Kafka, and a relay failure only delays events | Payments must not stop because the event bus is down. Events wait in the outbox. A test stops Kafka, makes transfers, and checks they succeed and are published once Kafka returns |
| Config | `KAFKA_BROKERS` (default `kafka:9092`) and `OUTBOX_POLL_MS` (default 500); the topic name and batch size are fixed by the spec | The rest is in section 19 |
| Metrics | `outbox_published_total`, `outbox_publish_failures_total`, and the gauge `outbox_unpublished`, refreshed every relay iteration | The outbox lag is the one number an operator watches for this feature |
| Invariant **I8** | Every terminal transfer that reached its terminal state after `0002_outbox.sql` was applied has exactly one outbox event, of the type matching its state, whose payload names the same transfer and state. Once the stack is quiet, none is unpublished. Checked by `npm run invariants` and by both chaos tests | It extends the project's proof to the new guarantee. The cutoff is `schema_migrations.applied_at`: transfers that finished before the outbox existed never had an event, and history is not backfilled (a consumer should not receive months-old events as new) |

## Consequences

- An event is never lost: it is committed with the state change, and a row stays
  unpublished until the broker acknowledged it with `acks=all`. It may be delivered more
  than once, so consumers (phase 2, item 2) must deduplicate by `event_id`.
- Within one partition the order is the outbox order, and the key keeps a transfer on one
  partition. A transfer has only one event, so ordering across transfers has no meaning.
- One more container (about 400 MB of memory for the JVM) in the development stack and in CI.
- kafkajs is unmaintained. If it ever blocks an upgrade, the producer sits behind the
  relay's `EventPublisher` port, so another client is a one-file change.

## Alternatives considered

- **Publish straight from the saga after the commit.** It loses the event whenever the
  process dies between the commit and the send: the dual-write problem the outbox exists
  to remove.
- **Change data capture (Debezium) on `transfer_events`.** It needs no relay code, but it
  adds Kafka Connect, logical replication and a second source of truth for the event
  shape. Section 19 asks for an outbox table.
- **A lease column on `outbox` instead of holding `FOR UPDATE` across the send.** It
  would keep the transaction short, but it changes the spec's table and query for a lock
  that only the relay ever contends for.
