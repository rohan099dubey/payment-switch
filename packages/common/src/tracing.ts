/**
 * Phase 2, item 4 (ARCHITECTURE.md section 19, ADR-028): OpenTelemetry tracing.
 *
 * A side-effect module: each service imports `@switch/common/tracing` as the **first**
 * import of its `main.ts`, so the SDK hooks `@grpc/grpc-js`, `http` and `pg` before anything
 * requires them. It deliberately imports nothing else from `@switch/common`, because the
 * package index loads gRPC and pg.
 *
 * Tracing starts only when `OTEL_EXPORTER_OTLP_ENDPOINT` is set (Compose sets it to Jaeger).
 * Unit tests and the integration tests' native processes run without it. The standard OTel
 * variables apply: `OTEL_SERVICE_NAME`, `OTEL_SDK_DISABLED`, `OTEL_TRACES_SAMPLER`.
 */
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { GrpcInstrumentation } from '@opentelemetry/instrumentation-grpc';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';

/** Probes and scrapes, not traffic: tracing them would bury real traces. */
const UNTRACED_PATHS = new Set(['/healthz', '/readyz', '/metrics']);

let sdk: NodeSDK | undefined;

const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? '';
if (endpoint !== '' && process.env.OTEL_SDK_DISABLED !== 'true') {
  sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME ?? process.env.SERVICE ?? 'unknown-service',
    }),
    traceExporter: new OTLPTraceExporter(),
    instrumentations: [
      new HttpInstrumentation({
        ignoreIncomingRequestHook: (req) => UNTRACED_PATHS.has(req.url?.split('?')[0] ?? ''),
      }),
      new GrpcInstrumentation(),
      // Only queries inside a traced request: the recovery loop, the outbox relay and the
      // reconciliation scheduler poll Postgres every second, and each poll would otherwise
      // be a root trace of its own, burying the real ones.
      new PgInstrumentation({ requireParentSpan: true }),
    ],
  });
  sdk.start();
}

/** True when this process exports traces. */
export function tracingEnabled(): boolean {
  return sdk !== undefined;
}

/** Flushes and stops the exporter; call during graceful shutdown, before `process.exit`. */
export async function shutdownTracing(): Promise<void> {
  const running = sdk;
  sdk = undefined;
  if (running !== undefined) await running.shutdown();
}
