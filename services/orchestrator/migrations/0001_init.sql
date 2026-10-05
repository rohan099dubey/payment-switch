CREATE TABLE transfers (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id         text        NOT NULL,
  idempotency_key   text        NOT NULL,
  request_hash      text        NOT NULL,
  payer_bank_id     text        NOT NULL,
  payer_account_id  text        NOT NULL,
  payee_bank_id     text        NOT NULL,
  payee_account_id  text        NOT NULL,
  amount            bigint      NOT NULL CHECK (amount > 0),
  currency          char(3)     NOT NULL DEFAULT 'INR',
  note              text,
  state             text        NOT NULL CHECK (state IN (
                      'INITIATED','DEBIT_SENT','DEBITED','CREDIT_SENT','CREDITED',
                      'SUCCESS','FAILED','REVERSING','REVERSED','NEEDS_MANUAL_REVIEW')),
  failure_code      text,
  failure_message   text,
  version           integer     NOT NULL DEFAULT 1,
  attempts          integer     NOT NULL DEFAULT 0,
  next_attempt_at   timestamptz NOT NULL DEFAULT now(),
  lease_owner       text,
  lease_expires_at  timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT transfers_idempotency_uniq UNIQUE (client_id, idempotency_key)
);

CREATE INDEX transfers_recovery_idx ON transfers (next_attempt_at)
  WHERE state IN ('INITIATED','DEBIT_SENT','DEBITED','CREDIT_SENT','CREDITED','REVERSING');

CREATE INDEX transfers_state_idx ON transfers (state);

CREATE TABLE transfer_events (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  transfer_id  uuid        NOT NULL REFERENCES transfers (id),
  from_state   text,
  to_state     text        NOT NULL,
  reason       text        NOT NULL,
  detail       jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX transfer_events_transfer_idx ON transfer_events (transfer_id, id);
