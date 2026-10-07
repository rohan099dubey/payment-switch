-- Phase 2, item 1 (ARCHITECTURE.md section 19): the transactional outbox.
-- A terminal transition inserts its event here in the same transaction as the state
-- change; the relay publishes unpublished rows to Kafka topic `transfer-events`.
-- Stricter than the spec's column list (ADR-025): NOT NULL everywhere but published_at,
-- a CHECK on the event types, and one event per transfer.
CREATE TABLE outbox (
  id            bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  aggregate_id  uuid        NOT NULL,
  event_type    text        NOT NULL CHECK (event_type IN (
                  'transfer.succeeded', 'transfer.failed', 'transfer.reversed', 'transfer.needs_manual_review')),
  payload       jsonb       NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  published_at  timestamptz NULL,
  -- Terminal states have no outgoing transitions, so a transfer has exactly one event.
  CONSTRAINT outbox_one_event_per_transfer UNIQUE (aggregate_id)
);

-- The relay's query only ever reads unpublished rows, in id order.
CREATE INDEX outbox_unpublished_idx ON outbox (id) WHERE published_at IS NULL;
