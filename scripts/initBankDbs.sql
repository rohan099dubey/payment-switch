-- Runs once, on first start of postgres-banks (docker-entrypoint-initdb.d).
-- One container, two databases: the mock banks stand in for external systems (ADR-007).
CREATE DATABASE bank_a;
CREATE DATABASE bank_b;
