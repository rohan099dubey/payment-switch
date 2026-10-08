/**
 * Phase 2, item 6 (ADR-030): the Kubernetes manifests in deploy/k8s must describe the same
 * system as docker-compose.yml. No cluster needed: both are parsed and compared, so a
 * variable added to Compose and forgotten here (or the reverse) fails `npm test`.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse, parseAllDocuments } from 'yaml';

const ROOT = path.resolve(__dirname, '..', '..');
const K8S = path.join(ROOT, 'deploy', 'k8s');

interface ComposeService {
  image?: string;
  command?: string[];
  volumes?: string[];
  healthcheck?: { test: string[] };
  build?: { args?: Record<string, string> };
  environment?: Record<string, string>;
  ports?: string[];
  depends_on?: Record<string, unknown>;
}

interface EnvVar {
  name: string;
  value?: string;
  valueFrom?: { fieldRef?: { fieldPath: string } };
}

interface Probe {
  httpGet?: { path: string; port: string | number };
  exec?: { command: string[] };
}

interface Container {
  name: string;
  image: string;
  imagePullPolicy?: string;
  command?: string[];
  args?: string[];
  env?: EnvVar[];
  envFrom?: { configMapRef?: { name: string }; secretRef?: { name: string } }[];
  ports?: { name: string; containerPort: number }[];
  startupProbe?: Probe;
  readinessProbe?: Probe;
  livenessProbe?: Probe;
  resources?: { requests?: Record<string, string>; limits?: Record<string, string> };
  volumeMounts?: { name: string; mountPath: string; subPath?: string }[];
  securityContext?: {
    allowPrivilegeEscalation?: boolean;
    readOnlyRootFilesystem?: boolean;
    capabilities?: { drop?: string[] };
  };
}

interface PodSpec {
  automountServiceAccountToken?: boolean;
  securityContext?: { runAsNonRoot?: boolean; seccompProfile?: { type: string } };
  initContainers?: Container[];
  containers: Container[];
  volumes?: { name: string; configMap?: { name: string } }[];
}

interface LabelSelector {
  matchLabels?: Record<string, string>;
  matchExpressions?: { key: string; operator: string; values: string[] }[];
}

interface K8sObject {
  apiVersion: string;
  kind: string;
  metadata: { name: string };
  data?: Record<string, string>;
  stringData?: Record<string, string>;
  spec?: {
    replicas?: number;
    type?: string;
    ports?: { name: string; port: number; nodePort?: number }[];
    template?: { spec: PodSpec };
    podSelector?: LabelSelector;
    ingress?: { from?: { podSelector?: LabelSelector }[]; ports?: { port: string | number }[] }[];
  };
}

const compose = parse(readFileSync(path.join(ROOT, 'docker-compose.yml'), 'utf8'), { merge: true }) as {
  services: Record<string, ComposeService>;
};
const kustomization = parse(readFileSync(path.join(K8S, 'kustomization.yaml'), 'utf8')) as {
  resources: string[];
  configMapGenerator: { name: string; files: string[] }[];
};
const objects: K8sObject[] = kustomization.resources.flatMap((file) =>
  parseAllDocuments(readFileSync(path.join(K8S, file), 'utf8')).map((doc) => doc.toJSON() as K8sObject),
);

function find(kind: string, name: string): K8sObject {
  const found = objects.find((o) => o.kind === kind && o.metadata.name === name);
  if (found === undefined) throw new Error(`no ${kind} ${name} in deploy/k8s`);
  return found;
}

function workload(name: string): K8sObject {
  const found = objects.find((o) => (o.kind === 'Deployment' || o.kind === 'StatefulSet') && o.metadata.name === name);
  if (found === undefined) throw new Error(`no Deployment or StatefulSet ${name} in deploy/k8s`);
  return found;
}

function podSpec(name: string): PodSpec {
  const spec = workload(name).spec?.template?.spec;
  if (spec === undefined) throw new Error(`${name} has no pod template`);
  return spec;
}

function mainContainer(name: string): Container {
  const container = podSpec(name).containers[0];
  if (container === undefined) throw new Error(`${name} has no container`);
  return container;
}

/** The environment a container sees: ConfigMaps and Secrets from envFrom, then env. */
function effectiveEnv(container: Container): Record<string, string> {
  const env: Record<string, string> = {};
  for (const source of container.envFrom ?? []) {
    if (source.configMapRef) Object.assign(env, find('ConfigMap', source.configMapRef.name).data);
    if (source.secretRef) Object.assign(env, find('Secret', source.secretRef.name).stringData);
  }
  for (const v of container.env ?? []) env[v.name] = v.value ?? `<${v.valueFrom?.fieldRef?.fieldPath ?? 'ref'}>`;
  return env;
}

/** The files a generated ConfigMap holds, as repository paths, keyed by their ConfigMap key. */
function generatedFiles(name: string): Map<string, string> {
  const generator = kustomization.configMapGenerator.find((g) => g.name === name);
  if (generator === undefined) throw new Error(`no configMapGenerator ${name}`);
  const files = new Map<string, string>();
  for (const file of generator.files) {
    const repoPath = path.relative(ROOT, path.resolve(K8S, file)).split(path.sep).join('/');
    files.set(path.posix.basename(repoPath), repoPath);
  }
  return files;
}

/** Repository file -> container path, for every file a Compose service mounts from the repo. */
function composeFileMounts(service: ComposeService): Map<string, string> {
  const mounts = new Map<string, string>();
  for (const volume of service.volumes ?? []) {
    const [source = '', target = ''] = volume.split(':');
    if (!source.startsWith('./')) continue; // a named volume, not a file from the repository
    const repoPath = source.slice(2);
    const walk = (rel: string): void => {
      let entries: string[] | undefined;
      try {
        entries = readdirSync(path.join(ROOT, repoPath, rel));
      } catch {
        entries = undefined;
      }
      if (entries === undefined) mounts.set([repoPath, rel].filter(Boolean).join('/'), path.posix.join(target, rel));
      else for (const entry of entries) walk(rel === '' ? entry : `${rel}/${entry}`);
    };
    walk('');
  }
  return mounts;
}

/** Repository file -> container path, for every generated ConfigMap a k8s container mounts. */
function k8sFileMounts(name: string): Map<string, string> {
  const pod = podSpec(name);
  const mounts = new Map<string, string>();
  for (const mount of mainContainer(name).volumeMounts ?? []) {
    const configMap = pod.volumes?.find((v) => v.name === mount.name)?.configMap?.name;
    if (configMap === undefined || !kustomization.configMapGenerator.some((g) => g.name === configMap)) continue;
    for (const [key, file] of generatedFiles(configMap)) {
      if (mount.subPath !== undefined && mount.subPath !== key) continue;
      mounts.set(file, mount.subPath === undefined ? path.posix.join(mount.mountPath, key) : mount.mountPath);
    }
  }
  return mounts;
}

/** `'50052:50052'` -> 50052, the container side of a Compose port mapping. */
const containerPort = (mapping: string): number => Number(mapping.split(':').at(-1));

const appServices = Object.entries(compose.services).filter(([, s]) => s.build !== undefined);
const infraServices = Object.entries(compose.services).filter(([, s]) => s.build === undefined);

describe('deploy/k8s mirrors docker-compose.yml (ADR-030)', () => {
  it('lists every manifest in kustomization.yaml, and nothing else exists', () => {
    const files = readdirSync(K8S).filter((f) => f.endsWith('.yaml') && f !== 'kustomization.yaml');
    expect([...kustomization.resources].sort()).toEqual(files.sort());
  });

  it('has a workload for every Compose service, and no extra ones', () => {
    const workloads = objects.filter((o) => o.kind === 'Deployment' || o.kind === 'StatefulSet');
    expect(workloads.map((w) => w.metadata.name).sort()).toEqual(Object.keys(compose.services).sort());
  });

  describe.each(appServices)('application service %s', (name, service) => {
    const container = mainContainer(name);
    const env = effectiveEnv(container);

    it('sets exactly the Compose environment, value for value', () => {
      const { SERVICE, INSTANCE_ID, ...rest } = env;
      expect(rest).toEqual(service.environment);
      // One image for all services: SERVICE is the Dockerfile build arg Compose passes.
      expect(SERVICE).toBe(service.build?.args?.SERVICE);
      // Only the Orchestrator has an instance id: its pod name, the lease owner.
      expect(INSTANCE_ID).toBe(name === 'orchestrator' ? '<metadata.name>' : undefined);
    });

    it('exposes the Compose ports on the container and on its Service', () => {
      const ports = (service.ports ?? []).map(containerPort).sort();
      expect((container.ports ?? []).map((p) => p.containerPort).sort()).toEqual(ports);
      expect((find('Service', name).spec?.ports ?? []).map((p) => p.port).sort()).toEqual(ports);
    });

    it('probes /readyz for readiness and /healthz for liveness on its HTTP port', () => {
      expect(container.readinessProbe?.httpGet).toEqual({ path: '/readyz', port: 'http' });
      expect(container.livenessProbe?.httpGet).toEqual({ path: '/healthz', port: 'http' });
      expect(container.startupProbe?.httpGet).toEqual({ path: '/healthz', port: 'http' });
      expect(container.ports?.find((p) => p.name === 'http')?.containerPort).toBe(Number(env.HTTP_PORT));
    });

    it('waits for exactly its Compose depends_on, with init containers', () => {
      const waits = (podSpec(name).initContainers ?? []).map((c) => c.name.replace(/^wait-for-/, ''));
      expect(waits.sort()).toEqual(Object.keys(service.depends_on ?? {}).sort());
      for (const init of podSpec(name).initContainers ?? []) {
        const target = init.name.replace(/^wait-for-/, '');
        expect(init.command?.join(' ')).toContain(` ${target}`);
      }
    });

    it('runs the locally loaded image as a non-root user with a read-only root filesystem', () => {
      const pod = podSpec(name);
      expect(pod.automountServiceAccountToken).toBe(false);
      expect(pod.securityContext?.runAsNonRoot).toBe(true);
      expect(pod.securityContext?.seccompProfile?.type).toBe('RuntimeDefault');
      for (const c of [...(pod.initContainers ?? []), ...pod.containers]) {
        expect(c.image).toBe('payment-switch:dev');
        // Never: kind loads the image; pulling a same-named image from a registry would be wrong.
        expect(c.imagePullPolicy).toBe('Never');
        expect(c.securityContext).toEqual({
          allowPrivilegeEscalation: false,
          readOnlyRootFilesystem: true,
          capabilities: { drop: ['ALL'] },
        });
      }
    });
  });

  describe.each(infraServices)('infrastructure service %s', (name, service) => {
    const container = mainContainer(name);
    const env = effectiveEnv(container);

    it('runs the Compose image', () => {
      expect(container.image).toBe(service.image);
    });

    it('sets the Compose environment (Kafka: minus the host listener, ADR-030)', () => {
      if (name === 'kafka') {
        const expected = { ...service.environment };
        expected.KAFKA_LISTENERS = 'PLAINTEXT://:9092,CONTROLLER://:9093';
        expected.KAFKA_ADVERTISED_LISTENERS = 'PLAINTEXT://kafka:9092';
        expected.KAFKA_LISTENER_SECURITY_PROTOCOL_MAP = 'PLAINTEXT:PLAINTEXT,CONTROLLER:PLAINTEXT';
        expect(env).toEqual({ ...expected, KAFKA_HEAP_OPTS: '-Xmx512m -Xms512m' });
      } else if (name.startsWith('postgres-')) {
        expect(env).toEqual({ ...service.environment, PGDATA: '/var/lib/postgresql/data/pgdata' });
      } else {
        expect(env).toEqual(service.environment ?? {});
      }
    });

    it('keeps the Compose health check as its readiness probe, word for word', () => {
      const [form, ...test] = service.healthcheck?.test ?? [];
      const expected = form === 'CMD-SHELL' ? ['sh', '-c', ...test] : test;
      expect(container.readinessProbe?.exec?.command).toEqual(expected);
    });

    it('runs the Compose command as its arguments', () => {
      expect(container.args).toEqual(service.command);
    });

    it('exposes the Compose ports (Kafka: minus the host listener)', () => {
      const ports = (service.ports ?? []).map(containerPort).filter((p) => !(name === 'kafka' && p === 9094));
      const k8sPorts = (container.ports ?? []).map((p) => p.containerPort);
      for (const port of ports) expect(k8sPorts).toContain(port);
    });

    it('mounts every file Compose mounts, at the same path, generated from the same file', () => {
      const expected = composeFileMounts(service);
      // Prometheus discovers pods through the Kubernetes API instead (deploy/k8s/prometheus.yml).
      if (name === 'prometheus') {
        expected.delete('observability/prometheus/prometheus.yml');
        expected.set('deploy/k8s/prometheus.yml', '/etc/prometheus/prometheus.yml');
      }
      expect(k8sFileMounts(name)).toEqual(expected);
    });
  });

  it('scrapes the same seven jobs as the Compose Prometheus, one target per pod', () => {
    const composeConfig = parse(
      readFileSync(path.join(ROOT, 'observability', 'prometheus', 'prometheus.yml'), 'utf8'),
    ) as {
      global: unknown;
      scrape_configs: { job_name: string }[];
    };
    const k8s = parse(readFileSync(path.join(K8S, 'prometheus.yml'), 'utf8')) as {
      global: unknown;
      scrape_configs: { relabel_configs: { action?: string; regex?: string; target_label?: string }[] }[];
    };
    const relabel = k8s.scrape_configs[0]?.relabel_configs ?? [];
    const keep = relabel.find((r) => r.action === 'keep' && r.regex?.includes('|') === true);
    expect(keep?.regex?.split('|').sort()).toEqual(composeConfig.scrape_configs.map((j) => j.job_name).sort());
    expect(relabel.some((r) => r.target_label === 'job')).toBe(true);
    expect(k8s.global).toEqual(composeConfig.global);
  });

  it('gives every container memory and CPU requests and a memory limit', () => {
    for (const w of objects.filter((o) => o.kind === 'Deployment' || o.kind === 'StatefulSet')) {
      const pod = w.spec?.template?.spec;
      for (const c of [...(pod?.initContainers ?? []), ...(pod?.containers ?? [])]) {
        expect(c.resources?.requests?.cpu, `${w.metadata.name}/${c.name}`).toBeDefined();
        expect(c.resources?.requests?.memory, `${w.metadata.name}/${c.name}`).toBeDefined();
        expect(c.resources?.limits?.memory, `${w.metadata.name}/${c.name}`).toBeDefined();
      }
    }
  });

  it('fits its requests on a 2-CPU kind node next to the control plane', () => {
    // GitHub's runner has 2 CPUs, and kind's control plane requests about 950m of them.
    // The first CI run requested 1,325m more, and three Postgres pods were never scheduled.
    const cpu = (q: string | undefined): number => (q?.endsWith('m') ? Number(q.slice(0, -1)) : Number(q ?? 0) * 1000);
    const mib = (q: string | undefined): number =>
      q?.endsWith('Gi') ? Number(q.slice(0, -2)) * 1024 : Number(q?.replace(/Mi$/, '') ?? 0);
    let cpuTotal = 0;
    let memTotal = 0;
    for (const w of objects.filter((o) => o.kind === 'Deployment' || o.kind === 'StatefulSet')) {
      const pod = w.spec?.template?.spec;
      // A pod's effective request: the larger of its biggest init container and its containers' sum.
      const sum = (f: (c: Container) => number, list: Container[]): number => list.reduce((n, c) => n + f(c), 0);
      const max = (f: (c: Container) => number, list: Container[]): number => Math.max(0, ...list.map(f));
      const podCpu = (c: Container): number => cpu(c.resources?.requests?.cpu);
      const podMem = (c: Container): number => mib(c.resources?.requests?.memory);
      const replicas = w.spec?.replicas ?? 1;
      cpuTotal += replicas * Math.max(max(podCpu, pod?.initContainers ?? []), sum(podCpu, pod?.containers ?? []));
      memTotal += replicas * Math.max(max(podMem, pod?.initContainers ?? []), sum(podMem, pod?.containers ?? []));
    }
    // Leaves room for a rolling restart's surge pods (npm run k8s:up on an existing cluster).
    expect(cpuTotal).toBeLessThanOrEqual(700);
    expect(memTotal).toBeLessThanOrEqual(4096);
  });

  it('runs two Orchestrators and two Gateways, and exactly one of each bank', () => {
    expect(workload('orchestrator').spec?.replicas).toBe(2);
    expect(workload('gateway').spec?.replicas).toBe(2);
    // SetChaos changes one process; a second replica would answer with different chaos.
    expect(workload('bank-a').spec?.replicas).toBe(1);
    expect(workload('bank-b').spec?.replicas).toBe(1);
  });

  it('publishes only the Gateway outside the cluster, on NodePort 30080', () => {
    const exposed = objects.filter((o) => o.kind === 'Service' && o.spec?.type !== undefined);
    expect(exposed.map((s) => [s.metadata.name, s.spec?.type, s.spec?.ports?.[0]?.nodePort])).toEqual([
      ['gateway', 'NodePort', 30080],
    ]);
  });
});

describe('network policies enforce database per service (ADR-007, ADR-030)', () => {
  const policies = objects.filter((o) => o.kind === 'NetworkPolicy');

  /** The app names a selector matches, out of the given names. */
  const matches = (selector: LabelSelector | undefined, names: string[]): string[] =>
    names.filter((n) => {
      const labels = { 'app.kubernetes.io/name': n };
      const byLabels = Object.entries(selector?.matchLabels ?? {}).every(
        ([k, v]) => labels[k as keyof typeof labels] === v,
      );
      const byExpressions = (selector?.matchExpressions ?? []).every(
        (e) => e.operator === 'In' && e.values.includes(labels[e.key as keyof typeof labels]),
      );
      return byLabels && byExpressions;
    });

  const all = Object.keys(compose.services);

  /** Which workloads may open a connection to `target` on `port`, by the policies. */
  function allowedFrom(target: string, port: number | string): string[] {
    const allowed = new Set<string>();
    for (const p of policies) {
      if (!matches(p.spec?.podSelector, all).includes(target)) continue;
      for (const rule of p.spec?.ingress ?? []) {
        if (rule.ports !== undefined && !rule.ports.some((x) => x.port === port)) continue;
        if (rule.from === undefined) return ['*'];
        for (const peer of rule.from) for (const n of matches(peer.podSelector, all)) allowed.add(n);
      }
    }
    return [...allowed].sort();
  }

  it('denies all ingress by default', () => {
    const deny = find('NetworkPolicy', 'default-deny-ingress');
    expect(deny.spec?.podSelector).toEqual({});
    expect(deny.spec?.ingress).toBeUndefined();
  });

  it('lets each database accept connections only from the services whose DATABASE_URL names it', () => {
    const owners = new Map<string, string[]>();
    for (const [name, service] of appServices) {
      const url = service.environment?.DATABASE_URL;
      if (url === undefined) continue;
      const host = new URL(url).hostname;
      owners.set(host, [...(owners.get(host) ?? []), name]);
    }
    expect(owners.size).toBe(5);
    for (const [db, names] of owners) expect(allowedFrom(db, 5432), db).toEqual(names.sort());
  });

  it('lets each gRPC port accept only the callers of the architecture', () => {
    expect(allowedFrom('orchestrator', 'grpc')).toEqual(['gateway']);
    for (const leaf of ['ledger', 'bank-a', 'bank-b']) {
      expect(allowedFrom(leaf, 'grpc'), leaf).toEqual(['orchestrator', 'reconciliation']);
    }
    // Operators reach GetReport / RunReconciliation through kubectl port-forward only.
    expect(allowedFrom('reconciliation', 'grpc')).toEqual([]);
    expect(allowedFrom('redis', 6379)).toEqual(['gateway']);
    expect(allowedFrom('kafka', 9092)).toEqual(['kafka', 'notification', 'orchestrator']);
    // Phase 2, item 4: every service exports spans; only Grafana reads traces and metrics.
    expect(allowedFrom('jaeger', 4318)).toEqual(appServices.map(([n]) => n).sort());
    expect(allowedFrom('jaeger', 16686)).toEqual(['grafana']);
    expect(allowedFrom('prometheus', 9090)).toEqual(['grafana']);
    expect(allowedFrom('grafana', 3000)).toEqual([]);
  });

  it('leaves every HTTP port (probes, metrics, the public API) open', () => {
    for (const [name] of appServices) expect(allowedFrom(name, 'http'), name).toEqual(['*']);
  });
});
