-- Row-level triggers in 0001 do not fire on TRUNCATE, which would empty the ledger in
-- one statement. Close that gap with statement-level triggers (ADR-015).
CREATE TRIGGER journals_no_truncate BEFORE TRUNCATE ON journals
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER entries_no_truncate BEFORE TRUNCATE ON entries
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
