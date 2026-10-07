-- Phase 2, item 3 (ADR-027): ListJournalsByTime reads journals in (created_at, id) order.
CREATE INDEX journals_created_idx ON journals (created_at, id);
