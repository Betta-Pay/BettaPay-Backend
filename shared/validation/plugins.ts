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

export type ErrorClass = 'fatal' | 'transient' | 'validation' | 'security' | 'business';

/**
 * Classify an error into an alerting-friendly category.
 *
 * - `fatal`      — infrastructure outage (DB unreachable, OOM, unhandled crash)
 * - `transient`  — retryable (rate limit, timeout, temporary upstream failure)
 * - `validation` — bad input (Zod, Prisma unique constraint, invalid request)
 * - `security`   — auth/authz failure (401, 403, invalid token)
 * - `business`   — domain rule violation (insufficient funds, duplicate settlement)
 */
export function classifyError(error: unknown, statusCode?: number): ErrorClass {
  // Prisma error codes
  const prismaCode = (error as { code?: string }).code;
  if (prismaCode === 'P1001' || prismaCode === 'P1002' || prismaCode === 'P1017') {
    return 'fatal'; // DB unreachable / connection refused
  }
  if (prismaCode === 'P2002' || prismaCode === 'P2025') {
    return 'validation'; // unique constraint / record not found
  }

  // Zod validation errors
  if (error instanceof z.ZodError) {
    return 'validation';
  }

  // Fastify rate-limit
  if ((error as { statusCode?: number }).statusCode === 429) {
    return 'transient';
  }

  // HTTP status-based classification
  if (statusCode === 401 || statusCode === 403) {
    return 'security';
  }
  if (statusCode === 400 || statusCode === 422) {
    return 'validation';
  }
  if (statusCode === 503 || statusCode === 504) {
    return 'transient';
  }

  // Network / timeout errors
  const msg = String((error as Error).message ?? '').toLowerCase();
  if (msg.includes('timeout') || msg.includes('econnrefused') || msg.includes('enotfound')) {
    return 'transient';
  }

  return 'fatal';
}

export const PII_FIELD_PATTERNS = [/email/i, /address/i, /secret/i, /key/i, /token/i];

export function isPiiField(path: (string | number)[]): boolean {
  return path.some((segment) =>
    typeof segment === 'string' && PII_FIELD_PATTERNS.some((re) => re.test(segment))
  );
}

export function redactPiiFromDetails(details: unknown): unknown {
  if (!Array.isArray(details)) return details;
  return details.map((item: Record<string, unknown>) => {
    const path: (string | number)[] = Array.isArray(item.path)
      ? (item.path as (string | number)[])
      : typeof item.instancePath === 'string'
        ? item.instancePath.split('/').filter(Boolean)
        : [];
    if (isPiiField(path)) {
      return { ...item, message: '[REDACTED]', received: undefined, data: undefined, value: undefined, params: undefined };
    }
    return item;
  });
}

const LEAK_PATTERNS = [
  /node_modules[/\\]/g,
  /\/[a-zA-Z0-9_/.-]+\.(ts|js|json)/g,
  /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET/gi,
  /postgres(ql)?(ql)?|mysql|redis|mongodb/gi,
  /at\s+\S+\s+\([^)]*\)/g,
  /\/home\/|\/usr\/|\/var\/|\/etc\//g,
  /password|secret|token|credential/gi,
];

export function sanitizeErrorMessage(message: string): string {
  let sanitized = message;
  for (const pattern of LEAK_PATTERNS) {
    sanitized = sanitized.replace(pattern, '[FILTERED]');
  }
  return sanitized;
}

export function registerErrorHandler(fastify: FastifyInstance, customLogger?: FastifyBaseLogger) {
  fastify.setErrorHandler((error, request, reply) => {
    const logger = customLogger || request.log || fastify.log;
    const reqId = request.id;

    if (error instanceof z.ZodError) {
      const response = createErrorResponse(ErrorCodes.VALIDATION_ERROR, 'Invalid request data', redactPiiFromDetails(error.errors), reqId);
      return reply.code(400).send(response);
    }

    if ((error as FastifyError).statusCode) {
      const fastifyErr = error as FastifyError & { validation?: unknown };
      const code = fastifyErr.code || ErrorCodes.INVALID_REQUEST;
      const details = fastifyErr.validation ? redactPiiFromDetails(fastifyErr.validation) : undefined;
      const response = createErrorResponse(code, sanitizeErrorMessage(fastifyErr.message), details, reqId);
      return reply.code(fastifyErr.statusCode!).send(response);
    }

    // Generic fallback for unhandled errors — assign a referenceId so the
    // client can quote it when reporting the problem, and the server log entry
    // ties back to exactly that request.
    const referenceId = crypto.randomUUID();
    const errorClass = classifyError(error);
    const errObj = error instanceof Error ? error : new Error(String(error));
    logger.error(
      { err: errObj, reqId: request.id, referenceId, errorClass, stack: errObj.stack },
      'Unhandled internal error',
    );

    return reply.code(500).send({
      error: 'Internal Server Error',
      statusCode: 500,
      referenceId,
      reqId,
    });
  });

  // Belt-and-suspenders: Fastify's onError lifecycle hook fires after the
  // error handler has run. We use it to catch any error that reaches this
  // stage without already having been converted to a response (e.g. errors
  // thrown inside reply serialization or other hooks). If the reply has
  // already been sent this is a no-op.
  fastify.addHook('onError', async (request, reply, error) => {
    if (reply.sent) return;

    const logger = customLogger || request.log || fastify.log;
    const referenceId = crypto.randomUUID();
    const errorClass = classifyError(error, reply.statusCode);
    const errObj = error instanceof Error ? error : new Error(String(error));

    logger.error(
      { err: errObj, reqId: request.id, referenceId, errorClass, stack: errObj.stack },
      'Panic recovery: unhandled error reached onError hook',
    );

    return reply.code(500).send({
      error: 'Internal Server Error',
      statusCode: 500,
      referenceId,
      reqId: request.id,
    });
  });
}

/**
 * Build a Set-Cookie header value for a CSRF cookie with transport-aware
 * Secure flag logic (#560).
 *
 * Previously the Secure flag was tied to NODE_ENV === 'production', which
 * meant staging HTTPS environments in NODE_ENV=development served cookies
 * without the Secure flag. This helper inspects the actual request protocol
 * (via the `protocol` field or `x-forwarded-proto` header) instead.
 *
 * @param name   cookie name
 * @param value  cookie value
 * @param request the incoming request (used to detect HTTPS)
 */
export function buildCsrfCookieHeader(
  name: string,
  value: string,
  request: { protocol?: string; headers?: Record<string, string | string[] | undefined> },
): string {
  const proto =
    request.protocol ||
    (Array.isArray(request.headers?.['x-forwarded-proto'])
      ? request.headers!['x-forwarded-proto'][0]
      : request.headers?.['x-forwarded-proto']) ||
    'http';
  const isHttps = proto.toLowerCase() === 'https';

  const parts = [`${name}=${value}`, 'Path=/', 'SameSite=Strict', 'HttpOnly'];
  if (isHttps) {
    parts.push('Secure');
  }
  return parts.join('; ');
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
 * Accepts either a single secret string or an array of valid secrets to
 * support key rotation: during a rotation window both the old and new key
 * are accepted. Once all consumers have switched, the old key can be removed.
 *
 * @param secret a single secret string, or an array of valid secrets
 */
export function createServiceAuth(
  secret: string | string[],
): (request: FastifyRequest, reply: FastifyReply) => Promise<void> {
  const secrets = Array.isArray(secret) ? secret : [secret];

  if (secrets.length === 0 || secrets.some((s) => !s)) {
    throw new Error('createServiceAuth: at least one non-empty INTER_SERVICE_SECRET is required');
  }

  // Compile-time dev-only guard (#548): the bypass flag must never be active
  // in production. If NODE_ENV is production and any secret looks like a
  // default/placeholder, throw immediately at startup so the misconfiguration
  // is caught before any request is served.
  if (process.env.NODE_ENV === 'production') {
    for (const s of secrets) {
      const lower = s.toLowerCase();
      if (
        lower.includes('dev-') ||
        lower.includes('test') ||
        lower.includes('change-me') ||
        lower === 'inter-service-secret-value'
      ) {
        throw new Error(
          'createServiceAuth: INTER_SERVICE_SECRET appears to be a development/test value. ' +
          'Set a strong secret before deploying to production.',
        );
      }
    }
  }

  return async function serviceAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const header = request.headers['x-service-token'];
    const token = Array.isArray(header) ? header[0] : header;

    const valid = token && secrets.some((s) => timingSafeStrEqual(token, s));
    if (!valid) {
      request.log?.warn({ reqId: request.id }, 'serviceAuth: missing or invalid service token');
      return reply
        .code(401)
        .send(createErrorResponse(ErrorCodes.UNAUTHORIZED, 'Invalid or missing service token'));
    }
  };
}

/**
 * Decorate a Fastify instance with `serviceAuth` so routes can use
 * `preValidation: [fastify.serviceAuth]` to require a valid service token.
 */
export function registerServiceAuth(fastify: FastifyInstance, secret: string | string[]): void {
  fastify.decorate('serviceAuth', createServiceAuth(secret));
}
