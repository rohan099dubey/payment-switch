import { collectDefaultMetrics, Counter, Histogram, type Registry } from 'prom-client';

export interface GatewayMetrics {
  httpRequests: Counter<'method' | 'route' | 'status'>;
  httpDuration: Histogram<'method' | 'route'>;
  rateLimitRejections: Counter;
  rateLimitFailOpen: Counter;
}

/** Gateway metrics from spec section 17. */
export function createGatewayMetrics(registry: Registry): GatewayMetrics {
  collectDefaultMetrics({ register: registry });
  return {
    httpRequests: new Counter({
      name: 'http_requests_total',
      help: 'HTTP requests, by method, route template and status code',
      labelNames: ['method', 'route', 'status'] as const,
      registers: [registry],
    }),
    httpDuration: new Histogram({
      name: 'http_request_duration_seconds',
      help: 'HTTP request latency in seconds, by method and route template',
      labelNames: ['method', 'route'] as const,
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
      registers: [registry],
    }),
    rateLimitRejections: new Counter({
      name: 'rate_limit_rejections_total',
      help: 'Requests rejected with 429 by the token bucket',
      registers: [registry],
    }),
    rateLimitFailOpen: new Counter({
      name: 'rate_limit_fail_open_total',
      help: 'Requests allowed without a rate-limit check because Redis was unreachable (ADR-006)',
      registers: [registry],
    }),
  };
}
