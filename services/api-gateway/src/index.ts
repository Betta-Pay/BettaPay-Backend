/**
 * API Gateway — BettaPay Backend
 *
 * Unified REST entry point for the BettaPay platform.
 * Handles merchant registration, payment sessions, and settlement requests.
 *
 * Endpoints:
 *   GET    /api/health               — liveness and dependency probe
 *   GET    /api/health/all           — aggregated health across all services
 *   POST   /api/merchants            — register merchant (protected)
 *   GET    /api/merchants/:id        — fetch merchant (protected)
 *   DELETE /api/merchants/:id        — soft-delete merchant (protected)
 *   POST   /api/merchants/:id/restore — restore soft-deleted merchant (protected)
 *   PATCH  /api/merchants/:id/settings — update merchant fee rules / settings (protected)
 *   POST   /api/payments             — initiate payment session (protected)
 *   GET    /api/payments/:id         — fetch payment session
 *   PATCH  /api/payments/:id/status  — transition payment status (protected)
 *   POST   /api/settlements          — trigger settlement (protected)
 *   GET    /api/deployments          — Soroban contract addresses (testnet)
 *   GET    /api/rates                — proxy to FX engine (timeout-aware)
 *   GET    /api/currencies           — proxy to FX engine (timeout-aware)
 *   GET    /api/quote                — proxy to FX engine (timeout-aware)
 */

import Fastify, { type FastifyRequest, type FastifyReply } from 'fastify';
import cors from '@fastify/cors';
import fastifyJwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import crypto from 'crypto';
import { z } from 'zod';
import { validateEnv, getPrismaLogLevels, setupPrismaQueryLogging, buildPrismaConnectionUrl, connectWithRetry, registerRequestId, createLoggerOptions, registerTracing, registerGracefulShutdown } from '@bettapay/validation';
import { createFxClient } from './clients/fx-client.js';
import { createIndexerClient } from './clients/indexer-client.js';
import {
  createSettlementClient,
  SettlementEngineUnavailableError,
} from './clients/settlement-client.js';
import {
  CreateMerchantBody,
  CreatePaymentBody,
  CreateSettlementBody,
  UpdatePaymentStatusBody,
  UpdateSettlementStatusBody,
  UpdateMerchantSettingsBody,
  UpdateMerchantNameBody,
  GoogleAuthBody,
  WalletChallengeQuery,
  WalletVerifyBody,
  createErrorResponse,
  ErrorCodes,
  registerErrorHandler,
  registerServiceAuth,
  createAuditLogger,
} from '@bettapay/validation';
import type { Merchant } from '@prisma/client';
import type { ApiResponse, PaginatedResponse } from '@bettapay/shared-types';
import { PrismaClient } from '@prisma/client';
import pg from 'pg';
import helmet from '@fastify/helmet';
import { PrismaPg } from '@prisma/adapter-pg';
import { fetchUpstream, UpstreamTimeoutError } from './upstream-fetch.js';
import { Keypair } from '@stellar/stellar-sdk';
import { OAuth2Client } from 'google-auth-library';
import { registerGatewayHealthRoutes } from './health.js';
import { readServiceVersion } from '@bettapay/validation';

declare module 'fastify' {
  export interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}



// Allowed payment status transitions. `initiated` is the only non-terminal state;
// completed, failed, and cancelled are terminal and cannot transition further.
const PAYMENT_STATUS_TRANSITIONS: Record<string, readonly string[]> = {
  initiated: ['completed', 'failed', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
};

const IDEMPOTENCY_KEY_MAX_LEN = 255;
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

function readIdempotencyKey(request: FastifyRequest): string | null {
  const raw = request.headers['idempotency-key'];
  if (!raw) return null;
  const key = Array.isArray(raw) ? raw[0] : raw;
  return (key as string).trim() || null;
}

const isProduction = process.env.NODE_ENV === 'production';

const env = validateEnv(process.env);
const PORT = Number(process.env.PORT ?? '3000');
const startTime = Date.now();
const SERVICE_VERSION = readServiceVersion(import.meta.url);

// --- Request lifecycle timeouts ---------------------------------------------
// REQUEST_TIMEOUT_MS bounds how long a single request may run. If a handler
// (e.g. a slow DB query or a hung upstream service) exceeds it, the per-request
// hook below replies 408 Request Timeout so the client connection is released
// instead of being held open and exhausting the connection pool.
//
// CONNECTION_TIMEOUT_MS is the socket-level backstop (set 1s higher). It closes
// any connection the request timeout did not already finish.
//
// IMPORTANT: keep both values BELOW any upstream load balancer / reverse proxy
// idle timeout (commonly 60s) so this gateway returns a clean 408 rather than
// the load balancer cutting the connection first.
const REQUEST_TIMEOUT_MS = 30_000;
const CONNECTION_TIMEOUT_MS = 31_000;

const fastify = Fastify({
  logger: createLoggerOptions({ level: env.LOG_LEVEL }),
  requestTimeout: REQUEST_TIMEOUT_MS,
  connectionTimeout: CONNECTION_TIMEOUT_MS,
  // Limit request body size to 1MB (1,048,576 bytes) to protect the API gateway
  // from oversized payload attacks and align with typical financial transaction payload sizes.
  bodyLimit: 1_048_576,
});

registerRequestId(fastify);

registerErrorHandler(fastify);
// Distributed tracing: normalise x-request-id / x-trace-id and bind to the
// request logger so trace context is logged and propagated downstream (#118).
registerTracing(fastify);
registerServiceAuth(fastify, env.INTER_SERVICE_SECRET);

// Indexer HTTP client for optional on-chain event enrichment (Issue #116).
// Enrichment is best-effort: indexer failures degrade to payment-only responses.
const indexerClient = createIndexerClient({
  baseUrl: env.INDEXER_URL,
  serviceToken: env.INTER_SERVICE_SECRET,
  logger: fastify.log,
});

const settlementClient = createSettlementClient({
  baseUrl: env.SETTLEMENT_ENGINE_URL,
  serviceToken: env.INTER_SERVICE_SECRET,
  logger: fastify.log,
});

const fxClient = createFxClient({
  baseUrl: env.FX_ENGINE_URL,
  serviceToken: env.INTER_SERVICE_SECRET,
  logger: fastify.log,
});

// --- Response logging hooks -------------------------------------------------
const SENSITIVE_FIELDS = new Set(['token', 'secret', 'secretHash', 'password', 'privateKey', 'secretKey']);
const CONTROL_CHARS_EXCEPT_NEWLINES_AND_TABS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

function sanitizeString(value: string): string {
  return value
    .trim()
    .replace(CONTROL_CHARS_EXCEPT_NEWLINES_AND_TABS, '')
    .normalize('NFC');
}

function sanitizeInput(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') {
    return sanitizeString(value);
  }

  if (Array.isArray(value)) {
    return value.map(item => sanitizeInput(item, seen));
  }

  if (value && typeof value === 'object') {
    if (seen.has(value)) return value;
    seen.add(value);

    const record = value as Record<string, unknown>;
    for (const [key, nestedValue] of Object.entries(record)) {
      record[key] = sanitizeInput(nestedValue, seen);
    }
  }

  return value;
}

function redactValue(value: any): any {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(redactValue);
  if (typeof value === 'object') return redactObject(value);
  return value;
}

function redactObject(obj: Record<string, any>) {
  const out: Record<string, any> = {};
  for (const k of Object.keys(obj)) {
    try {
      if (SENSITIVE_FIELDS.has(k)) {
        out[k] = '[REDACTED]';
      } else {
        out[k] = redactValue(obj[k]);
      }
    } catch (e) {
      out[k] = '[REDACTION_ERROR]';
    }
  }
  return out;
}

fastify.addHook('onRequest', async (request, reply) => {
  // Mark request start for response time calculation
  (request as any).__startTime = Date.now();

  // Per-request timeout guard. Fastify's requestTimeout only bounds how long the
  // client takes to *send* a request; it does not abort a slow handler. This timer
  // covers that case: if the response is not sent within REQUEST_TIMEOUT_MS, reply
  // 408 so the caller is not left hanging. (The slow handler keeps running, but the
  // client connection is freed.) The timer is cleared in the onResponse hook below.
  const timeoutTimer = setTimeout(() => {
    if (!reply.sent) {
      reply.code(408).send(createErrorResponse(ErrorCodes.REQUEST_TIMEOUT, 'Request Timeout'));
    }
  }, REQUEST_TIMEOUT_MS);
  (request as any).__timeoutTimer = timeoutTimer;
});

fastify.addHook('onResponse', async (request) => {
  const timeoutTimer = (request as any).__timeoutTimer;
  if (timeoutTimer) clearTimeout(timeoutTimer);
});

fastify.addHook('onSend', async (request, reply, payload) => {
  try {
    const headers = request.headers as Record<string, any>;
    const reqId = (headers['x-request-id'] as string) || (request.id as string) || 'unknown';
    const method = request.method;
    const url = request.url;
    const statusCode = reply.statusCode || 0;
    const start = (request as any).__startTime || Date.now();
    const responseTime = Date.now() - start;

    const baseLog = { reqId, method, url, statusCode, responseTime };

    if (statusCode >= 400) {
      // attempt to parse payload (may be string, Buffer, object)
      let body: any = payload;
      try {
        if (typeof payload === 'string') body = JSON.parse(payload as string);
      } catch (e) {
        // leave as raw string
      }

      const safeBody = typeof body === 'object' && body !== null ? redactObject(body as Record<string, any>) : body;
      fastify.log.warn({ ...baseLog, response: safeBody }, 'Error response');
    } else {
      fastify.log.info(baseLog, 'Response summary');
    }
  } catch (err) {
    fastify.log.error({ err }, 'onSend hook failed');
  }

  return payload;
});

function hashSecret(secret: string): string {
  return crypto.createHash('sha256').update(secret).digest('hex');
}

const pool = new pg.Pool({
  connectionString: buildPrismaConnectionUrl(env.DATABASE_URL, env.DATABASE_POOL_SIZE, env.DATABASE_POOL_TIMEOUT),
  max: env.DATABASE_POOL_SIZE,
  connectionTimeoutMillis: env.DATABASE_POOL_TIMEOUT * 1000,
});
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter, log: getPrismaLogLevels() });
setupPrismaQueryLogging(prisma, fastify.log);
const logAuditEvent = createAuditLogger(prisma as unknown as Parameters<typeof createAuditLogger>[0], fastify.log);

// Setup plugins
fastify.register(helmet, { contentSecurityPolicy: false, hsts: { maxAge: 31536000 }, referrerPolicy: { policy: 'no-referrer' } });

fastify.register(cors, {
  origin: env.ALLOWED_ORIGINS,
  credentials: true
});

fastify.register(fastifyJwt, {
  secret: env.JWT_SECRET,
  sign: {
    expiresIn: env.JWT_EXPIRES_IN
  }
});

// Rate limiting: global default and route overrides
fastify.register(rateLimit, {
  max: 1000,
  timeWindow: '1 minute',
  addHeaders: {
    'x-ratelimit-limit': true,
    'x-ratelimit-remaining': true,
    'x-ratelimit-reset': true,
    'retry-after': true
  }
});

fastify.register(rateLimit, {
  max: 100,
  timeWindow: '1 minute',
});

// Request body logging for mutation endpoints
async function logRequestBody(request: FastifyRequest, reply: FastifyReply) {
  if (request.body && typeof request.body === 'object') {
    const cloned = JSON.parse(JSON.stringify(request.body));
    for (const key of SENSITIVE_FIELDS) {
      if (key in cloned) {
        cloned[key] = '[REDACTED]';
      }
    }
    const logLevel = isProduction ? 'debug' : 'info';
    request.log[logLevel]({ requestId: request.id, body: cloned }, 'incoming request body');
  }
}



// Authentication hook
fastify.decorate('authenticate', async function (request: FastifyRequest, reply: FastifyReply) {
  try {
    await request.jwtVerify();
  } catch (err) {
    request.log.error(err);
    reply.code(401).send(createErrorResponse(ErrorCodes.UNAUTHORIZED, 'Unauthorized'));
  }
});

fastify.addHook('preHandler', async (request) => {
  if (request.body !== undefined) {
    request.body = sanitizeInput(request.body);
  }
});

// Zod validation runs inside route handlers after this global preHandler, so
// schemas receive trimmed, control-character-free, NFC-normalized strings.

// Routes
registerGatewayHealthRoutes({
  fastify,
  prisma,
  env: {
    FX_ENGINE_URL: env.FX_ENGINE_URL,
    SETTLEMENT_ENGINE_URL: env.SETTLEMENT_ENGINE_URL,
    INDEXER_URL: env.INDEXER_URL,
  },
  startTime,
  serviceVersion: SERVICE_VERSION,
});

// --- Wallet Auth Challenge Store ----------------------------------------------
// TODO: migrate to Redis for multi-instance deployments
const challengeMap = new Map<string, { challenge: string; expiresAt: number }>();

fastify.get<{ Querystring: WalletChallengeQuery }>('/api/auth/wallet/challenge', {
  config: { rateLimit: { max: 10, timeWindow: '1 minute' } }
}, async (request, reply) => {
  const { address } = WalletChallengeQuery.parse(request.query);
  const nonce = crypto.randomBytes(32).toString('hex');
  const challenge = `BettaPay:${address}:${nonce}`;
  const expiresAt = Date.now() + 2 * 60 * 1000; // 2 minutes
  challengeMap.set(address, { challenge, expiresAt });
  return reply.send({ challenge, expiresAt });
});

fastify.post<{ Body: WalletVerifyBody }>('/api/auth/wallet/verify', {
  config: { rateLimit: { max: 10, timeWindow: '1 minute' } }
}, async (request, reply) => {
  const d = WalletVerifyBody.parse(request.body);
  const stored = challengeMap.get(d.address);
  
  if (!stored) {
    return reply.code(400).send({ error: 'Challenge expired or not found' });
  }
  if (Date.now() > stored.expiresAt) {
    challengeMap.delete(d.address);
    return reply.code(400).send({ error: 'Challenge expired' });
  }
  if (stored.challenge !== d.challenge) {
    return reply.code(400).send({ error: 'Invalid challenge' });
  }
  
  challengeMap.delete(d.address); // Single use
  
  try {
    const keypair = Keypair.fromPublicKey(d.address);
    const isValid = keypair.verify(Buffer.from(d.challenge, 'utf-8'), Buffer.from(d.signature, 'base64'));
    if (!isValid) {
      return reply.code(401).send({ error: 'Invalid signature' });
    }
  } catch (err) {
    return reply.code(401).send({ error: 'Signature verification failed' });
  }
  
  const merchant = await prisma.merchant.upsert({
    where: { ownerId: d.address },
    update: {},
    create: {
      id: crypto.randomUUID(),
      name: 'My Business',
      ownerId: d.address,
      settings: {}
    }
  });
  
  const token = fastify.jwt.sign({ merchantId: merchant.id, ownerId: merchant.ownerId });
  return reply.send({ token });
});

const googleClient = new OAuth2Client(env.GOOGLE_CLIENT_ID);

fastify.post<{ Body: GoogleAuthBody }>('/api/auth/google', {
  config: { rateLimit: { max: 10, timeWindow: '1 minute' } }
}, async (request, reply) => {
  const d = GoogleAuthBody.parse(request.body);
  
  try {
    const ticket = await googleClient.verifyIdToken({
      idToken: d.idToken,
      audience: env.GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();
    if (!payload || !payload.email) {
      return reply.code(401).send({ error: 'Invalid Google payload' });
    }
    
    const merchant = await prisma.merchant.upsert({
      where: { ownerId: payload.email },
      update: {},
      create: {
        id: crypto.randomUUID(),
        name: payload.name || 'My Business',
        ownerId: payload.email,
        settings: {}
      }
    });
    
    const token = fastify.jwt.sign({ merchantId: merchant.id, ownerId: merchant.ownerId });
    return reply.send({ token });
  } catch (err) {
    return reply.code(401).send({ error: 'Google authentication failed' });
  }
});

// Merchants
fastify.post<{ Body: z.infer<typeof CreateMerchantBody> }>('/api/merchants', {
  preValidation: [fastify.authenticate],
  preHandler: [logRequestBody],
  config: { rateLimit: { max: 30, timeWindow: '1 minute' } }
}, async (request, reply) => {
    const d = CreateMerchantBody.parse(request.body);
    const secret = d.secret || crypto.randomBytes(24).toString('hex');
    const secretHash = hashSecret(secret);
    const merchant = await prisma.$transaction(async (tx) => {
      const created = await tx.merchant.create({
        data: {
          id: d.id,
          name: d.name,
          ownerId: d.ownerId,
          settings: d.settings as any ?? {},
          secretHash,
        }
      });
      await logAuditEvent('merchant.created', 'merchant', created.id, { before: null, after: created }, request, tx as unknown as Parameters<typeof logAuditEvent>[5]);
      return created;
    });
    return reply.code(201).send({ success: true, merchant, secret });
});

fastify.get<{ Params: { id: string } }>('/api/merchants/:id', {
  preValidation: [fastify.authenticate]
}, async (request, reply): Promise<ApiResponse<Merchant>> => {
  const { id } = request.params;
  const merchant = await prisma.merchant.findFirst({
    where: { id, deletedAt: null },
  });
  if (!merchant) {
    reply.code(404);
    return { error: createErrorResponse(ErrorCodes.NOT_FOUND, 'Merchant not found') };
  }
  return { data: merchant };
});

fastify.delete<{ Params: { id: string } }>('/api/merchants/:id', {
  preValidation: [fastify.authenticate],
  config: { rateLimit: { max: 30, timeWindow: '1 minute' } }
}, async (request, reply) => {
  const { id } = request.params;
  const merchant = await prisma.merchant.findFirst({
    where: { id, deletedAt: null },
  });
  if (!merchant) return reply.code(404).send(createErrorResponse(ErrorCodes.NOT_FOUND, 'Merchant not found'));

  await prisma.$transaction(async (tx) => {
    const updated = await tx.merchant.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
    await logAuditEvent('merchant.deleted', 'merchant', updated.id, { before: merchant, after: updated }, request, tx as unknown as Parameters<typeof logAuditEvent>[5]);
  });

  return reply.code(200).send({ success: true });
});

fastify.post<{ Params: { id: string } }>('/api/merchants/:id/restore', {
  preValidation: [fastify.authenticate],
  config: { rateLimit: { max: 30, timeWindow: '1 minute' } }
}, async (request, reply) => {
  const { id } = request.params;
  const merchant = await prisma.merchant.findUnique({ where: { id } });
  if (!merchant) return reply.code(404).send(createErrorResponse(ErrorCodes.NOT_FOUND, 'Merchant not found'));
  if (!merchant.deletedAt) {
    return reply.code(400).send(createErrorResponse(ErrorCodes.INVALID_REQUEST, 'Merchant is not soft-deleted'));
  }

  const restored = await prisma.merchant.update({
    where: { id },
    data: { deletedAt: null },
  });

  return reply.code(200).send({ success: true, merchant: restored });
});

// Update per-merchant settings (fee rules, tier). Merges into existing settings so
// a partial update does not wipe unrelated keys. The settlement engine reads
// settings.feeBps from here when computing fees.
fastify.patch<{ Params: { id: string }; Body: z.infer<typeof UpdateMerchantSettingsBody> }>('/api/merchants/:id/settings', {
  preValidation: [fastify.authenticate],
  preHandler: [logRequestBody],
  config: { rateLimit: { max: 30, timeWindow: '1 minute' } }
}, async (request, reply) => {
  const d = UpdateMerchantSettingsBody.parse(request.body);

  const { id } = request.params;
  const merchant = await prisma.merchant.findFirst({ where: { id, deletedAt: null } });
  if (!merchant) return reply.code(404).send(createErrorResponse(ErrorCodes.NOT_FOUND, 'Merchant not found'));

  const currentSettings = (merchant.settings ?? {}) as Record<string, unknown>;
  const nextSettings = { ...currentSettings, ...d };

  const updated = await prisma.$transaction(async (tx) => {
    const merchantUpdate = await tx.merchant.update({
      where: { id },
      data: { settings: nextSettings as object },
    });
    await logAuditEvent('merchant.updated', 'merchant', merchantUpdate.id, { before: merchant, after: merchantUpdate }, request, tx as unknown as Parameters<typeof logAuditEvent>[5]);
    return merchantUpdate;
  });

  return reply.code(200).send({ success: true, merchant: updated });
});

// Payments
fastify.post<{ Body: z.infer<typeof CreatePaymentBody> }>('/api/payments', {
  preValidation: [fastify.authenticate],
  preHandler: [logRequestBody],
  config: { rateLimit: { max: 300, timeWindow: '1 minute' } }
}, async (request, reply) => {
  // ── 1. Parse and validate request body ──────────────────────────────────────
  const d = CreatePaymentBody.parse(request.body);

  // ── 2. Read and validate optional Idempotency-Key header ────────────────────
  const idempotencyKey = readIdempotencyKey(request);

  if (idempotencyKey !== null && idempotencyKey.length > IDEMPOTENCY_KEY_MAX_LEN) {
    return reply.code(400).send(createErrorResponse(ErrorCodes.VALIDATION_ERROR, 'Idempotency-Key must not exceed 255 characters'));
  }

  // ── 3. Idempotency check: look for a non-expired record with the same key ───
  if (idempotencyKey !== null) {
    const now = new Date();
    const existing = await prisma.payment.findFirst({
      where: {
        idempotencyKey,
        idempotencyKeyExpiresAt: { gt: now },
      },
    });

    if (existing) {
      request.log.info(
        { idempotencyKey, paymentId: existing.id },
        'Idempotency hit — returning cached payment'
      );
      return reply.code(200).send(existing);
    }
  }

  // ── 4. Create the payment (with idempotency fields when a key was supplied) ──
  const idempotencyKeyExpiresAt = idempotencyKey
    ? new Date(Date.now() + IDEMPOTENCY_TTL_MS)
    : null;

    const fxQuote = d.convertTo
      ? await fxClient.getQuote(
          { from: d.asset, to: d.convertTo, amount: d.amount },
          request.headers,
        )
      : null;

    const payment = await prisma.$transaction(async (tx) => {
      const created = await tx.payment.create({
        data: {
          id: 'pay_' + crypto.randomUUID().replace(/-/g, ''),
          merchantId: d.merchantId,
          payerId: d.payerId,
          amount: d.amount,
          asset: d.asset,
          reference: d.reference,
          status: 'initiated',
          idempotencyKey: idempotencyKey ?? undefined,
          idempotencyKeyExpiresAt: idempotencyKeyExpiresAt ?? undefined,
        },
      });
      await logAuditEvent('payment.created', 'payment', created.id, { before: null, after: created }, request, tx as unknown as Parameters<typeof logAuditEvent>[5]);
      return created;
    });

    request.log.info(
      { idempotencyKey, paymentId: payment.id },
      idempotencyKey ? 'Idempotency miss — payment created' : 'Payment created (no idempotency key)'
    );

    if (d.convertTo) {
      return reply.code(201).send({ ...payment, fxQuote });
    }

    return reply.code(201).send(payment);
});

fastify.get<{ Params: { id: string }; Querystring: { includeEvents?: string } }>('/api/payments/:id', async (request, reply) => {
  const { id } = request.params;
  const payment = await prisma.payment.findUnique({ where: { id } });
  if (!payment) return reply.code(404).send(createErrorResponse(ErrorCodes.NOT_FOUND, 'Payment not found'));

  // Optional on-chain event enrichment (?includeEvents=true). The indexer is an
  // enrichment source only: if it is unavailable, `events` is null and the
  // payment is still returned so the endpoint never fails on indexer issues.
  if (request.query.includeEvents === 'true') {
    // Forward tracing headers so the indexer call is part of the same trace (#118).
    const events = await indexerClient.getPaymentEvents(payment.merchantId, request.headers);
    return { ...payment, events };
  }

  return payment;
});

// Enforce valid status transitions. The DB enum and Prisma allow any status, so
// this route is the single place that guards the payment state machine.
fastify.patch<{ Params: { id: string }; Body: z.infer<typeof UpdatePaymentStatusBody> }>('/api/payments/:id/status', {
  preValidation: [fastify.authenticate],
  preHandler: [logRequestBody],
  config: { rateLimit: { max: 300, timeWindow: '1 minute' } }
}, async (request, reply) => {
  const d = UpdatePaymentStatusBody.parse(request.body);

  const { id } = request.params;
  const payment = await prisma.payment.findUnique({ where: { id } });
  if (!payment) return reply.code(404).send(createErrorResponse(ErrorCodes.NOT_FOUND, 'Payment not found'));

  const allowed = PAYMENT_STATUS_TRANSITIONS[payment.status] ?? [];
  if (!allowed.includes(d.status)) {
    return reply.code(422).send(createErrorResponse(ErrorCodes.VALIDATION_ERROR, 'Invalid status transition', {
      from: payment.status,
      to: d.status,
    }));
  }

  const updated = await prisma.$transaction(async (tx) => {
    const paymentUpdate = await tx.payment.update({
      where: { id },
      data: { status: d.status },
    });
    await logAuditEvent('payment.status.changed', 'payment', paymentUpdate.id, { before: payment, after: paymentUpdate }, request, tx as unknown as Parameters<typeof logAuditEvent>[5]);
    return paymentUpdate;
  });
  return reply.send(updated);
});

fastify.patch<{ Params: { id: string }; Body: z.infer<typeof UpdateSettlementStatusBody> }>('/api/settlements/:id/status', {
  preValidation: [fastify.authenticate],
  preHandler: [logRequestBody],
  config: { rateLimit: { max: 30, timeWindow: '1 minute' } }
}, async (request, reply) => {
  let d;
  try {
    d = UpdateSettlementStatusBody.parse(request.body);
  } catch (error) {
    return reply.code(400).send(createErrorResponse(ErrorCodes.VALIDATION_ERROR, 'Invalid request body', error));
  }

  const { id } = request.params;
  const settlement = await prisma.settlement.findUnique({ where: { id } });
  if (!settlement) return reply.code(404).send(createErrorResponse(ErrorCodes.NOT_FOUND, 'Settlement not found'));

  const SETTLEMENT_STATUS_TRANSITIONS: Record<string, readonly string[]> = {
    PENDING: ['PROCESSING', 'FAILED'],
    PROCESSING: ['COMPLETED', 'FAILED'],
    COMPLETED: [],
    FAILED: []
  };

  const allowed = SETTLEMENT_STATUS_TRANSITIONS[settlement.status] ?? [];
  if (!allowed.includes(d.status)) {
    return reply.code(422).send({
      error: 'Invalid status transition',
      from: settlement.status,
      to: d.status,
    });
  }

  const updated = await prisma.$transaction(async (tx) => {
    const settlementUpdate = await tx.settlement.update({
      where: { id },
      data: {
        status: d.status,
        ...(d.status === 'completed' || d.status === 'failed' ? { completedAt: new Date() } : {}),
      }
    });
    await logAuditEvent('settlement.status.changed', 'settlement', settlementUpdate.id, { before: settlement, after: settlementUpdate }, request, tx as unknown as Parameters<typeof logAuditEvent>[5]);
    return settlementUpdate;
  });
  return reply.send(updated);
});

// Settlements
fastify.get('/api/settlements', {
  preValidation: [fastify.authenticate],
  config: { rateLimit: { max: 100, timeWindow: '1 minute' } }
}, async (request, reply) => {
  const { merchantId, from, to } = request.query as { merchantId?: string; from?: string; to?: string };
  const where: any = {};
  if (merchantId) {
    where.merchantId = merchantId;
  }
  if (from || to) {
    where.initiatedAt = {};
    if (from) {
      where.initiatedAt.gte = new Date(from);
    }
    if (to) {
      where.initiatedAt.lte = new Date(to);
    }
  }

  const records = await prisma.settlement.findMany({
    where,
    orderBy: { initiatedAt: 'desc' },
  });
  return { settlements: records, total: records.length };
});

fastify.post<{ Body: z.infer<typeof CreateSettlementBody> }>('/api/settlements', {
  preValidation: [fastify.authenticate],
  preHandler: [logRequestBody],
  config: { rateLimit: { max: 30, timeWindow: '1 minute' } }
}, async (request, reply) => {
    const d = CreateSettlementBody.parse(request.body);
    const merchant = await prisma.merchant.findUnique({ where: { id: d.merchantId } });
    
    if (!merchant) {
      return reply.code(404).send(createErrorResponse(ErrorCodes.NOT_FOUND, 'Merchant not found'));
    }

    const settings = merchant.settings as {
      webhookUrl?: string;
      minSettlementAmount?: string;
      maxSettlementAmount?: string;
      dailySettlementLimit?: string;
    } | null | undefined;

    // Normalize to items array (backward compatibility: single amount/asset becomes single-item batch)
    const items = d.items || (d.amount && d.asset ? [{ amount: d.amount, asset: d.asset }] : []);

    // Validate each settlement item against merchant limits
    for (const item of items) {
      const amount = parseFloat(item.amount);

      // Check minimum settlement amount
      if (settings?.minSettlementAmount) {
        const minAmount = parseFloat(settings.minSettlementAmount);
        if (amount < minAmount) {
          return reply.code(422).send(createErrorResponse(
            ErrorCodes.VALIDATION_ERROR,
            `Settlement amount ${item.amount} is below minimum ${settings.minSettlementAmount}`,
            { amount: item.amount, minSettlementAmount: settings.minSettlementAmount }
          ));
        }
      }

      // Check maximum settlement amount
      if (settings?.maxSettlementAmount) {
        const maxAmount = parseFloat(settings.maxSettlementAmount);
        if (amount > maxAmount) {
          return reply.code(422).send(createErrorResponse(
            ErrorCodes.VALIDATION_ERROR,
            `Settlement amount ${item.amount} exceeds maximum ${settings.maxSettlementAmount}`,
            { amount: item.amount, maxSettlementAmount: settings.maxSettlementAmount }
          ));
        }
      }
    }

    // Check daily settlement limit (aggregate all assets)
    if (settings?.dailySettlementLimit) {
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);

      const todaySettlements = await prisma.settlement.findMany({
        where: {
          merchantId: d.merchantId,
          initiatedAt: { gte: todayStart },
        },
        select: {
          totalAmount: true
        }
      });

      const currentDailyTotal = todaySettlements.reduce((sum: number, s: { totalAmount: string }) => sum + parseFloat(s.totalAmount), 0);
      const requestTotal = items.reduce((sum: number, item: any) => sum + parseFloat(item.amount), 0);
      const newDailyTotal = currentDailyTotal + requestTotal;
      const dailyLimit = parseFloat(settings.dailySettlementLimit);

      if (newDailyTotal > dailyLimit) {
        return reply.code(422).send(createErrorResponse(
          ErrorCodes.VALIDATION_ERROR,
          `Daily settlement limit exceeded. Current: ${currentDailyTotal}, Requested: ${requestTotal}, Limit: ${settings.dailySettlementLimit}`,
          {
            currentDailyTotal: currentDailyTotal.toString(),
            requestedAmount: requestTotal.toString(),
            dailySettlementLimit: settings.dailySettlementLimit,
          }
        ));
      }
    }

    try {
      const settlementResponse = await settlementClient.createSettlement(d, request.headers);
      return reply
        .code(settlementResponse.status)
        .type(settlementResponse.contentType)
        .send(settlementResponse.body);
    } catch (err) {
      if (err instanceof SettlementEngineUnavailableError) {
        request.log.warn({ err }, 'settlement-engine unavailable during settlement creation');
        return reply
          .code(504)
          .send(createErrorResponse(ErrorCodes.GATEWAY_TIMEOUT, 'Settlement engine unavailable'));
      }
      throw err;
    }
});

fastify.get('/api/admin/audit-log', {
  preValidation: [fastify.serviceAuth],
  config: { rateLimit: { max: 100, timeWindow: '1 minute' } }
}, async (request, reply) => {
  const query = request.query as Record<string, string | undefined>;
  const limit = Math.min(Number(query.limit ?? 50), 200);
  const offset = Math.max(Number(query.offset ?? 0), 0);
  const where: Record<string, unknown> = {};

  if (query.entityType) {
    where.entityType = query.entityType;
  }
  if (query.action) {
    where.action = query.action;
  }
  if (query.startDate || query.endDate) {
    where.createdAt = {};
    if (query.startDate) {
      (where.createdAt as Record<string, Date>).gte = new Date(query.startDate);
    }
    if (query.endDate) {
      (where.createdAt as Record<string, Date>).lte = new Date(query.endDate);
    }
  }

  const [rows, total] = await Promise.all([
    prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit,
      skip: offset,
    }),
    prisma.auditLog.count({ where }),
  ]);

  return reply.send({ logs: rows, total, limit, offset, hasMore: offset + limit < total });
});

fastify.get('/api/deployments', async (request, reply) => {
  return {
    network: env.STELLAR_NETWORK_PASSPHRASE,
    contracts: [
      {
        name: 'Settlement contract',
        contractId: env.SETTLEMENT_CONTRACT_ID,
        explorerUrl: `https://lab.stellar.org/r/testnet/contract/${env.SETTLEMENT_CONTRACT_ID}`,
      },
      {
        name: 'Governance contract',
        contractId: env.GOVERNANCE_CONTRACT_ID,
        explorerUrl: `https://lab.stellar.org/r/testnet/contract/${env.GOVERNANCE_CONTRACT_ID}`,
      },
    ],
    updatedAt: new Date().toISOString(),
  };
});

async function proxyFxUpstream(
  request: FastifyRequest,
  reply: FastifyReply,
  path: string
) {
  const targetUrl = new URL(path, env.FX_ENGINE_URL).toString();

  try {
    const response = await fetchUpstream(request, targetUrl, {}, request.log);
    const body = await response.text();
    const contentType = response.headers.get('content-type') ?? 'application/json';
    return reply.code(response.status).type(contentType).send(body);
  } catch (err) {
    if (err instanceof UpstreamTimeoutError) {
      return reply
        .code(504)
        .send(createErrorResponse(ErrorCodes.GATEWAY_TIMEOUT, 'Gateway Timeout'));
    }
    throw err;
  }
}

fastify.get('/api/rates', async (request, reply) => proxyFxUpstream(request, reply, '/api/rates'));
fastify.get('/api/currencies', async (request, reply) => proxyFxUpstream(request, reply, '/api/currencies'));
fastify.get('/api/quote', async (request, reply) => {
  const query = new URLSearchParams(request.query as Record<string, string>).toString();
  const path = query ? `/api/quote?${query}` : '/api/quote';
  return proxyFxUpstream(request, reply, path);
});

// Graceful shutdown — delegated to the shared helper in @bettapay/validation.
// It closes the HTTP server first, then disconnects Prisma, exiting 0 on
// success or 1 on failure. A 30s force-exit timeout guards against a hang.
registerGracefulShutdown({ fastify, prisma });

const start = async () => {
  try {
    await connectWithRetry(prisma, fastify.log);

    await fastify.listen({ port: PORT, host: '0.0.0.0' });
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};
start();
