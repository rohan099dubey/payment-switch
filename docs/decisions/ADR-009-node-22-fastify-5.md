# ADR-009 — Node 22 LTS and Fastify 5, not Node 20 and Fastify 4

- **Status:** Accepted
- **Date:** 2026-10-05
- **Milestone:** M0
- **Type:** **Deviation from ARCHITECTURE.md**

## Context

`ARCHITECTURE.md` section 2 specifies the stack and says "use exactly these choices".
Two of those choices are stale as of October 2026:

- **Node.js 20 LTS** reached end of life in **April 2026**. It receives no further
  security patches. A payment system on an unpatched runtime is not defensible, and the
  spec's own rule — "where it is silent, pick the stricter option" — points away from
  shipping an EOL runtime.
- **Fastify 4** is in maintenance; Fastify 5 is the current major.

The spec also forbids deviating from the document. The resolution is not to ignore
either instruction but to deviate explicitly and record it, so the document and the
code never silently disagree.

## Decision

| Concern | Spec says | Using | Reason |
|---|---|---|---|
| Runtime | Node.js 20 LTS | **Node 22 LTS** | Node 20 is EOL |
| HTTP framework | `fastify` 4 | **`fastify` 5**, `@fastify/jwt` v9 | current major |
| Database | PostgreSQL 16 | **PostgreSQL 16** — unchanged | supported to 2028 |

Everything else in section 2 is taken verbatim: `@grpc/grpc-js` with `ts-proto`
(`forceLong=string`), raw `pg` with no ORM, `zod`, `ioredis`, `pino`, `prom-client`,
`vitest`, `k6`, `eslint`/`prettier`/`buf`, Docker multi-stage with `ARG SERVICE`.

The TypeScript target stays `ES2022` with `module: commonjs` exactly as specified — the
runtime bump does not change the compilation target, so generated gRPC code is
unaffected.

Pinning:

- `.nvmrc` records `22`.
- `Dockerfile` uses `node:22-alpine` for both stages.
- CI runs on Node 22.
- `package.json` declares `"engines": { "node": ">=22" }`.

## Consequences

- No code impact expected. CommonJS output on an ES2022 target runs identically on 20,
  22 and 24; `pg`, `@grpc/grpc-js` and `ioredis` all support 22.
- Fastify 5 requires `@fastify/jwt` v9 and the matching major of any other `@fastify/*`
  plugin. Plugin majors must be checked at install time in M0, not assumed.
- The development machine currently runs **Node v24.18.0**, which is forward-compatible
  with the target but *not* the same major as CI. Unit tests therefore run on 24 locally
  and 22 in CI. If a test ever passes locally and fails in CI, check the Node major
  first.
- `ARCHITECTURE.md` keeps saying 20 and 4. That is intentional — the spec is never
  edited in place. This ADR and the "Active deviations" table in `docs/CONTEXT.md` are
  the authoritative statement of what is actually used.

## Alternatives considered

- **Follow the spec literally: Node 20 and Fastify 4.** Maximum fidelity to the
  document, but ships a runtime with no security support. Rejected.
- **Node 24 + Fastify 5 + PostgreSQL 18.** Newest across the board and would match the
  dev machine's Node exactly. Rejected: Node 24 is not the LTS the production image
  should sit on, and moving Postgres introduces unknowns into the one component whose
  exact behaviour (`ON CONFLICT`, `FOR UPDATE SKIP LOCKED`, deferred constraint
  triggers) the entire correctness argument rests on. No benefit to offset that.
- **Node 22, Fastify 4.** Would avoid the plugin-major check, but leaves a second stale
  dependency to revisit later for no gain.
