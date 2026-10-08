/**
 * Opens one `kubectl port-forward` per entry in FORWARDS before the `k8s` project runs and
 * closes them afterwards. Fails fast if the cluster is not up (`npm run k8s:up`).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { connect } from 'node:net';
import { sleep } from '@switch/common';
import { KUBECTL, kubectlArgs } from '../helpers/kube';
import { FORWARDS } from './forwards';

function canConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });
    socket.setTimeout(1000);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => {
      resolve(false);
    });
  });
}

export default async function setup(): Promise<() => Promise<void>> {
  const children: ChildProcess[] = [];
  const stop = async (): Promise<void> => {
    for (const child of children) child.kill();
    await sleep(200);
  };
  try {
    for (const f of FORWARDS) {
      const child = spawn(
        KUBECTL,
        kubectlArgs('port-forward', `svc/${f.service}`, `${f.localPort}:${f.remotePort}`, '--address', '127.0.0.1'),
        { stdio: ['ignore', 'ignore', 'pipe'] },
      );
      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      children.push(child);
      const until = Date.now() + 30_000;
      while (!(await canConnect(f.localPort))) {
        if (child.exitCode !== null || Date.now() > until) {
          throw new Error(`port-forward to ${f.service} failed (is the cluster up? npm run k8s:up): ${stderr.trim()}`);
        }
        await sleep(200);
      }
    }
  } catch (err) {
    await stop();
    throw err;
  }
  return stop;
}
