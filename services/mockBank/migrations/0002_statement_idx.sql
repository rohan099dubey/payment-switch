-- Phase 2, item 3 (ADR-027): GetStatement reads APPLIED operations in
-- (created_at, reference_id, operation) order.
CREATE INDEX operations_statement_idx ON operations (created_at, reference_id, operation)
  WHERE status = 'APPLIED';
