-- Phase 2, item 5 (ADR-029): balance snapshots, so GetBalance reads only the entries
-- after the latest snapshot.
--
-- A snapshot is an immutable checkpoint, not a running balance. It records each account's
-- debit and credit totals over every entry with id <= last_entry_id, it is never updated,
-- and nothing on the write path reads it. Balances stay derived from entries: a snapshot
-- only caches a prefix of the sum, and invariant I11 re-derives every snapshot from the
-- entries it covers.

CREATE TABLE balance_snapshots (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  last_entry_id  bigint      NOT NULL UNIQUE CHECK (last_entry_id > 0),
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE balance_snapshot_lines (
  snapshot_id   bigint        NOT NULL REFERENCES balance_snapshots (id),
  account_id    bigint        NOT NULL REFERENCES accounts (id),
  -- SUM over bigint is numeric in Postgres; totals can outgrow bigint long before entries do.
  debit_total   numeric(38,0) NOT NULL CHECK (debit_total >= 0),
  credit_total  numeric(38,0) NOT NULL CHECK (credit_total >= 0),
  PRIMARY KEY (snapshot_id, account_id)
);

-- Append-only, like journals and entries (0001, 0003).
CREATE TRIGGER balance_snapshots_append_only BEFORE UPDATE OR DELETE ON balance_snapshots
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER balance_snapshot_lines_append_only BEFORE UPDATE OR DELETE ON balance_snapshot_lines
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER balance_snapshots_no_truncate BEFORE TRUNCATE ON balance_snapshots
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER balance_snapshot_lines_no_truncate BEFORE TRUNCATE ON balance_snapshot_lines
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

-- At commit, a snapshot has exactly one line per account and its totals balance: the
-- ledger is zero-sum, so any correct prefix of it is too.
CREATE FUNCTION assert_snapshot_complete() RETURNS trigger AS $$
DECLARE
  sid      bigint;
  d        numeric;
  c        numeric;
  lines    bigint;
  accounts bigint;
BEGIN
  IF TG_TABLE_NAME = 'balance_snapshots' THEN
    sid := NEW.id;
  ELSE
    sid := NEW.snapshot_id;
  END IF;
  SELECT COALESCE(SUM(debit_total), 0), COALESCE(SUM(credit_total), 0), count(*)
    INTO d, c, lines FROM balance_snapshot_lines WHERE snapshot_id = sid;
  SELECT count(*) INTO accounts FROM accounts;
  IF lines <> accounts THEN
    RAISE EXCEPTION 'snapshot % has % lines for % accounts', sid, lines, accounts;
  END IF;
  IF d <> c THEN
    RAISE EXCEPTION 'snapshot % unbalanced: debits % credits %', sid, d, c;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER balance_snapshots_complete
  AFTER INSERT ON balance_snapshots
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_snapshot_complete();
CREATE CONSTRAINT TRIGGER balance_snapshot_lines_complete
  AFTER INSERT ON balance_snapshot_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_snapshot_complete();

-- The read path: one account's entries after a snapshot, as an index-only range scan.
CREATE INDEX entries_account_entry_idx ON entries (account_id, id) INCLUDE (direction, amount);
