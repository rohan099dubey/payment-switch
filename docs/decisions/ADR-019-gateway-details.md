# ADR-019 — Gateway: `@fastify/jwt` 10, and details section 5 leaves open

- **Status:** Accepted
- **Date:** 2026-10-06
- **Milestone:** M4
- **Type:** One **deviation** (§1, amends ADR-009) plus clarifications (no contract changes)

## 1. `@fastify/jwt` 10.2.2, not 9 (deviation, amends ADR-009)

ADR-009 picked Fastify 5 with `@fastify/jwt` v9. Installing v9.1.0 (its latest) pulls in
`fast-jwt` <= 6.2.3, and `npm audit` reports **2 critical** advisories against it:
GHSA-gmvf-9v4p-v8jc (auth bypass when the HMAC secret is empty), GHSA-rp9m-7r4c-75qg (a
cache-key collision returns another token's claims), GHSA-hm7r-c7qw-ghp6, GHSA-mvf2-f6gm-w987,
GHSA-cjw9-ghj4-fwxf and GHSA-3j8v-cgw4-2g6q. The only fixed line is `@fastify/jwt` 10
(`fast-jwt` ^6.2.4), which still targets Fastify `5.x`. Shipping an authentication library
with known critical advisories is not defensible, so the stricter option is v10.2.2. After
the switch, `npm audit` reports 0 vulnerabilities. No API used here changed between v9 and v10.

## 2. Clarifications

| Topic | Decision | Why |
|---|---|---|
| Fastify's own client errors (malformed JSON, empty body, non-JSON content type, body over 16 KiB) | 400 `VALIDATION_ERROR` in the standard envelope | §5's table has "invalid body → 400" and no 413/415 row; "anything else → 500" would be wrong for a client error |
| Unknown route | 404 `NOT_FOUND`, standard envelope | §5 says every error uses the envelope; `TRANSFER_NOT_FOUND` would be a lie |
| `X-Request-Id` | Kept only if it matches `^[A-Za-z0-9._:-]{1,128}$` (a UUID always does), otherwise replaced by a fresh UUID | A client header goes into every log line and the Orchestrator's metadata, so it must not be able to inject text |
| Token verification | HS256 only (an `alg: none` or HS512 token is refused); the `sub` must still be in `API_CLIENTS`; every 401 carries `WWW-Authenticate: Bearer` | Removing a client must revoke its live tokens, not wait up to 15 minutes |
| Secret comparison | Both sides are SHA-256 hashed, then compared with `crypto.timingSafeEqual`; an unknown `client_id` is still compared against a dummy secret | Raw `timingSafeEqual` throws on unequal lengths and so leaks the length; the dummy keeps both paths the same cost |
| Token lifetime | `exp = iat + JWT_TTL_SECONDS`, pinned by a unit test | `@fastify/jwt` reads a numeric `expiresIn` as **seconds**. The first draft passed milliseconds, which made tokens live for 10 days, and the test caught it |
| `API_CLIENTS` | Strict JSON, non-empty, unique `client_id` matching `^[A-Za-z0-9_.-]{1,64}$` (it becomes the Redis key `rl:{client_id}` and the Orchestrator `client_id`) | Fail fast on a bad config instead of on first login |
| 202 replay | Carries `Location` as well as `Idempotent-Replay: true` | A client that only sees the replay still needs to know where to poll |
| Rate-limit headers | `X-RateLimit-Remaining` on every allowed request, `0` plus `Retry-After` (whole seconds, at least 1) on a 429; no header when failing open | There is no truthful number to give without Redis |
| Redis client | `enableOfflineQueue: false`, `maxRetriesPerRequest: 0`, `commandTimeout: 250 ms` | The ioredis defaults *queue* commands while disconnected, so requests would hang instead of failing open |
| `EVALSHA` | The SHA-1 is computed locally from `tokenBucket.lua`; on `NOSCRIPT` the script is loaded once and the call retried | A Redis restart empties the script cache |
| `/readyz` | Redis `PING` plus `waitForReady` on the Orchestrator channel, at most 1 s | An idle channel is "not yet connected", not "broken" |
| Orchestrator down | A call returns 503 or 504 depending on the channel state (a stopped container's name stops resolving, so the call usually waits out its deadline and gets 504) | Both are mapped exactly as §5 says, and both mean "retry with the same key" |
| Logging | One `request completed` line per request (method, route template, status, `duration_ms`, `client_id`, `request_id`); none for `/healthz`, `/readyz`, `/metrics`; Fastify's own request logging is off | Fastify's default logs the raw URL and runs before auth; the route template keeps ids out of metric labels too |
| Compose credentials | `JWT_SECRET` and four `API_CLIENTS` are development values in `docker-compose.yml` | Same footing as the Postgres passwords there; a real deployment injects its own |

## Consequences

- `docs/CONTEXT.md` lists §1 under "Active deviations" next to ADR-009.
- Unit tests (`services/gateway/test`, using `app.inject` with fakes) pin every row above.
  The integration tests (`happyPath`, `validation`, `gateway`) check them against the stack.
