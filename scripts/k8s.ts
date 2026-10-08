/**
 * Phase 2, item 6 (ARCHITECTURE.md section 19, ADR-030): the stack on a local kind cluster.
 *
 *   npm run k8s:up     create the cluster if missing, build the image, load it, apply
 *                      deploy/k8s, wait until every workload is ready
 *   npm run k8s:down   delete the cluster (and with it every volume: the full reset)
 *
 * Needs `docker`, `kind` and `kubectl` on PATH (or KIND / KUBECTL set to their paths).
 * The Compose stack can keep running: the cluster uses its own ports (Gateway on
 * 127.0.0.1:30080) and its own image tag (payment-switch:dev).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');
export const CLUSTER = process.env.KIND_CLUSTER ?? 'payment-switch';
export const CONTEXT = `kind-${CLUSTER}`;
export const NAMESPACE = 'payment-switch';
const IMAGE = 'payment-switch:dev';
const KIND = process.env.KIND ?? 'kind';
const KUBECTL = process.env.KUBECTL ?? 'kubectl';

function run(command: string, args: string[]): void {
  process.stdout.write(`$ ${command} ${args.join(' ')}\n`);
  const result = spawnSync(command, args, { cwd: ROOT, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args[0] ?? ''} exited with ${String(result.status)}`);
}

function output(command: string, args: string[]): string {
  return execFileSync(command, args, { cwd: ROOT, encoding: 'utf8' });
}

const kubectl = (...args: string[]): void => {
  run(KUBECTL, ['--context', CONTEXT, '-n', NAMESPACE, ...args]);
};

function up(): void {
  const existed = output(KIND, ['get', 'clusters']).split(/\r?\n/).includes(CLUSTER);
  if (!existed) {
    run(KIND, ['create', 'cluster', '--name', CLUSTER, '--config', 'deploy/kind/cluster.yaml', '--wait', '180s']);
  }
  // One image for every service: each pod picks its entry point with SERVICE.
  run('docker', ['build', '-t', IMAGE, '.']);
  run(KIND, ['load', 'docker-image', IMAGE, '--name', CLUSTER]);
  // The configMapGenerators read observability/ and scripts/, outside deploy/k8s, so kustomize's
  // load restrictor is off; `kubectl apply -k` cannot do that, hence render, then apply.
  const manifests = output(KUBECTL, ['kustomize', '--load-restrictor', 'LoadRestrictionsNone', 'deploy/k8s']);
  process.stdout.write(`$ ${KUBECTL} apply -f - (deploy/k8s, rendered)
`);
  const applied = spawnSync(KUBECTL, ['--context', CONTEXT, 'apply', '-f', '-'], {
    cwd: ROOT,
    input: manifests,
    stdio: ['pipe', 'inherit', 'inherit'],
  });
  if (applied.error) throw applied.error;
  if (applied.status !== 0) throw new Error(`kubectl apply exited with ${String(applied.status)}`);
  if (existed) {
    // Same tag, new image: the pods only pick it up when they are recreated.
    kubectl('rollout', 'restart', 'deployment');
  }
  const workloads = output(KUBECTL, [
    '--context',
    CONTEXT,
    '-n',
    NAMESPACE,
    'get',
    'statefulset,deployment',
    '-o',
    'name',
  ])
    .split(/\r?\n/)
    .filter((line) => line !== '');
  for (const workload of workloads) kubectl('rollout', 'status', workload, '--timeout=600s');
  process.stdout.write(`\nready: the Gateway is at http://127.0.0.1:30080 (context ${CONTEXT})\n`);
}

function down(): void {
  run(KIND, ['delete', 'cluster', '--name', CLUSTER]);
}

if (require.main === module) {
  const command = process.argv[2];
  try {
    if (command === 'up') up();
    else if (command === 'down') down();
    else throw new Error('usage: tsx scripts/k8s.ts up|down');
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}
