import { createServer, type Server } from 'node:http';
import type { Registry } from 'prom-client';
import type { Logger } from './logger';

export interface HealthServerOptions {
  port: number;
  host?: string;
  registry: Registry;
  /** Resolves true once the service can do useful work (database answers, migrations ran). */
  ready: () => Promise<boolean>;
  logger?: Logger;
}

export interface HealthServer {
  server: Server;
  close: () => Promise<void>;
}

/**
 * Tiny HTTP server for gRPC services: `/healthz` (process is alive), `/readyz`
 * (dependencies are usable) and `/metrics` (Prometheus). Nothing else.
 */
export async function startHealthServer(options: HealthServerOptions): Promise<HealthServer> {
  const { registry, ready, logger } = options;

  const server = createServer((req, res) => {
    const url = req.url?.split('?')[0];
    if (req.method !== 'GET') {
      res.writeHead(405, { allow: 'GET' }).end();
      return;
    }
    if (url === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
      return;
    }
    if (url === '/readyz') {
      ready()
        .catch((err: unknown) => {
          logger?.warn({ err }, 'readiness check failed');
          return false;
        })
        .then((ok) => {
          res.writeHead(ok ? 200 : 503, { 'content-type': 'text/plain' }).end(ok ? 'ready' : 'not ready');
        })
        .catch((err: unknown) => logger?.error({ err }, 'failed to write readiness response'));
      return;
    }
    if (url === '/metrics') {
      registry
        .metrics()
        .then((body) => {
          res.writeHead(200, { 'content-type': registry.contentType }).end(body);
        })
        .catch((err: unknown) => {
          logger?.error({ err }, 'failed to render metrics');
          res.writeHead(500).end();
        });
      return;
    }
    res.writeHead(404).end();
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host ?? '0.0.0.0', () => {
      server.off('error', reject);
      resolve();
    });
  });

  return {
    server,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      }),
  };
}
