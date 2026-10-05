CREATE TABLE accounts (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code        text        NOT NULL UNIQUE,
  type        text        NOT NULL CHECK (type IN ('ASSET','LIABILITY')),
  currency    char(3)     NOT NULL DEFAULT 'INR',
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE journals (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key  text        NOT NULL UNIQUE,
  request_hash     text        NOT NULL,
  reference_id     text        NOT NULL,
  kind             text        NOT NULL,
  description      text,
  currency         char(3)     NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX journals_reference_idx ON journals (reference_id, created_at);

CREATE TABLE entries (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  journal_id  uuid        NOT NULL REFERENCES journals (id),
  account_id  bigint      NOT NULL REFERENCES accounts (id),
  direction   char(1)     NOT NULL CHECK (direction IN ('D','C')),
  amount      bigint      NOT NULL CHECK (amount > 0),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX entries_account_idx ON entries (account_id);
CREATE INDEX entries_journal_idx ON entries (journal_id);

-- Append-only: no UPDATE or DELETE, ever.
CREATE FUNCTION forbid_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'table % is append-only', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER journals_append_only BEFORE UPDATE OR DELETE ON journals
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER entries_append_only BEFORE UPDATE OR DELETE ON entries
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Every journal must balance, checked at commit time.
CREATE FUNCTION assert_journal_balanced() RETURNS trigger AS $$
DECLARE
  d bigint;
  c bigint;
BEGIN
  SELECT COALESCE(SUM(amount) FILTER (WHERE direction = 'D'), 0),
         COALESCE(SUM(amount) FILTER (WHERE direction = 'C'), 0)
    INTO d, c FROM entries WHERE journal_id = NEW.journal_id;
  IF d <> c THEN
    RAISE EXCEPTION 'journal % unbalanced: debits % credits %', NEW.journal_id, d, c;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER entries_balanced
  AFTER INSERT ON entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_journal_balanced();
