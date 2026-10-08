/**
 * kubectl access for the `k8s` test project (phase 2, item 6, ADR-030): the counterpart of
 * stack.ts, which drives Compose. Always the kind cluster's context and the stack's
 * namespace, never whatever context happens to be current.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

const CLUSTER = process.env.KIND_CLUSTER ?? 'payment-switch';
export const KUBE_CONTEXT = `kind-${CLUSTER}`;
/** The kind node's Docker container (a one-node cluster). */
const KIND_NODE = `${CLUSTER}-control-plane`;
export const KUBE_NAMESPACE = 'payment-switch';
export const KUBECTL = process.env.KUBECTL ?? 'kubectl';

export function kubectlArgs(...args: string[]): string[] {
  return ['--context', KUBE_CONTEXT, '-n', KUBE_NAMESPACE, ...args];
}

export async function kubectl(...args: string[]): Promise<string> {
  const { stdout } = await run(KUBECTL, kubectlArgs(...args), { timeout: 120_000, maxBuffer: 32 * 1024 * 1024 });
  return stdout;
}

export interface PodView {
  name: string;
  app: string;
  phase: string;
  ready: boolean;
  deleting: boolean;
}

interface PodList {
  items: {
    metadata: { name: string; labels?: Record<string, string>; deletionTimestamp?: string };
    status: { phase: string; conditions?: { type: string; status: string }[] };
  }[];
}

export async function pods(app?: string): Promise<PodView[]> {
  const selector = app === undefined ? [] : ['-l', `app.kubernetes.io/name=${app}`];
  const list = JSON.parse(await kubectl('get', 'pods', ...selector, '-o', 'json')) as PodList;
  return list.items.map((p) => ({
    name: p.metadata.name,
    app: p.metadata.labels?.['app.kubernetes.io/name'] ?? '',
    phase: p.status.phase,
    ready: p.status.conditions?.some((c) => c.type === 'Ready' && c.status === 'True') ?? false,
    deleting: p.metadata.deletionTimestamp !== undefined,
  }));
}

/** Runs `sh -c script` in a pod's main container; resolves with the exit code. */
export async function execIn(pod: string, script: string): Promise<number> {
  try {
    await kubectl('exec', pod, '--', 'sh', '-c', script);
    return 0;
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    return typeof code === 'number' ? code : -1;
  }
}

/**
 * A crash, the Kubernetes analogue of `docker compose kill`: SIGKILL the container's process
 * from the kind node, then force-delete the pod so its replacement has a new name (a new
 * `INSTANCE_ID`). `kubectl delete --force --grace-period=0` alone is **not** a crash: it only
 * removes the API object, and the kubelet still sends SIGTERM, so a graceful shutdown
 * finishes the in-flight work (observed on the first run, ADR-030).
 */
export async function crashPod(pod: string, container: string): Promise<void> {
  const script = [
    'set -e',
    `p=$(crictl pods --name '^${pod}$' --state ready -q)`,
    `c=$(crictl ps --pod "$p" --name '^${container}$' -q)`,
    `kill -9 "$(crictl inspect --output go-template --template '{{.info.pid}}' "$c")"`,
  ].join('; ');
  await run('docker', ['exec', KIND_NODE, 'sh', '-c', script], { timeout: 30_000 });
  await kubectl('delete', 'pod', pod, '--grace-period=0', '--force', '--wait=false');
}
