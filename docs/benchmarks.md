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
