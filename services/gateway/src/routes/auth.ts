import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ApiError } from '../plugins/errorHandler';
import { unauthenticated, type ClientRegistry } from '../plugins/auth';

const tokenRequestSchema = z.strictObject({
  client_id: z.string().min(1).max(256),
  client_secret: z.string().min(1).max(1024),
});

/** `POST /v1/auth/token`: client credentials for an HS256 JWT (section 5). */
export function registerAuthRoutes(app: FastifyInstance, clients: ClientRegistry, ttlSeconds: number): void {
  app.post('/v1/auth/token', async (request, reply) => {
    const parsed = tokenRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'body must be {client_id, client_secret}', parsed.error.issues);
    }
    const { client_id: clientId, client_secret: clientSecret } = parsed.data;
    if (!clients.verify(clientId, clientSecret)) throw unauthenticated('invalid client credentials');

    const accessToken = await reply.jwtSign({ sub: clientId });
    return reply.code(200).send({ access_token: accessToken, token_type: 'Bearer', expires_in: ttlSeconds });
  });
}
