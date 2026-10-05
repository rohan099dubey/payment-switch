# Benchmarks

> ## No numbers yet.
>
> This file is filled in at **M8**, from real `k6` runs against the Docker Compose
> stack. It is empty until then, and that is correct.
>
> **Every performance number quoted anywhere — README, resume, interview — comes from
> this file.** Never invent a number. Never round one up. Never quote a figure that is
> not recorded below with the machine and commit that produced it.
>
> A load number only counts if `npm run invariants` was green **after** the run. A
> throughput figure from a run that broke the books is not a throughput figure.

## How to produce a row

```bash
npm run stack:up
npm run seed -- --load        # creates L0001-L0200 per bank, 1,000,000,000 paise each
npm run load                  # k6: 200 iters/s for 2 min, 100 VUs (max 400)
npm run invariants            # MUST be green, or the row is void
```

Scenario is `constant-arrival-rate`. Each iteration posts a cross-bank transfer with a
unique `Idempotency-Key`, random accounts, amount 100–10000 paise. Checks accept status
201, 202 or 422.

Starting thresholds, with chaos **off**: `http_req_failed < 1%` and `p(95) < 500 ms`.
These are targets to tune towards, not guarantees.

## Results

| Date | Machine | Commit | Config | RPS | p50 | p95 | p99 | Error rate | Invariants green |
|---|---|---|---|---|---|---|---|---|---|
| — | — | — | — | — | — | — | — | — | — |

Record for each run: CPU and core count, RAM, whether Docker is on a VM or native,
chaos settings, `TRANSFER_COUNT`, and anything unusual about the run. A number without
its machine is not reproducible and therefore not quotable.

## Observations

Fill in at M8: where the bottleneck actually was, what was tuned, and what did not help.
This section is more interesting in an interview than the table is.
