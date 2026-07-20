/**
 * Settlement Engine — BettaPay Backend
 *
 * Handles settlement processing with fee deduction and audit trail.
 *
 * Endpoints:
 *   GET  /api/health              — dependency and upstream health probe
 *   GET  /api/settlements         — list settlements (paginated)
 *   POST /api/settlements         — create and process a settlement
 *
 * Precision strategy
 * ──────────────────
 * All monetary arithmetic uses BigNumber.js (ROUND_DOWN, no floating-point).
 * Fee basis points are applied as:
 *   feeAmount  = floor(grossAmount × feeBps / 10 000, asset decimals)
 *   netAmount  = grossAmount − feeAmount
 *
 * All three amounts (grossAmount, feeAmount, netAmount) are stored as
 * decimal strings so the database never loses sub-cent precision for
 * assets like USDC (6 dp) or XLM (7 dp).
 */

import Fastify from 'fastify';
import { z } from 'zod';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import * as crypto from 'crypto';
import { Redis } from 'ioredis';
import { Queue, Worker } from 'bullmq';
import { PrismaClient } from '@prisma/client';
import BigNumber from 'bignumber.js';
import { createWebhookQueue, createWebhookWorker } from '@bettapay/webhook-delivery';
import { computeSettlementAmounts } from './settlement-amounts.js';
import {
  validateEnv,
  CreateSettlementBody,
  registerErrorHandler,
  registerRequestId,
  createErrorResponse,
  ErrorCodes,
  FeeRule,
  SettlementListQuery,
  getPrismaLogLevels,
  setupPrismaQueryLogging,
  buildPrismaConnectionUrl,
  connectWithRetry,
  createLoggerOptions,
  registerTracing,
  buildSettlementEngineHealthResponse,
  readServiceVersion,
  registerGracefulShutdown,
} from "@bettapay/validation";
import type { PaginatedResponse, ApiResponse } from '@bettapay/shared-types';



const env = validateEnv(process.env);
const PORT = Number(process.env.PORT ?? '3001');
const startTime = Date.now();
const SERVICE_VERSION = readServiceVersion(import.meta.url);

process.env.DATABASE_URL = buildPrismaConnectionUrl(
  env.DATABASE_URL,
  env.DATABASE_POOL_SIZE,
  env.DATABASE_POOL_TIMEOUT,
);
const prisma = new PrismaClient({ log: getPrismaLogLevels() });

type SettlementJobData = {
  id: string;
  merchantId: string;
  grossAmount: string;
  asset: string;
};

type SettlementRecord = NonNullable<Awaited<ReturnType<typeof prisma.settlement.findUnique>>>;

const fastify = Fastify({
  logger: createLoggerOptions({ level: env.LOG_LEVEL }),
  // Explicitly set body limit to 1MB (Fastify's default)
  bodyLimit: 1_048_576,
});

registerRequestId(fastify);
setupPrismaQueryLogging(prisma, fastify.log);

const redis = new Redis(env.REDIS_URL);

fastify.addHook('onClose', async () => {
  await redis.quit();
});

fastify.register(cors, { 
  origin: env.ALLOWED_ORIGINS
});

fastify.register(helmet, { contentSecurityPolicy: false });

fastify.register(rateLimit, {
  global: true,
  max: 1000,
  timeWindow: 60 * 1000,
  errorResponseBuilder: (_request, context) => ({
    error: {
      code: 'RATE_LIMIT_EXCEEDED',
      message: `Too many requests — rate limit is ${context.max} requests per ${context.after}`,
    },
  }),
});

registerErrorHandler(fastify);
// Distributed tracing: log + propagate x-request-id / x-trace-id (#118).
registerTracing(fastify);

const redisConnection = new URL(env.REDIS_URL);
const connectionParams = {
  host: redisConnection.hostname,
  port: parseInt(redisConnection.port || '6379', 10),
  maxRetriesPerRequest: env.REDIS_MAX_RETRIES,
  enableReadyCheck: false,
  retryStrategy: (times: number) => {
    if (times > 10) return null;
    const delay = Math.min(times * 1000, 30000);
    fastify.log.warn({ attempt: times, delay }, 'Redis connection retry');
    return delay;
  },
};

// ── Settlement processing queue ────────────────────────────────────────────────

const settlementQueue = new Queue('settlements', {
  connection: connectionParams,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 2000 },
    removeOnComplete: { count: 1000 },
    removeOnFail: { count: 5000 },
  },
});
const settlementDLQ = new Queue('settlements-dlq', { connection: connectionParams });

// ── Webhook delivery queue & worker (shared @bettapay/webhook-delivery) ───────
//
// Webhook delivery is now decoupled from the settlement worker: after updating
// the settlement status the worker enqueues a WebhookJobData onto
// 'settlement-webhooks' and returns immediately.  The shared webhookWorker
// handles retries with BullMQ's built-in exponential back-off — no in-process
// sleep loop required.
//
// Migration note: the previous sendWebhookWithRetries had no persistence, so
// there are no in-flight webhook jobs to migrate.  The queue name
// 'settlement-webhooks' is fresh.
const webhookQueue = createWebhookQueue('settlement-webhooks', connectionParams);
const webhookWorker = createWebhookWorker('settlement-webhooks', connectionParams, {
  logger: {
    info: (obj, msg) => fastify.log.info(obj, msg),
    warn: (obj, msg) => fastify.log.warn(obj, msg),
    error: (obj, msg) => fastify.log.error(obj, msg),
  },
});

// ── Settlement processor ───────────────────────────────────────────────────────

const worker = new Worker('settlements', async job => {
  const settlementId = job.data.id;

  if (job.attemptsMade > 0) {
    fastify.log.warn({
      jobId: job.id,
      attempt: job.attemptsMade + 1,
      maxAttempts: 3,
      settlementId,
    }, 'Retrying settlement job');
  }

  fastify.log.info({
    jobId: job.id,
    merchantId: job.data.merchantId,
    amount: job.data.grossAmount,
    asset: job.data.asset,
    jobName: job.name,
  }, 'Processing settlement job');

  const settlement = await prisma.settlement.findUnique({ where: { id: settlementId } });
  if (!settlement) {
    throw new Error(`Settlement ${settlementId} not found`);
  }

  // If already in a terminal state, ensure the webhook is (re-)delivered.
  if (settlement.status === 'completed' || settlement.status === 'failed') {
    fastify.log.info({ settlementId, status: settlement.status }, 'Settlement already processed, enqueuing webhook');
    if (settlement.webhookUrl) {
      await webhookQueue.add('deliver', {
        url: settlement.webhookUrl,
        event: { event: `settlement.${settlement.status}`, data: settlement as unknown as Record<string, unknown> },
      });
    }
    return;
  }

  try {
    // In a real app this interacts with Soroban; here we mark completed.
    const updatedSettlement = await prisma.settlement.update({
      where: { id: settlementId },
      data: { status: 'completed', completedAt: new Date() },
    });

    fastify.log.info({ settlementId }, 'Settlement completed in database');

    if (updatedSettlement.webhookUrl) {
      await webhookQueue.add('deliver', {
        url: updatedSettlement.webhookUrl,
        event: { event: 'settlement.completed', data: updatedSettlement as unknown as Record<string, unknown> },
      });
    }
  } catch (error) {
    fastify.log.error({ error, settlementId }, 'Settlement processing failed');

    const updatedSettlement = await prisma.settlement.update({
      where: { id: settlementId },
      data: { status: 'failed', completedAt: new Date() },
    }).catch(() => null);

    if (updatedSettlement?.webhookUrl) {
      // Best-effort enqueue — don't let a queue error mask the original failure.
      await webhookQueue.add('deliver', {
        url: updatedSettlement.webhookUrl,
        event: { event: 'settlement.failed', data: updatedSettlement as unknown as Record<string, unknown> },
      }).catch((err: unknown) => {
        fastify.log.error({ err, settlementId }, 'Failed to enqueue failure webhook');
      });
    }

    throw error;
  }
}, {
  connection: connectionParams,
  concurrency: 5,
});

worker.on('failed', async (job, err) => {
  if (job) {
    fastify.log.error({
      jobId: job.id,
      settlementId: job.data.id,
      attempt: job.attemptsMade,
      error: err.message,
    }, 'Job failed after all retries, moving to DLQ');

    await settlementDLQ.add(job.name, job.data, {
      jobId: job.id,
      attempts: 1,
    });
  }
});

settlementQueue.on('error', (err) => {
  fastify.log.error({ err: err.message }, 'BullMQ queue connection error');
});
settlementDLQ.on('error', (err) => {
  fastify.log.error({ err: err.message }, 'BullMQ DLQ connection error');
});
worker.on('error', (err) => {
  fastify.log.error({ err: err.message }, 'BullMQ worker connection error');
});
webhookQueue.on('error', (err) => {
  fastify.log.error({ err: err.message }, 'BullMQ webhook queue connection error');
});
webhookWorker.on('error', (err) => {
  fastify.log.error({ err: err.message }, 'BullMQ webhook worker connection error');
});

fastify.get('/api/health', async (_request, reply) => {
  const health = await buildSettlementEngineHealthResponse({
    queryDatabase: () => prisma.$queryRaw`SELECT 1`,
    pingRedis: () => redis.ping(),
    getQueueJobCounts: () => settlementQueue.getJobCounts(),
    startTime,
    service: 'settlement-engine',
    version: SERVICE_VERSION,
  });
  const statusCode = health.status === 'unhealthy' ? 503 : 200;
  return reply.code(statusCode).send(health);
});

fastify.get('/api/settlements', async (request, reply): Promise<PaginatedResponse<SettlementRecord>> => {
  const { limit, offset, status, from, to } = SettlementListQuery.parse(request.query ?? {});
  const where: any = {};
  if (status) where.status = status;
  if (from || to) {
    where.initiatedAt = {};
    if (from) where.initiatedAt.gte = new Date(from);
    if (to) where.initiatedAt.lte = new Date(to);
  }
  const records = await prisma.settlement.findMany({
    where,
    take: limit,
    skip: offset,
    orderBy: { initiatedAt: 'desc' },
  });
  const total = await prisma.settlement.count({ where });
  const hasMore = offset + limit < total;
  return {
    data: records,
    pagination: { total, limit, offset, hasMore }
  };
});

interface ReconcileQuery {
  merchantId?: string;
  from?: string;
  to?: string;
}

// Signs a minimal HS256 JWT using Node's native crypto
function signHS256(payload: object, secret: string): string {
  const header = { alg: 'HS256', typ: 'JWT' };
  const base64UrlEncode = (obj: object) => 
    Buffer.from(JSON.stringify(obj))
      .toString('base64url');
  
  const tokenInput = `${base64UrlEncode(header)}.${base64UrlEncode(payload)}`;
  const signature = crypto
    .createHmac('sha256', secret)
    .update(tokenInput)
    .digest('base64url');
  
  return `${tokenInput}.${signature}`;
}

fastify.get<{ Querystring: ReconcileQuery }>('/api/settlements/reconcile', async (request, reply) => {
  try {
    const { merchantId, from, to } = request.query;

    const localWhere: any = {};
    if (merchantId) {
      localWhere.merchantId = merchantId;
    }
    if (from || to) {
      localWhere.initiatedAt = {};
      if (from) {
        localWhere.initiatedAt.gte = new Date(from);
      }
      if (to) {
        localWhere.initiatedAt.lte = new Date(to);
      }
    }

    // 1. Query local settlements
    const localRecords = await prisma.settlement.findMany({
      where: localWhere,
      orderBy: { initiatedAt: 'desc' },
    });

    // 2. Fetch api-gateway records via HTTP call
    const gatewayUrl = process.env.API_GATEWAY_URL || 'http://localhost:3000';
    const url = new URL(`${gatewayUrl}/api/settlements`);
    if (merchantId) url.searchParams.append('merchantId', merchantId);
    if (from) url.searchParams.append('from', from);
    if (to) url.searchParams.append('to', to);

    const jwtPayload = {
      sub: 'settlement-engine-reconciler',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 60, // 1 minute expiration
    };
    const token = signHS256(jwtPayload, env.JWT_SECRET);

    let gatewayRecords: any[] = [];
    try {
      const response = await fetch(url.toString(), {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        throw new Error(`API Gateway returned status ${response.status}`);
      }

      const data = await response.json() as { settlements: any[] };
      gatewayRecords = data.settlements;
    } catch (error) {
      fastify.log.error({ error }, 'Failed to fetch settlements from API Gateway');
      return reply.code(502).send({
        error: 'Failed to fetch settlement records from api-gateway',
        details: error instanceof Error ? error.message : String(error)
      });
    }

    // 3. Diff the two sets by settlement ID and compare records
    const localMap = new Map<string, SettlementRecord>();
    for (const r of localRecords) {
      localMap.set(r.id, r);
    }

    const gatewayMap = new Map<string, any>();
    for (const r of gatewayRecords) {
      gatewayMap.set(r.id, r);
    }

    const matchedIds = new Set<string>();
    const missing: any[] = []; // In gateway, but missing in local
    const extra: any[] = [];   // In local, but missing in gateway
    const mismatched: any[] = []; // In both, but fields differ

    let localGrossTotal = new BigNumber(0);
    let localFeeTotal = new BigNumber(0);
    let localNetTotal = new BigNumber(0);

    let gatewayGrossTotal = new BigNumber(0);
    let gatewayFeeTotal = new BigNumber(0);
    let gatewayNetTotal = new BigNumber(0);

    const parseBN = (val: any) => {
      const bn = new BigNumber(val ?? 0);
      return bn.isFinite() ? bn : new BigNumber(0);
    };

    // Process local records
    for (const localRec of localRecords) {
      localGrossTotal = localGrossTotal.plus(parseBN(localRec.grossAmount || localRec.totalAmount));
      localFeeTotal = localFeeTotal.plus(parseBN(localRec.feeAmount));
      localNetTotal = localNetTotal.plus(parseBN(localRec.netAmount));

      if (!gatewayMap.has(localRec.id)) {
        extra.push(localRec);
      }
    }

    // Process gateway records
    for (const gatewayRec of gatewayRecords) {
      gatewayGrossTotal = gatewayGrossTotal.plus(parseBN(gatewayRec.grossAmount || gatewayRec.totalAmount));
      gatewayFeeTotal = gatewayFeeTotal.plus(parseBN(gatewayRec.feeAmount));
      gatewayNetTotal = gatewayNetTotal.plus(parseBN(gatewayRec.netAmount));

      if (!localMap.has(gatewayRec.id)) {
        missing.push(gatewayRec);
      } else {
        matchedIds.add(gatewayRec.id);
      }
    }

    // Check mismatches
    for (const id of matchedIds) {
      const localRec = localMap.get(id)!;
      const gatewayRec = gatewayMap.get(id);

      const diffFields: string[] = [];
      const fieldsToCompare = ['merchantId', 'totalAmount', 'grossAmount', 'feeAmount', 'netAmount', 'feeBps', 'asset', 'status'];
      
      for (const field of fieldsToCompare) {
        const localVal = String((localRec as any)[field] ?? '');
        const gatewayVal = String(gatewayRec[field] ?? '');
        if (localVal !== gatewayVal) {
          diffFields.push(field);
        }
      }

      if (diffFields.length > 0) {
        mismatched.push({
          id,
          local: {
            merchantId: localRec.merchantId,
            totalAmount: localRec.totalAmount,
            grossAmount: localRec.grossAmount,
            feeAmount: localRec.feeAmount,
            netAmount: localRec.netAmount,
            feeBps: localRec.feeBps,
            asset: localRec.asset,
            status: localRec.status,
          },
          gateway: {
            merchantId: gatewayRec.merchantId,
            totalAmount: gatewayRec.totalAmount,
            grossAmount: gatewayRec.grossAmount,
            feeAmount: gatewayRec.feeAmount,
            netAmount: gatewayRec.netAmount,
            feeBps: gatewayRec.feeBps,
            asset: gatewayRec.asset,
            status: gatewayRec.status,
          },
          diff: diffFields,
        });
      }
    }

    const matchedCount = matchedIds.size - mismatched.length;

    return {
      matched: matchedCount,
      missing,
      extra,
      mismatches: mismatched,
      counts: {
        local: localRecords.length,
        gateway: gatewayRecords.length,
        matched: matchedCount,
        missing: missing.length,
        extra: extra.length,
        mismatched: mismatched.length,
      },
      totals: {
        local: {
          gross: localGrossTotal.toString(),
          fee: localFeeTotal.toString(),
          net: localNetTotal.toString(),
        },
        gateway: {
          gross: gatewayGrossTotal.toString(),
          fee: gatewayFeeTotal.toString(),
          net: gatewayNetTotal.toString(),
        },
      }
    };
  } catch (error) {
    fastify.log.error({ error }, 'Reconciliation error');
    return reply.code(400).send({ error: 'Failed to perform reconciliation' });
  }
});

fastify.post<{ Body: z.infer<typeof CreateSettlementBody> }>(
  '/api/settlements',
  {
    config: {
      rateLimit: {
        max: 60,
        timeWindow: 60 * 1000,
      },
    },
  },
  async (request, reply) => {
    const d = CreateSettlementBody.parse(request.body);

    if (!d.amount || !d.asset) {
      return reply.code(400).send(createErrorResponse(ErrorCodes.VALIDATION_ERROR, 'amount and asset are required'));
    }

    // Validate that the amount is positive without floating-point conversion
    const grossBN = new BigNumber(d.amount);
    if (!grossBN.isFinite() || grossBN.isLessThanOrEqualTo(0)) {
      return reply.code(400).send(createErrorResponse(ErrorCodes.VALIDATION_ERROR, 'amount must be > 0'));
    }

    const merchant = await prisma.merchant.findUnique({ where: { id: d.merchantId } });
    const parsedFeeRule = FeeRule.passthrough().safeParse(merchant?.settings);
    const feeBps = parsedFeeRule.success ? parsedFeeRule.data.feeBps : env.FEES_DEFAULT_BPS;
    const webhookUrl = parsedFeeRule.success ? (parsedFeeRule.data as Record<string, unknown>).webhookUrl as string ?? null : null;

    const { grossAmount, feeAmount, netAmount } = computeSettlementAmounts(d.amount, feeBps);

    const rawIdempotencyKey = request.headers['idempotency-key'];
    const idempotencyKey = Array.isArray(rawIdempotencyKey) ? rawIdempotencyKey[0] : rawIdempotencyKey;

    if (idempotencyKey) {
      const existingSettlementId = await redis.get(`idempotency:${idempotencyKey}`);
      if (existingSettlementId) {
        const existingSettlement = await prisma.settlement.findUnique({
          where: { id: existingSettlementId },
        });
        if (existingSettlement) {
          return reply.code(200).send(existingSettlement);
        }
      }
    }

    const settlement = await prisma.settlement.create({
      data: {
        id: 'set_' + crypto.randomUUID().replace(/-/g, ''),
        merchantId: d.merchantId,
        totalAmount: grossAmount,
        grossAmount,
        feeAmount,
        netAmount,
        feeBps,
        asset: d.asset,
        status: 'pending',
        webhookUrl,
      },
    });

    const jobData: SettlementJobData = {
      id: settlement.id,
      merchantId: settlement.merchantId,
      grossAmount: settlement.grossAmount,
      asset: settlement.asset,
    };

    await settlementQueue.add('process-settlement', jobData);

    if (idempotencyKey) {
      // 24-hour TTL (24 * 60 * 60 = 86400 seconds)
      await redis.set(`idempotency:${idempotencyKey}`, settlement.id, 'EX', 86400);
    }

    return reply.code(201).send(settlement);
});

// ============================================================================
// GRACEFUL SHUTDOWN
// ============================================================================
//
// Delegated to the shared helper in @bettapay/validation. It enforces the
// canonical close order (server → workers → queues → redis → prisma) and a
// 30s force-exit timeout, replacing the previous hand-rolled implementation.

registerGracefulShutdown({
  fastify,
  prisma,
  redis,
  bullmq: {
    worker: [worker, webhookWorker],
    queues: [settlementQueue, settlementDLQ, webhookQueue],
  },
});

// ============================================================================
// STARTUP
// ============================================================================

const start = async () => {
  try {
    await connectWithRetry(prisma, fastify.log);
    await fastify.listen({ port: PORT, host: '0.0.0.0' });
    fastify.log.info({ port: PORT }, 'Settlement Engine started successfully');
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();