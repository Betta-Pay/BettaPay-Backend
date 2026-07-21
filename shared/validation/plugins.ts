import { FastifyInstance, FastifyError, FastifyBaseLogger, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import crypto from 'crypto';
import { createErrorResponse, ErrorCodes } from './index.js';

// Makes `fastify.serviceAuth` available as a typed decorator/preValidation hook.
declare module 'fastify' {
  interface FastifyInstance {
    serviceAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

export function registerErrorHandler(fastify: FastifyInstance, customLogger?: FastifyBaseLogger) {
  fastify.setErrorHandler((error, request, reply) => {
    const logger = customLogger || request.log || fastify.log;

    if (error instanceof z.ZodError) {
      const response = createErrorResponse(ErrorCodes.VALIDATION_ERROR, 'Invalid request data', error.errors);
      return reply.code(400).send(response);
    }

    if ((error as FastifyError).statusCode) {
      const fastifyErr = error as FastifyError;
      // Use the attached status code. Preserve the safe message.
      const code = fastifyErr.code || ErrorCodes.INVALID_REQUEST;
      const response = createErrorResponse(code, fastifyErr.message);
      return reply.code(fastifyErr.statusCode!).send(response);
    }

    // Generic fallback for unhandled errors
    logger.error({ err: error, reqId: request.id }, 'Unhandled internal error');

    // In production, do not leak stack traces or internal details
    const response = createErrorResponse(ErrorCodes.INTERNAL_ERROR, 'Internal server error');
    return reply.code(500).send(response);
  });
}

/**
 * Constant-time string equality. Avoids leaking secret length/contents through
 * early-exit timing. Returns false for length mismatches (after a same-length
 * compare to keep timing uniform).
 */
export function timingSafeStrEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) {
    crypto.timingSafeEqual(ab, ab);
    return false;
  }
  return crypto.timingSafeEqual(ab, bb);
}

/**
 * Build a Fastify preValidation handler that authenticates inter-service calls.
 *
 * Internal (service-to-service) endpoints should present the shared
 * `INTER_SERVICE_SECRET` in the `x-service-token` header. Requests without a
 * valid token are rejected with 401 before the route handler runs.
 *
 * @param secret the shared INTER_SERVICE_SECRET
 */
export function createServiceAuth(
  secret: string,
): (request: FastifyRequest, reply: FastifyReply) => Promise<void> {
  if (!secret) {
    throw new Error('createServiceAuth: a non-empty INTER_SERVICE_SECRET is required');
  }

  return async function serviceAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const header = request.headers['x-service-token'];
    const token = Array.isArray(header) ? header[0] : header;

    if (!token || !timingSafeStrEqual(token, secret)) {
      request.log?.warn({ reqId: request.id }, 'serviceAuth: missing or invalid service token');
      await reply
        .code(401)
        .send(createErrorResponse(ErrorCodes.UNAUTHORIZED, 'Invalid or missing service token'));
    }
  };
}

/**
 * Decorate a Fastify instance with `serviceAuth` so routes can use
 * `preValidation: [fastify.serviceAuth]` to require a valid service token.
 */
export function registerServiceAuth(fastify: FastifyInstance, secret: string): void {
  fastify.decorate('serviceAuth', createServiceAuth(secret));
}
