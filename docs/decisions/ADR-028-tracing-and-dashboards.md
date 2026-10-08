# ADR-028 — Tracing and dashboards: details section 19 leaves open

- **Status:** Accepted
- **Date:** 2026-10-07
- **Milestone:** P2-4 (phase 2, item 4)
- **Type:** Clarification, plus one repository-layout addition (`observability/`)

## Context

Section 19, item 4: "**Tracing and dashboards.** OpenTelemetry (`@opentelemetry/sdk-node`
with gRPC, HTTP and `pg` instrumentation) exporting OTLP to Jaeger in Compose. Prometheus
and Grafana with committed dashboard JSON: throughput, latency, in-flight transfers,
recovery activity, injected chaos." The bootstrap order, the export protocol, sampling,
noise control, the dashboard contents and how they are verified are all open.

## Decisions

| Topic | Decision | Why |
|---|---|---|
| Bootstrap | `@switch/common/tracing`, a side-effect module behind a package subpath export, is the **first import** of every service's `main.ts`. It imports nothing else from `@switch/common`, whose index loads gRPC and pg | The SDK hooks a module only if it registers before that module is first required. Calling a function later in `main` would be too late in CommonJS |
| When it runs | Only when `OTEL_EXPORTER_OTLP_ENDPOINT` is set (Compose sets it); the standard variables `OTEL_SERVICE_NAME`, `OTEL_SDK_DISABLED` and `OTEL_TRACES_SAMPLER` apply | Unit tests and the integration tests' native processes run untraced, with no exporter errors |
| Instrumentations | gRPC (client and server), HTTP (server), and `pg` with **`requireParentSpan: true`**. `/healthz`, `/readyz` and `/metrics` are not traced | The recovery loop, the outbox relay and the reconciliation scheduler poll Postgres every second. Without the parent requirement, each poll is a root trace and the real traces drown. Probes and scrapes are not traffic |
| Export | OTLP over HTTP and protobuf to `jaeger:4318`, batched (the SDK default); traces are flushed during graceful shutdown | Asynchronous: a dead Jaeger drops spans, never requests. Nothing has `depends_on: jaeger` |
| Sampling | Always on (the SDK default), so every transfer is traced | Phase 1's load numbers were measured untraced. The tracing cost is measured and recorded as its own row in `docs/benchmarks.md`, never mixed into the old rows |
| Jaeger | `jaegertracing/jaeger:2.11.0` (v2, all in one), in-memory storage, UI and query API on 16686 | Development and CI only; traces do not survive a restart, by design |
| Prometheus | `prom/prometheus:v3.7.0`, `observability/prometheus/prometheus.yml`, 7 static jobs (one per service, `job` = service name), a 5 s scrape, 2 d retention | Static targets: the Compose network is fixed. 5 s keeps dashboards and tests responsive |
| Grafana | `grafana/grafana:12.2.0`, provisioned read-only: Prometheus and Jaeger datasources, and the dashboard `payment-switch` from `observability/grafana/dashboards/`. Anonymous viewers and a throwaway admin password, for development only | The committed JSON is the source of truth (`allowUiUpdates: false`) |
| Dashboard | 15 panels in groups: Throughput (requests by status, transfers by final state), Latency (p50/p95/p99 at the Gateway, saga step p95, transfer duration p95, downstream outcomes), In flight and recovery (in flight by state, recovery results, manual review, rate limiter), Injected chaos (chaos by bank and mode, bank operations), Events (outbox lag, notifications, open reconciliation breaks) | Section 19's five groups, plus the phase 2 pipeline |
| Verification | A unit test parses the dashboard: the five groups exist, every panel targets Prometheus, the grid has no overlaps, and **every metric a query uses is defined in a service's source** (a misspelt metric fails it). An integration test checks that all 7 targets are up, that **every dashboard query runs in Prometheus without error**, that Grafana serves the dashboard with a healthy datasource, and that one transfer is one trace across gateway, orchestrator, both banks and the ledger, with their Postgres spans | A dashboard nobody checks drifts into empty panels |
| Layout | A new top-level `observability/` directory for the Prometheus and Grafana configuration | Section 3 predates phase 2; this is config, not a service |

## Consequences

- Three more containers (Jaeger, Prometheus, Grafana), about 300 MB in total.
- Every request does some extra CPU work to record and export spans. Measured in
  `docs/benchmarks.md`.
- The dashboard is edited as JSON in the repository; changes made in the Grafana UI are
  not saved.

## Alternatives considered

- **An OpenTelemetry Collector between the services and Jaeger.** Useful for tail
  sampling or several backends; one more hop for no gain at this scale. Jaeger v2 accepts
  OTLP directly.
- **Ratio sampling.** It cheapens heavy load, but a sampled-out chaos failure would leave
  no trace to inspect. Always on, with the cost measured, is the stricter choice.
- **`--require` the bootstrap from the Dockerfile.** It also works, but the dependency
  would hide in the image instead of the code that relies on it.

## Amendment 1 (2026-10-08): a bounded Jaeger store, and the measured cost

**Jaeger's memory.** The Consequences above said the three containers take about 300 MB.
That was wrong for Jaeger. Its built-in configuration keeps up to **100,000** traces in
memory, and each transfer is one trace of about 64 spans, so after a day of tests Jaeger held
**2.56 GiB** of Docker Desktop's 7.35 GiB VM, and kept growing. Docker Desktop's engine
stopped twice during that period. The cause is not proven, but memory pressure is the
obvious candidate.

Decision: Compose runs Jaeger with `observability/jaeger/config.yaml`. That file is the
image's own configuration (`cmd/jaeger/internal/all-in-one.yaml` at `v2.11.0`) with **one**
change, `max_traces: 10000`. Measured with 13,501 transfers at 50/s after the change: Jaeger
peaked at 770 MiB while filling, fell once eviction began, and settled at 393 MiB (0 errors,
I1–I10 hold). The latest 10,000 traces are always enough to inspect any recent transfer or
chaos failure. A unit test (`tests/unit/dashboards.test.ts`) checks that Compose mounts the
file and that the limit is 10,000.

**The cost of tracing**, measured as this ADR required (`docs/benchmarks.md`, "Tracing
cost"): about +26 % CPU per transfer across the services and +25 % on the Orchestrator, and
about +8 ms median latency at 50/s. Sampling stays always on: development and CI run well
below the knee. Lowering `OTEL_TRACES_SAMPLER` is the lever if a higher-rate run ever needs
it, and it is an environment variable, not a code change.
