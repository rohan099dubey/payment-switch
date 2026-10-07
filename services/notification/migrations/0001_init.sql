-- Phase 2, item 2 (ARCHITECTURE.md section 19, ADR-026): the notification service's own
-- database. `processed_events` is the dedupe table keyed by event id: the primary key,
-- not application logic, makes each event's outcome final exactly once.
CREATE TABLE processed_events (
  event_id      bigint      PRIMARY KEY,
  transfer_id   uuid        NOT NULL,
  event_type    text        NOT NULL,
  outcome       text        NOT NULL CHECK (outcome IN ('DELIVERED', 'DEAD_LETTERED')),
  attempts      integer     NOT NULL CHECK (attempts BETWEEN 1 AND 5),
  last_error    text,
  processed_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT delivered_has_no_error CHECK (outcome <> 'DELIVERED' OR last_error IS NULL)
);

-- One row per webhook call: durable proof of the retry count and the backoff spacing.
CREATE TABLE webhook_attempts (
  id            bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id      bigint      NOT NULL,
  attempt       integer     NOT NULL CHECK (attempt BETWEEN 1 AND 5),
  ok            boolean     NOT NULL,
  error         text,
  attempted_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX webhook_attempts_event_idx ON webhook_attempts (event_id, attempt);
