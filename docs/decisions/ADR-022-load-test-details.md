# ADR-022 — Load test and seed details section 16 leaves open

- **Status:** Accepted
- **Date:** 2026-10-06
- **Milestone:** M8
- **Type:** Clarification (tooling only; no service change)

## Decisions

| Topic | Decision | Why |
|---|---|---|
| API clients | `load/transfer.k6.js` spreads iterations round-robin over the four development clients from `docker-compose.yml` | Each client has its own token bucket (`RATE_LIMIT_RPS = 100`). At 200 iterations/s, one client would get about half its requests rejected with 429, and the run would measure the rate limiter instead of the switch. Four clients at 50/s each stay inside their limits |
| What counts as failed | `http.setResponseCallback(http.expectedStatuses(201, 202, 422))`, so `http_req_failed` counts anything else (429, 5xx, network) | §16: "status is 201, 202 or 422" is the check; a 422 business failure is a correct answer |
| Idempotency keys | `{LOAD_RUN}-{VU}-{n}`: unique per iteration and prefixed per run | Lets `npm run invariants -- --since` (or a key-prefix query) scope the check to exactly one run |
| `npm run seed` (no flag) | Demo accounts `ACC001`–`ACC005` on each bank, 10,000,000 paise (₹1,00,000) each | §17's quick start needs demo accounts, and §5's example body uses `ACC001`/`ACC002`. §16 only specifies the `--load` set |
| Seeding is idempotent | An existing account is reported and left untouched; its balance is never reset | Resetting a balance would create or destroy money outside the ledger |
| Extra data points | Besides the §16 scenario (200/s), the same script was run at 100/s and 75/s (`-e RATE=`) | 200/s saturated the stack, so a single row would not show where it meets the §16 targets. Every row is measured and recorded with its invariant check |
| k6 | v2.2.0, installed natively with `winget install k6` (the owner chose this over the Docker image), so `npm run load` works exactly as §15 writes it | No wrapper script needed |

## Consequences

- `docs/benchmarks.md` holds three measured rows (200, 100 and 75/s), each followed by a
  green scoped invariant check.
- The first saturation analysis (Orchestrator CPU-bound at about 130/s on this machine) is
  recorded there, not here, because it is a measurement, not a decision.
