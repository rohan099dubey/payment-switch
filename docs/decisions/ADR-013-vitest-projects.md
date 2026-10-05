# ADR-013 — Test layers as vitest projects, not repeated `--dir`

- **Status:** Accepted
- **Date:** 2026-10-05
- **Milestone:** M0
- **Type:** **Deviation from ARCHITECTURE.md**

## Context

Section 15 defines `"test": "vitest run --dir packages --dir services"`. vitest's CLI
accepts `--dir` once only, and the command fails before running anything:

```text
Error: Expected a single value for option "--dir <path>", received ["packages", "services"]
```

The intent is clear: unit tests from `packages/*/test` and `services/*/test`, no Docker,
and nothing from `tests/`.

## Decision

`vitest.config.mts` declares one project per test layer from section 16 (`.mts` because
the root package is CommonJS and the config is ESM):

| Project | Includes | Script |
|---|---|---|
| `unit` | `packages/*/test/**/*.test.ts`, `services/*/test/**/*.test.ts` | `test`: `vitest run --project unit` |
| `integration` | `tests/integration/**/*.test.ts` | `test:integration`: `vitest run --project integration` |
| `chaos` | `tests/chaos/**/*.test.ts` | `test:chaos`: `vitest run --project chaos` |

## Consequences

- `npm test` runs exactly the unit layer and cannot pick up an integration test, even
  one whose path happens to contain `packages` or `services`.
- Integration and chaos tests can later get their own timeouts and setup files per
  project without affecting unit tests.
- Script names and what each one runs are unchanged from the spec; only the mechanism
  differs.

## Alternatives considered

- **`vitest run packages/ services/`** (positional path filters). Works, but filters are
  substring matches against file paths, which is looser than a declared include.
  Rejected.
- **`--dir .` plus an include list in the config.** Puts all layers in one project, so
  `test:integration` would need its own filter and share unit-test settings. Rejected.
