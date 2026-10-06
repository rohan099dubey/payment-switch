import type { Logger } from '@switch/common';
import Fastify, { LogController, type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import type { Registry } from 'prom-client';
import type { OrchestratorPort } from './clients/orchestratorClient';
import type { GatewayConfig } from './config';
import type { GatewayMetrics } from './metrics';
import { authenticate, ClientRegistry, registerAuth } from './plugins/auth';
import { registerErrorHandler } from './plugins/errorHandler';
import { rateLimit, type RateLimiter } from './plugins/rateLimit';
import { registerRequestId, requestIdFrom } from './plugins/requestId';
import { registerAuthRoutes } from './routes/auth';
import { registerHealthRoutes } from './routes/health';
import { registerTransferRoutes } from './routes/transfers';

/** A transfer body is well under 1 KiB; anything near this is not a transfer. */
export const BODY_LIMIT_BYTES = 16 * 1024;

export interface AppDeps {
  config: Pick<GatewayConfig, 'JWT_SECRET' | 'JWT_TTL_SECONDS' | 'MAX_TRANSFER_AMOUNT' | 'API_CLIENTS'>;
  logger: Logger;
  registry: Registry;
  metrics: GatewayMetrics;
  orchestrator: OrchestratorPort;
  limiter: RateLimiter;
  redisReady: () => Promise<boolean>;
}

/**
 * Builds the Fastify instance with every dependency injected, so route and plugin tests
 * run in-process with `app.inject()` and fakes, with no sockets.
 */
export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  // Upcast to Fastify's logger interface so the instance has the default FastifyInstance type.
  const loggerInstance: FastifyBaseLogger = deps.logger;
  const app: FastifyInstance = Fastify({
    loggerInstance,
    // One line per request is written in onResponse below, without headers or bodies.
    logController: new LogController({ disableRequestLogging: true, requestIdLogLabel: 'request_id' }),
    genReqId: requestIdFrom,
    bodyLimit: BODY_LIMIT_BYTES,
  });

  const clients = new ClientRegistry(deps.config.API_CLIENTS);
  registerRequestId(app);
  registerErrorHandler(app);
  await registerAuth(app, { secret: deps.config.JWT_SECRET, ttlSeconds: deps.config.JWT_TTL_SECONDS, clients });

  app.addHook('onResponse', (request, reply, done) => {
    const route = request.routeOptions.url ?? 'unmatched';
    const status = reply.statusCode;
    deps.metrics.httpRequests.inc({ method: request.method, route, status: String(status) });
    deps.metrics.httpDuration.observe({ method: request.method, route }, reply.elapsedTime / 1000);
    if (route !== '/healthz' && route !== '/readyz' && route !== '/metrics') {
      request.log.info(
        {
          method: request.method,
          route,
          status,
          duration_ms: Math.round(reply.elapsedTime),
          ...(request.clientId === undefined ? {} : { client_id: request.clientId }),
        },
        'request completed',
      );
    }
    done();
  });

  registerHealthRoutes(app, {
    registry: deps.registry,
    redisReady: deps.redisReady,
    orchestratorReady: deps.orchestrator.ready,
  });
  registerAuthRoutes(app, clients, deps.config.JWT_TTL_SECONDS);
  registerTransferRoutes(app, {
    orchestrator: deps.orchestrator,
    maxAmount: deps.config.MAX_TRANSFER_AMOUNT,
    guards: [authenticate(clients), rateLimit(deps.limiter, deps.metrics)],
  });
  return app;
}
