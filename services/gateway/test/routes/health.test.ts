import { describe, expect, it } from 'vitest';
import { harness } from '../harness';

describe('/healthz, /readyz, /metrics', () => {
  it('/healthz is 200 regardless of dependencies', async () => {
    const h = await harness();
    h.redisReady.value = false;
    h.orchestrator.isReady = false;
    const res = await h.app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
  });

  it('/readyz is 200 only when Redis answers and the Orchestrator channel is connected', async () => {
    const h = await harness();
    expect((await h.app.inject({ method: 'GET', url: '/readyz' })).statusCode).toBe(200);
  });

  it.each([
    ['Redis down', false, true],
    ['Redis PING throws', new Error('ECONNREFUSED'), true],
    ['Orchestrator not connected', true, false],
    ['Orchestrator check throws', true, new Error('boom')],
    ['both down', false, false],
  ])('/readyz is 503 when %s', async (_name, redis, orchestrator) => {
    const h = await harness();
    h.redisReady.value = redis;
    h.orchestrator.isReady = orchestrator;
    const res = await h.app.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(503);
  });

  it('/metrics exposes the four section 17 Gateway metrics, with route templates as labels', async () => {
    const h = await harness();
    await h.app.inject({
      method: 'GET',
      url: '/v1/transfers/some-id',
      headers: { authorization: `Bearer ${await h.token()}` },
    });
    const body = (await h.app.inject({ method: 'GET', url: '/metrics' })).body;
    expect(body).toMatch(/^http_requests_total\{method="GET",route="\/v1\/transfers\/:id",status="200"\} 1$/m);
    expect(body).toMatch(/^http_request_duration_seconds_count\{method="GET",route="\/v1\/transfers\/:id"\} 1$/m);
    expect(body).toContain('# TYPE rate_limit_rejections_total counter');
    expect(body).toContain('# TYPE rate_limit_fail_open_total counter');
    // The raw id never becomes a label (unbounded cardinality).
    expect(body).not.toContain('some-id');
  });
});
