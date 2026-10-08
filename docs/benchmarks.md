# Benchmarks

Every performance number quoted anywhere (README, resume, interview) comes from this
file. Each row is one measured k6 run, with the machine and commit that produced it.
A row only counts if `npm run invariants` was green **after** the run; every row below was.

## How to produce a row

```bash
npm run stack:up
npm run seed -- --load        # creates L0001-L0200 per bank, 1,000,000,000 paise each
npm run load                  # k6: 200 iters/s for 2 min, 100 VUs (max 400)
npm run invariants -- --since <run start>   # MUST be green, or the row is void (ADR-021)
```

Scenario is `constant-arrival-rate`. Each iteration posts a cross-bank transfer with a
unique `Idempotency-Key`, random accounts, amount 100–10000 paise. Checks accept status
201, 202 or 422.

Starting thresholds, with chaos **off**: `http_req_failed < 1%` and `p(95) < 500 ms`.
These are targets to tune towards, not guarantees.

## Results

All runs: 2026-10-06, chaos **off**, the k6 scenario from `load/transfer.k6.js`
(`constant-arrival-rate`, 2 minutes, 100 pre-allocated VUs, at most 400), cross-bank
transfers between random `L0001`–`L0200` accounts, 100–10000 paise. "RPS" is completed
transfer requests per second as k6 measured it; latency is `http_req_duration` for
`POST /v1/transfers`; errors are any status other than 201, 202 or 422.

| Date | Machine | Commit | Config | RPS | p50 | p95 | p99 | Error rate | Invariants green |
|---|---|---|---|---|---|---|---|---|---|
| 2026-10-06 | A (below) | `9f985fa` | target 200/s (spec scenario) | **129.7** (8,233 iterations dropped: saturated, 400 VUs in use) | 3.05 s | 3.37 s | 3.51 s | 0.00 % (0 of 15,772) | yes: 15,768 transfers, I1–I6 |
| 2026-10-06 | A | `9f985fa` | target 100/s | **99.97** (none dropped) | 85.4 ms | 564.1 ms | 792.2 ms | 0.00 % (0 of 12,005) | yes: 12,001 transfers, I1–I6 |
| 2026-10-06 | A | `9f985fa` | target 75/s | **74.99** (none dropped) | 71.9 ms | 95.7 ms | 132.4 ms | 0.00 % (0 of 9,004) | yes: 9,000 transfers, I1–I6 |

Invariants were checked with `npm run invariants -- --since <run start>` (ADR-021). Each
run's transfers ended `SUCCESS` (the load accounts hold 1,000,000,000 paise, so none ran
short).

**Machine A:** AMD Ryzen 7 7840HS (8 cores, 16 threads), 15.2 GB RAM, Windows 11 Home
10.0.26300. Docker Desktop 29.6.1 on WSL2 (kernel 6.18.33.2-microsoft-standard-WSL2), with
16 CPUs and 7.4 GB visible to the VM. All nine containers ran on that VM (3 Postgres 16,
Redis 7, Gateway, Orchestrator, Ledger, two banks, one instance each, Node 22). k6
v2.2.0 ran natively on the same host, so load generation competed for the same CPU.
Configuration: every default from section 15 (`LOG_LEVEL=info`, `RATE_LIMIT_RPS=100` per
client, iterations spread over four API clients, ADR-022).

### Thresholds (section 16: `http_req_failed < 1%`, `p(95) < 500 ms`, chaos off)

| Target rate | `http_req_failed < 1%` | `p(95) < 500 ms` |
|---|---|---|
| 200/s | met (0.00 %) | **missed** (3.37 s): the stack saturates at about 130/s |
| 100/s | met (0.00 %) | **missed narrowly** (564 ms; p90 is 152 ms) |
| 75/s | met (0.00 %) | met (95.7 ms) |

## Observations

- **The bottleneck is one Orchestrator process's CPU.** Under the 200/s target,
  `docker stats` showed the Orchestrator container at 102–106 % CPU (one core, Node's
  single event loop) while everything else had headroom: Gateway 41 %, Ledger 40 %,
  each bank 20 %, `postgres-orchestrator` 77 %, Redis 3 %. Throughput settled where
  k6's 400 VUs divided by the ~3 s queueing latency meet: about 130/s (Little's law).
  Downstream steps were not slow: the mean bank step was ~10 ms and the mean ledger post
  ~10 ms (`saga_step_duration_seconds`).
- **Logging is not the cause.** A diagnostic 30 s run with the Orchestrator at
  `LOG_LEVEL=warn` (no per-transfer log lines) gave the same 131/s, with the Orchestrator
  still at 102 % CPU. Section 17 requires those lines anyway, so `info` stays.
- **The CPU is spread out, with no single hotspot.** A V8 CPU profile of the same build
  running natively under load attributed self time to socket writes (`writev` +
  `writeBuffer`, ~14 %, shared by gRPC, Postgres and stdout), grpc-js plus HTTP/2 (~14 %),
  `pg` + `pg-protocol` (~6 %) and pino plus redaction (~5.5 %). Per transfer that is one
  inbound gRPC call, four outbound ones and about 24 Postgres round trips (insert plus five
  compare-and-set transactions of BEGIN / UPDATE / INSERT event / COMMIT). Natively the
  process still had ~30 % idle at that rate; inside the WSL2 VM the same work fills a core
  at about 7.7 ms of CPU per transfer.
- **The p95 tail at 100/s** (564 ms against a 152 ms p90) is a minority of slow requests
  near the knee. At 75/s it disappears (p99 132 ms).
- **What would raise the ceiling** (not done; outside M8's scope): more Orchestrator
  instances, which the design already supports (leases, `SKIP LOCKED`, CAS), behind
  round-robin gRPC load balancing in the Gateway; or fewer Postgres round trips per
  state change. Neither was tried, so no number is claimed for them.

## Tracing cost (P2-4, ADR-028)

Measured 2026-10-08 on machine A, commit `0d30bb5` (the images were built from that source),
with the whole phase 2 stack running: 17 containers (the nine above plus Kafka, the
notification and reconciliation services with their Postgres, Jaeger, Prometheus and
Grafana). Same k6 scenario and accounts as above, chaos **off**, at **50/s**, a rate both
modes sustain. "Tracing on" is the Compose default (every request traced, exported to
Jaeger). "Off" sets `OTEL_SDK_DISABLED=true` on the seven services, with the same images.

Method, the same for every run, alternating off / on / off / on: force-recreate the seven
services; `VACUUM ANALYZE` the Orchestrator, Ledger and both bank databases; a 90 s warm-up
at 50/s; a 20 s pause; then the measured 2 minutes. Each run's invariants were checked from
the start of its warm-up (4,500 warm-up plus 6,000 measured transfers).

| Date | Machine | Commit | Config | RPS | p50 | p95 | p99 | Error rate | Invariants green |
|---|---|---|---|---|---|---|---|---|---|
| 2026-10-08 | A | `0d30bb5` | 50/s, tracing **off** (run 1) | **49.97** (none dropped) | 53.9 ms | 80.8 ms | 106.5 ms | 0.00 % (0 of 6,004) | yes: 10,500 transfers, I1–I6, I8–I10 |
| 2026-10-08 | A | `0d30bb5` | 50/s, tracing **on** (run 2) | **49.98** (none dropped) | 59.6 ms | 82.6 ms | 95.7 ms | 0.00 % (0 of 6,004) | yes: 10,500 transfers, I1–I6, I8–I10 |
| 2026-10-08 | A | `0d30bb5` | 50/s, tracing **off** (run 3) | **49.98** (none dropped) | 49.7 ms | 73.0 ms | 83.9 ms | 0.00 % (0 of 6,005) | yes: 10,502 transfers, I1–I6, I8–I10 |
| 2026-10-08 | A | `0d30bb5` | 50/s, tracing **on** (run 4) | **49.97** (none dropped) | 60.6 ms | 86.7 ms | 102.1 ms | 0.00 % (0 of 6,005) | yes: 10,502 transfers, I1–I6, I8–I10 |

CPU time per transfer in the measured window: each service's `process_cpu_seconds_total`
increase divided by the `transfers_total` increase, read from Prometheus at the window's
edges (Jaeger's own CPU is not included; `docker stats` sampled it at 2–9 % of a core).

| Run | Gateway | Orchestrator | Ledger | Bank A | Bank B | Notification | Reconciliation | **Total** |
|---|---|---|---|---|---|---|---|---|
| 1 off | 2.25 ms | 10.32 ms | 3.21 ms | 1.50 ms | 1.50 ms | 1.41 ms | 0.09 ms | **20.30 ms** |
| 2 on | 2.54 ms | 12.53 ms | 4.20 ms | 1.89 ms | 1.90 ms | 1.43 ms | 0.10 ms | **24.59 ms** |
| 3 off | 2.17 ms | 9.62 ms | 2.98 ms | 1.43 ms | 1.40 ms | 1.27 ms | 0.09 ms | **18.95 ms** |
| 4 on | 2.80 ms | 12.48 ms | 4.17 ms | 1.95 ms | 2.03 ms | 1.45 ms | 0.10 ms | **24.97 ms** |

**What tracing costs:** about **+26 % CPU per transfer** across the services (19.6 ms to
24.8 ms, means of the two pairs) and **+25 % on the Orchestrator** (10.0 ms to 12.5 ms), whose
single event loop is the bottleneck. The median latency rises by about **8 ms** (51.8 to
60.1 ms). At 50/s the p95 and p99 do not separate from run-to-run noise. Notification is
unchanged: it uses Kafka, which is not instrumented, and makes no traced calls.

**Consequence at higher rates:** with tracing on, 75/s is at the Orchestrator's knee. A 75/s
run on 2026-10-07 (session 4), started 30 s after the services were recreated, saturated the
Orchestrator (1.0–1.35 CPU-seconds per second, event-loop lag p99 1.34 s) and never cleared
the backlog left by its cold start: 42.8/s completed, 13 % Gateway `504`s. All 7,313
transfers still finished correctly through recovery, and I1–I10 held. That run is not a
row, because its cold start is what decided the result. The same cold-start effect explains
the inconclusive A/B recorded in `SESSION_LOG.md` (session 3), where the tracing-off run
came out slower. This is why the method above warms up for 90 s. Phase 1's 75/s and 100/s
rows were measured without tracing (and before phase 2's services existed); they are not
comparable with this section.

## Balance snapshots (P2-5, ADR-029)

Measured 2026-10-08 on machine A with `npm run bench:balance` (`scripts/benchBalance.ts`):
sequential gRPC calls from the host to the Ledger after 10 warm-up calls, so these are
per-call latencies with no queueing. 200 `GetBalance('transit')` calls (`transit` is the
account every transfer touches), then 50 `GetTrialBalance` calls. The full 17-container
stack was running, plus the P2-6 session's kind cluster (both measurements).

| Date | Machine | Ledger build | Ledger state | `GetBalance('transit')` p50 / p95 / p99 | `GetTrialBalance` p50 / p95 / p99 |
|---|---|---|---|---|---|
| 2026-10-08 | A | `026102f` (no snapshots) | 955,286 entries (477,653 on `transit`), quiet | 87.12 / 99.22 / 104.85 ms | 214.58 / 232.05 / 238.38 ms |
| 2026-10-08 | A | P2-5 | 956,502 entries, 0 after the latest snapshot, quiet | **4.40 / 7.11 / 9.47 ms** | **4.31 / 5.66 / 5.98 ms** |
| 2026-10-08 | A | P2-5 | 976,016–976,430 entries, **8,762–9,104 after a ~40 s-old snapshot**, during a 50/s k6 load | **5.41 / 8.12 / 10.82 ms** | **6.57 / 8.58 / 10.52 ms** |

The load run (7,493 transfers, 0 errors) passed `npm run invariants -- --since
2026-10-08T10:08:13Z`, I1–I6 and I8–I11, including I11 over all 41 development snapshots.

**What it shows:** `GetBalance('transit')` went from 87 ms to 4–5 ms, and `GetTrialBalance`
from 215 ms to 4–7 ms. A read now sums only the entries after the latest snapshot (the
integration test checks the query plan reads exactly those), so its cost follows that
delta, not the size of the ledger. With a snapshot every minute the delta stays below about
12,000 entries at 50 transfers/s (arithmetic, not a measurement: 60 s × 50 transfers × 4
entries for a successful transfer).
