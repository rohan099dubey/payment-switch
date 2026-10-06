import type { FastifyInstance, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import { z } from 'zod';
import type { OrchestratorPort } from '../clients/orchestratorClient';
import { createStatusCode, mapGrpcError, toTransferResource } from '../mappers';
import { ApiError } from '../plugins/errorHandler';

export const IDEMPOTENCY_KEY = /^[A-Za-z0-9_.:-]{8,128}$/;
export const NOTE_MAX_CHARS = 140;

const party = z.strictObject({
  bank_id: z.string().regex(/^[a-z0-9_]{1,32}$/),
  account_id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
});

export interface TransferBody {
  payer: { bank_id: string; account_id: string };
  payee: { bank_id: string; account_id: string };
  amount: number;
  currency: 'INR';
  note?: string | undefined;
}

/**
 * The `POST /v1/transfers` body (section 5). Unknown fields are rejected at every level.
 * `amount` must be a JSON integer; the note limit counts characters (code points), not
 * UTF-16 units.
 */
export function transferBodySchema(maxAmount: number): z.ZodType<TransferBody> {
  return z.strictObject({
    payer: party,
    payee: party,
    amount: z.number().int().min(1).max(maxAmount),
    currency: z.literal('INR'),
    note: z
      .string()
      .refine((note) => Array.from(note).length <= NOTE_MAX_CHARS, `note must be at most ${NOTE_MAX_CHARS} characters`)
      .optional(),
  });
}

/** `Idempotency-Key`, required and well-formed, else 400 `IDEMPOTENCY_KEY_REQUIRED`. */
export function idempotencyKeyOf(request: FastifyRequest): string {
  const key = request.headers['idempotency-key'];
  if (typeof key !== 'string' || !IDEMPOTENCY_KEY.test(key)) {
    throw new ApiError(
      400,
      'IDEMPOTENCY_KEY_REQUIRED',
      'Idempotency-Key header is required and must match [A-Za-z0-9_.:-]{8,128}',
    );
  }
  return key;
}

function clientIdOf(request: FastifyRequest): string {
  // Always the JWT `sub`, set by `authenticate`. Never from the body or a header.
  if (request.clientId === undefined) throw new Error('transfer routes must run after authenticate');
  return request.clientId;
}

export interface TransferRouteDeps {
  orchestrator: OrchestratorPort;
  maxAmount: number;
  /** authenticate, then rateLimit (section 5: rate limiting is applied after authentication). */
  guards: preHandlerAsyncHookHandler[];
}

/** REST to gRPC and back for the two transfer routes. No transfer logic lives here. */
export function registerTransferRoutes(app: FastifyInstance, deps: TransferRouteDeps): void {
  const bodySchema = transferBodySchema(deps.maxAmount);

  app.post('/v1/transfers', { preHandler: deps.guards }, async (request, reply) => {
    const clientId = clientIdOf(request);
    const idempotencyKey = idempotencyKeyOf(request);
    const parsed = bodySchema.safeParse(request.body);
    if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'invalid transfer body', parsed.error.issues);
    const body = parsed.data;

    let response;
    try {
      response = await deps.orchestrator.createTransfer(
        {
          clientId,
          idempotencyKey,
          payer: { bankId: body.payer.bank_id, accountId: body.payer.account_id },
          payee: { bankId: body.payee.bank_id, accountId: body.payee.account_id },
          amount: String(body.amount),
          currency: body.currency,
          note: body.note ?? '',
        },
        request.id,
      );
    } catch (err) {
      throw mapGrpcError(err, 'create');
    }
    if (response.transfer === undefined) throw new Error('CreateTransfer returned no transfer');

    const resource = toTransferResource(response.transfer);
    const statusCode = createStatusCode(resource.state, response.replayed);
    if (statusCode === 202) void reply.header('location', `/v1/transfers/${resource.id}`);
    if (response.replayed) void reply.header('idempotent-replay', 'true');
    return reply.code(statusCode).send(resource);
  });

  app.get<{ Params: { id: string } }>('/v1/transfers/:id', { preHandler: deps.guards }, async (request, reply) => {
    const clientId = clientIdOf(request);
    let transfer;
    try {
      transfer = await deps.orchestrator.getTransfer(request.params.id, clientId, request.id);
    } catch (err) {
      throw mapGrpcError(err, 'get');
    }
    return reply.code(200).send(toTransferResource(transfer));
  });
}
