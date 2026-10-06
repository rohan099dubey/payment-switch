import type { FastifyInstance } from 'fastify';
import type { Registry } from 'prom-client';

export interface HealthDeps {
  registry: Registry;
  /** Redis answers PING. */
  redisReady: () => Promise<boolean>;
  /** The Orchestrator channel is connected. */
  orchestratorReady: () => Promise<boolean>;
}

/** `/healthz` (process up), `/readyz` (Redis and the Orchestrator channel), `/metrics`. */
export function registerHealthRoutes(app: FastifyInstance, deps: HealthDeps): void {
  app.get('/healthz', async (_request, reply) => reply.type('text/plain').send('ok'));

  app.get('/readyz', async (request, reply) => {
    const [redis, orchestrator] = await Promise.all([
      deps.redisReady().catch(() => false),
      deps.orchestratorReady().catch(() => false),
    ]);
    const ok = redis && orchestrator;
    if (!ok) request.log.warn({ redis, orchestrator }, 'not ready');
    return reply
      .code(ok ? 200 : 503)
      .type('text/plain')
      .send(ok ? 'ready' : `not ready (redis=${redis}, orchestrator=${orchestrator})`);
  });

  app.get('/metrics', async (_request, reply) =>
    reply.type(deps.registry.contentType).send(await deps.registry.metrics()),
  );
}
