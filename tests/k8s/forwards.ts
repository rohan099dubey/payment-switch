/**
 * How the `k8s` test project reaches the kind cluster (ADR-030). The Gateway is a NodePort
 * mapped to 127.0.0.1:30080; everything the invariant checks read directly (databases, the
 * banks', Ledger's and Reconciliation's gRPC) goes through `kubectl port-forward` on ports
 * that do not collide with the Compose stack, so both can run at once.
 *
 * The helpers already read these addresses from the environment, so the same invariant code
 * checks Compose and Kubernetes.
 */
export interface Forward {
  service: string;
  localPort: number;
  remotePort: number;
}

export const FORWARDS: readonly Forward[] = [
  { service: 'postgres-orchestrator', localPort: 25433, remotePort: 5432 },
  { service: 'postgres-ledger', localPort: 25434, remotePort: 5432 },
  { service: 'postgres-banks', localPort: 25435, remotePort: 5432 },
  { service: 'postgres-notification', localPort: 25436, remotePort: 5432 },
  { service: 'postgres-reconciliation', localPort: 25437, remotePort: 5432 },
  { service: 'ledger', localPort: 60052, remotePort: 50052 },
  { service: 'reconciliation', localPort: 60053, remotePort: 50053 },
  { service: 'bank-a', localPort: 60061, remotePort: 50061 },
  { service: 'bank-b', localPort: 60062, remotePort: 50062 },
  // Phase 2, item 4 (ADR-028): traces, metrics, dashboards.
  { service: 'jaeger', localPort: 26686, remotePort: 16686 },
  { service: 'prometheus', localPort: 29090, remotePort: 9090 },
  { service: 'grafana', localPort: 23000, remotePort: 3000 },
];

export const K8S_ENV: Readonly<Record<string, string>> = {
  GATEWAY_URL: 'http://127.0.0.1:30080',
  ORCHESTRATOR_DATABASE_URL: 'postgres://orch:orch@127.0.0.1:25433/orchestrator_db',
  LEDGER_DATABASE_URL: 'postgres://ledger:ledger@127.0.0.1:25434/ledger_db',
  BANK_A_DATABASE_URL: 'postgres://banks:banks@127.0.0.1:25435/bank_a',
  BANK_B_DATABASE_URL: 'postgres://banks:banks@127.0.0.1:25435/bank_b',
  NOTIFICATION_DATABASE_URL: 'postgres://notification:notification@127.0.0.1:25436/notification_db',
  RECONCILIATION_DATABASE_URL: 'postgres://reconciliation:reconciliation@127.0.0.1:25437/reconciliation_db',
  LEDGER_GRPC_ADDR: '127.0.0.1:60052',
  RECONCILIATION_GRPC_ADDR: '127.0.0.1:60053',
  BANK_A_GRPC_ADDR: '127.0.0.1:60061',
  BANK_B_GRPC_ADDR: '127.0.0.1:60062',
  JAEGER_URL: 'http://127.0.0.1:26686',
  PROMETHEUS_URL: 'http://127.0.0.1:29090',
  GRAFANA_URL: 'http://127.0.0.1:23000',
};
