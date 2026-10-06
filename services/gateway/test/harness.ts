/**
 * In-process Gateway for unit tests: `buildApp` with a fake Orchestrator, a fake rate
 * limiter and a log sink. No sockets, no Redis, no gRPC (requests go through `app.inject`).
 */
import { status as Status } from '@grpc/grpc-js';
import { createLogger, makeGrpcError } from '@switch/common';
import {
  TransferState,
  type CreateTransferRequest,
  type CreateTransferResponse,
  type Transfer,
} from '@switch/proto-gen/orchestrator/v1';
import type { FastifyInstance } from 'fastify';
import { Registry } from 'prom-client';
import { buildApp } from '../src/app';
import type { OrchestratorPort } from '../src/clients/orchestratorClient';
import { createGatewayMetrics, type GatewayMetrics } from '../src/metrics';
import type { RateLimitDecision, RateLimiter } from '../src/plugins/rateLimit';

export const JWT_SECRET = 'unit-test-jwt-secret-0123456789abcdef';
export const CLIENTS = [
  { clientId: 'client-a', clientSecret: 'secret-a-very-long-value' },
  { clientId: 'client-b', clientSecret: 'secret-b-very-long-value' },
];
export const KEY = 'key-0001-abcdef';

export function grpcError(code: Status, errorCode: string, message = `${errorCode} message`): Error {
  return makeGrpcError(code, errorCode, message);
}

export { Status };

export function transfer(overrides: Partial<Transfer> = {}): Transfer {
  return {
    transferId: '0b6f6f0e-4a0b-4c3b-9b59-2f1f6d1a8c11',
    state: TransferState.TRANSFER_STATE_SUCCESS,
    payer: { bankId: 'bank_a', accountId: 'ACC001' },
    payee: { bankId: 'bank_b', accountId: 'ACC002' },
    amount: '12500',
    currency: 'INR',
    note: 'rent',
    failureCode: '',
    failureMessage: '',
    createdAt: new Date('2026-10-04T10:15:00.000Z'),
    updatedAt: new Date('2026-10-04T10:15:00.412Z'),
    ...overrides,
  };
}

export class FakeOrchestrator implements OrchestratorPort {
  readonly creates: { request: CreateTransferRequest; requestId: string }[] = [];
  readonly gets: { transferId: string; clientId: string; requestId: string }[] = [];
  createResult: CreateTransferResponse | Error = { transfer: transfer(), replayed: false };
  getResult: Transfer | Error = transfer();
  isReady: boolean | Error = true;

  createTransfer = (request: CreateTransferRequest, requestId: string): Promise<CreateTransferResponse> => {
    this.creates.push({ request, requestId });
    return this.createResult instanceof Error ? Promise.reject(this.createResult) : Promise.resolve(this.createResult);
  };
  getTransfer = (transferId: string, clientId: string, requestId: string): Promise<Transfer> => {
    this.gets.push({ transferId, clientId, requestId });
    return this.getResult instanceof Error ? Promise.reject(this.getResult) : Promise.resolve(this.getResult);
  };
  ready = (): Promise<boolean> =>
    this.isReady instanceof Error ? Promise.reject(this.isReady) : Promise.resolve(this.isReady);
  close = (): void => undefined;
}

export class FakeLimiter implements RateLimiter {
  readonly calls: string[] = [];
  next: RateLimitDecision | Error = { allowed: true, remaining: 199, retryAfterSeconds: 0 };
  take = (clientId: string): Promise<RateLimitDecision> => {
    this.calls.push(clientId);
    return this.next instanceof Error ? Promise.reject(this.next) : Promise.resolve(this.next);
  };
}

export interface Harness {
  app: FastifyInstance;
  orchestrator: FakeOrchestrator;
  limiter: FakeLimiter;
  metrics: GatewayMetrics;
  registry: Registry;
  logs: string[];
  redisReady: { value: boolean | Error };
  token: (clientId?: string) => Promise<string>;
}

export async function harness(options: { ttlSeconds?: number; clients?: typeof CLIENTS } = {}): Promise<Harness> {
  const logs: string[] = [];
  const logger = createLogger('gateway-test', {
    level: 'info',
    destination: {
      write: (line: string) => {
        logs.push(line);
      },
    },
  });
  const registry = new Registry();
  const metrics = createGatewayMetrics(registry);
  const orchestrator = new FakeOrchestrator();
  const limiter = new FakeLimiter();
  const redisReady: { value: boolean | Error } = { value: true };
  const app = await buildApp({
    config: {
      JWT_SECRET,
      JWT_TTL_SECONDS: options.ttlSeconds ?? 900,
      MAX_TRANSFER_AMOUNT: 10_000_000,
      API_CLIENTS: options.clients ?? CLIENTS,
    },
    logger,
    registry,
    metrics,
    orchestrator,
    limiter,
    redisReady: () =>
      redisReady.value instanceof Error ? Promise.reject(redisReady.value) : Promise.resolve(redisReady.value),
  });
  const token = async (clientId = 'client-a'): Promise<string> => {
    const secret = CLIENTS.find((c) => c.clientId === clientId)?.clientSecret ?? 'none';
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/token',
      payload: { client_id: clientId, client_secret: secret },
    });
    return res.json<{ access_token: string }>().access_token;
  };
  return { app, orchestrator, limiter, metrics, registry, logs, redisReady, token };
}

export function validBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    payer: { bank_id: 'bank_a', account_id: 'ACC001' },
    payee: { bank_id: 'bank_b', account_id: 'ACC002' },
    amount: 12500,
    currency: 'INR',
    note: 'rent',
    ...overrides,
  };
}

export async function counterValue(registry: Registry, name: string): Promise<number> {
  const metric = await registry.getSingleMetric(name)?.get();
  return metric?.values.reduce((sum, v) => sum + v.value, 0) ?? 0;
}
