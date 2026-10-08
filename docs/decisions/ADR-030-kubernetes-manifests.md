# ADR-030 — Kubernetes manifests: details section 19 leaves open

- **Status:** Accepted
- **Date:** 2026-10-08
- **Milestone:** P2-6 (phase 2, item 6)
- **Type:** Clarification, plus additions beyond the spec's one line (network policies, a test project)

## Context

Section 19, item 6: "**Kubernetes manifests** for `kind` or `minikube` (optional)." That is
all the spec says. Compose (section 15) is the reference deployment, and every rule of the
design still applies: one database per service (ADR-007), nothing durable in memory, the
Orchestrator's recovery by lease and `SKIP LOCKED` across instances (ADR-008), and a
timeout is never a failure. The manifests have to keep all of that and must not drift from
Compose as Compose changes.

## Decisions

| Topic | Decision | Why |
|---|---|---|
| Target | **kind** (`deploy/kind/cluster.yaml`, one node). Plain manifests with a `kustomization.yaml`, rendered with `kubectl kustomize --load-restrictor LoadRestrictionsNone deploy/k8s` and applied (`npm run k8s:up`). No Helm | kind runs in CI as easily as on a laptop. `kubectl` has kustomize built in, so nothing else is needed. The manifests also work on minikube (`minikube image load`, `minikube service gateway`) |
| Parity with Compose | Every value is copied from `docker-compose.yml`, and `tests/unit/k8sManifests.test.ts` (part of `npm test`) parses both files and requires: a workload per Compose service; each application container's environment equal to Compose's, **value for value**; the same ports; the same readiness checks; init containers that wait for exactly the Compose `depends_on`; `initBankDbs.sql` byte for byte | Service names are the Compose names, so even hostnames in URLs are identical. A variable added to Compose and not here fails the unit tests |
| One image | The repository `Dockerfile`, built once as `payment-switch:dev`. Each pod sets `SERVICE` (the Dockerfile's `CMD` reads it at run time). `imagePullPolicy: Never`, because kind loads the image | One build instead of six. `Never` guarantees a same-named image is never pulled from a registry |
| Configuration | Per service: a ConfigMap for plain values and a Secret for `DATABASE_URL` (and the Gateway's `JWT_SECRET`, `API_CLIENTS`), both through `envFrom` | Stricter than putting passwords in a ConfigMap. The values are Compose's development values; a real deployment injects its own Secrets |
| Startup order | Init containers mirror Compose `depends_on`: TCP for a Postgres, Redis or Kafka dependency, `GET /readyz` through the Service for a Node service | Compose's "starts after (healthy)" table (section 15), kept. Without it, services would crash-loop until their database is up |
| Probes | Startup and liveness on `/healthz`, readiness on `/readyz` (section 15). Infrastructure keeps its Compose checks (`pg_isready -h 127.0.0.1`, `redis-cli ping`, `kafka-broker-api-versions.sh`) | The same health semantics as Compose |
| Replicas | **Two Orchestrators** and two Gateways and two Ledgers; one of each bank, one Notification, one Reconciliation | Two Orchestrators are the point: leases, `SKIP LOCKED` claims, the `SKIP LOCKED` outbox relay and compare-and-set on `version` were designed for several instances, and Compose only ever runs one. `INSTANCE_ID` is the pod name (the lease owner). A bank keeps chaos settings in its process, so a second replica would answer differently. Notification blocks a partition while it retries (ADR-026) |
| State | Postgres and Kafka are StatefulSets with volume claims; Redis keeps only rate-limit buckets and has none, as in Compose. `PGDATA` is a subdirectory of the volume | Compose named volumes, in Kubernetes form. A volume's root may hold `lost+found`, which `initdb` refuses |
| Kafka | Compose's settings minus the `EXTERNAL` host listener (advertised `kafka:9092` only), a headless Service with `publishNotReadyAddresses`, and a 512 MB heap | Kafka hands clients its advertised address, and nothing outside the cluster needs the broker. The broker reaches its own controller and advertised address before its readiness probe can pass |
| Network policies | **Added.** Deny all ingress, then allow exactly the edges of the architecture: each Postgres only from the service whose `DATABASE_URL` names it, Redis only from the Gateway, Kafka from the Orchestrator and Notification, the Orchestrator's gRPC only from the Gateway, Ledger and bank gRPC from the Orchestrator and Reconciliation. HTTP ports (probes, `/metrics`, the public API) stay open | Compose has one flat network, so database-per-service (ADR-007) is only a coding rule there. Here the cluster enforces it, and the k8s test proves a foreign database is unreachable |
| Requests | Small CPU requests (Postgres 50m, Kafka 100m, services 25m, Redis 10m; 610m in all) and **no CPU limits**; memory requests and limits on every container. A unit test keeps the total under 700m CPU and 4 GiB | GitHub's runner has 2 CPUs and kind's control plane requests about 950m. The first CI run requested 1,325m more, and the scheduler left three Postgres pods unscheduled. Requests only steer scheduling, and without CPU limits nothing is throttled |
| Observability (P2-4) | Jaeger, Prometheus and Grafana as Deployments with Compose's images, arguments and health checks. Their files are **generated from the same files Compose mounts** (`configMapGenerator`s over `observability/`; `initBankDbs.sql` the same way), so no copy can drift; the parity test maps every Compose file mount to a generated key at the same container path. Prometheus alone gets its own config (`deploy/k8s/prometheus.yml`): Kubernetes pod discovery, keeping the `http` port, `job` from the app label, the same seven jobs and intervals as Compose (tested). Network policies: OTLP from the seven services only, Jaeger's query port and Prometheus from Grafana only | Compose scrapes `gateway:8080`; behind a Service with two replicas each scrape would hit a different pod and mix their counters. Pod discovery makes every replica a target, and the dashboard's `sum by (job)` queries still work |
| Hardening | Application pods: non-root (uid 1000), read-only root filesystem, all capabilities dropped, `RuntimeDefault` seccomp, no service account token. Every container has CPU and memory requests and a memory limit. The namespace enforces the `baseline` Pod Security Standard and warns on `restricted` | The applications write nothing to disk. Postgres and Kafka keep their images' own users |
| Exposure | Only the Gateway leaves the cluster: NodePort 30080, mapped by kind to `127.0.0.1:30080`. Everything else is `ClusterIP` or headless | As in a real deployment. Port 30080, not 8080, so the Compose stack and the cluster can run side by side |
| Proof | **Added** vitest project `k8s` (`npm run test:k8s`), with `kubectl port-forward` to non-Compose host ports. The test helpers already read every address from the environment, so the invariant code is the same as the chaos tests'. It checks pod readiness, the network policies, SUCCESS, replay, FAILED and REVERSED through the NodePort, a SIGKILL of the Orchestrator holding the most leases (I1–I10 hold, and another instance finishes its transfers), then an unscoped `npm run invariants` | "Manifests that apply" proves little. This shows the design's multi-instance claims on a real scheduler |
| Scripts | `npm run k8s:up` (create the cluster if missing, build, `kind load`, apply, wait for every rollout), `npm run k8s:down` (delete the cluster: the full reset, like `stack:down`) | One command each way, like the Compose scripts |

## Consequences

- `deploy/k8s` is a second description of the stack. The parity unit test is what keeps it
  honest: phase 2 items that change Compose (P2-4's tracing stack, for example) must change
  the manifests in the same commit, or `npm test` fails.
- The k8s project needs `kind` and `kubectl`, and is not part of `npm test` or the Compose
  CI jobs.
- A crash in the k8s test is a real SIGKILL of the container's process from the kind node
  (`crictl inspect` for its PID, then `kill -9`), followed by a forced pod delete so the
  replacement is a new instance. `kubectl delete pod --force --grace-period=0` alone is not
  a crash: it removes the API object, the kubelet still sends SIGTERM, and the Orchestrator's
  graceful shutdown finishes the in-flight transfers. The first run showed exactly that
  (200 × `201`, nothing for recovery to do), and the takeover assertion caught it.
- **When** to kill matters too. Choosing the victim 1 s after sending was flaky on GitHub's
  2-CPU runner: the victim held 2 leases, both finished during the second-long `crictl` lookup,
  and nothing was left to take over (run on `f8960e4`). The test now resolves both
  Orchestrators' PIDs before sending, waits until one holds at least 20 live leases, and kills
  it at once.
- gRPC multiplexes requests over one HTTP/2 connection, so a ClusterIP Service balances
  connections, not requests: each Gateway pod sticks to one Orchestrator. In the measured runs
  all 200 in-flight transfers sat on one instance. Request-level balancing (client-side
  round-robin over a headless Service, or a mesh) is the step M8 named for horizontal scaling;
  it is not built, and no throughput number is claimed for two replicas.
- Network policies rely on the CNI. kindnet enforces them; a cluster whose CNI does not
  would silently allow everything. The k8s test fails on such a cluster, by design.

## Alternatives considered

- **Helm chart.** Templating adds a language and hides the values the parity test compares.
  The stack has one environment, so there is nothing to parameterize.
- **One Postgres for everything in Kubernetes.** It violates ADR-007.
- **One image per service.** Six builds of identical content. The Dockerfile already picks
  the service at run time.
- **Compose's `EXTERNAL` Kafka listener through a NodePort.** Only tests used it, and the k8s
  tests read Kafka's effects in the databases instead.
- **No network policies.** Simpler, but it leaves database-per-service unenforced, which is
  the one rule that Kubernetes can enforce and Compose cannot.
