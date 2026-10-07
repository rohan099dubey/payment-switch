-- Phase 2, item 3 (ARCHITECTURE.md section 19, ADR-027): the reconciliation service's own
-- database. One row per run, and one row per break key (bank, reference, operation).
CREATE TABLE reconciliation_runs (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  window_from      timestamptz NOT NULL,
  window_to        timestamptz NOT NULL CHECK (window_to > window_from),
  trigger          text        NOT NULL CHECK (trigger IN ('SCHEDULED', 'ON_DEMAND')),
  started_at       timestamptz NOT NULL DEFAULT now(),
  finished_at      timestamptz,
  statement_lines  integer,
  journals         integer,
  breaks_opened    integer,
  breaks_resolved  integer,
  open_breaks      integer,
  error            text
);

CREATE INDEX reconciliation_runs_scheduled_idx ON reconciliation_runs (window_to)
  WHERE trigger = 'SCHEDULED' AND finished_at IS NOT NULL AND error IS NULL;

CREATE TABLE reconciliation_breaks (
  bank_id        text        NOT NULL,
  reference_id   text        NOT NULL,
  operation      text        NOT NULL CHECK (operation IN ('DEBIT', 'CREDIT', 'REVERSE_DEBIT')),
  break_type     text        NOT NULL CHECK (break_type IN ('MISSING_IN_LEDGER', 'MISSING_AT_BANK', 'AMOUNT_MISMATCH')),
  bank_amount    bigint,
  ledger_amount  bigint,
  status         text        NOT NULL CHECK (status IN ('OPEN', 'RESOLVED')),
  first_seen_at  timestamptz NOT NULL DEFAULT now(),
  last_seen_at   timestamptz NOT NULL DEFAULT now(),
  resolved_at    timestamptz,
  PRIMARY KEY (bank_id, reference_id, operation),
  CONSTRAINT resolved_has_time CHECK ((status = 'RESOLVED') = (resolved_at IS NOT NULL))
);

CREATE INDEX reconciliation_breaks_open_idx ON reconciliation_breaks (first_seen_at) WHERE status = 'OPEN';
CREATE INDEX reconciliation_breaks_reference_idx ON reconciliation_breaks (reference_id);
