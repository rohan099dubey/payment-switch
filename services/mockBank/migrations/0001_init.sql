CREATE TABLE accounts (
  account_id   text        PRIMARY KEY,
  holder_name  text        NOT NULL,
  balance      bigint      NOT NULL CHECK (balance >= 0),
  currency     char(3)     NOT NULL DEFAULT 'INR',
  status       text        NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','BLOCKED')),
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE operations (
  reference_id  text        NOT NULL,
  operation     text        NOT NULL CHECK (operation IN ('DEBIT','CREDIT','REVERSE_DEBIT')),
  status        text        NOT NULL CHECK (status IN ('APPLIED','VOIDED')),
  bank_txn_id   uuid        NOT NULL DEFAULT gen_random_uuid(),
  account_id    text,
  amount        bigint      CHECK (amount > 0),
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (reference_id, operation),
  CONSTRAINT applied_has_money CHECK (
    status = 'VOIDED' OR (account_id IS NOT NULL AND amount IS NOT NULL))
);

CREATE INDEX operations_account_idx ON operations (account_id, created_at);
