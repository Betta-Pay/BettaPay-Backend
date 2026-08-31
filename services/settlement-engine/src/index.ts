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
import * as promClient from 'prom-client';
import * as crypto from 'crypto';
import { Queue, Worker, type Job } from 'bullmq';
import { PrismaClient } from '@prisma/client';
import pg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import BigNumber from 'bignumber.js';
import { createWebhookQueue, createWebhookWorker } from '@bettapay/webhook-delivery';
import { computeSettlementAmounts, SettlementAmountError } from './settlement-amounts.js';
import type { DiscountTier } from './settlement-amounts.js';
import { buildSettlementWebhookData } from './webhook-payload.js';
import {
  acquireSemaphore,
  releaseSemaphore,
  startSemaphoreRenewal,
  getActiveCount,
} from './redis-semaphore.js';
import { closeWorkerWithTimeout, trackActiveJob } from './worker-shutdown.js';
import {
  validateEnvOrExit,
  CreateSettlementBody,
  BulkSettlementBody,
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
  createRedisClient,
  waitForRedis,
  startRedisMemoryMonitor,
  startMetricsServer,
  runStartupChecks,
  startPrismaPoolMetricsCollector,
  WebhookHeadersSchema,
} from "@bettapay/validation";
import type { PaginatedResponse, ApiResponse } from '@bettapay/shared-types';
import { buildPaginationMeta } from '@bettapay/shared-types';



const env = validateEnvOrExit(process.env);
const PORT = Number(process.env.PORT ?? '3001');
const startTime = Date.now();
const SERVICE_VERSION = readServiceVersion(import.meta.url);

const pool = new pg.Pool({
  connectionString: buildPrismaConnectionUrl(env.DATABASE_URL, env.DATABASE_POOL_SIZE, env.DATABASE_POOL_TIMEOUT),
  max: env.DATABASE_POOL_SIZE,
  connectionTimeoutMillis: env.DATABASE_POOL_TIMEOUT * 1000,
});
const adapter = new PrismaPg(pool);
const prismaBase = new PrismaClient({ adapter, log: getPrismaLogLevels() });

export const SettlementStatusTransitions: Record<string, string[]> = {
  pending: ['processing', 'failed'],
  processing: ['completed', 'failed'],
  completed: [],
  failed: [],
};

export function validateTransition(current: string, next: string) {
  if (current === next) return;
  if (!SettlementStatusTransitions[current]?.includes(next)) {
    throw new Error(`Invalid status transition from ${current} to ${next}`);
  }
}

const prisma = prismaBase.$extends({
  query: {
    settlement: {
      async update({ args, query }) {
        if (args.data.status) {
          const current = await prismaBase.settlement.findUnique({
            where: args.where,
            select: { status: true },
          });
          if (current) {
            validateTransition(current.status, args.data.status as string);
          }
        }
        return query(args);
      },
      async updateMany({ args, query }) {
        if (args.data.status) {
          const records = await prismaBase.settlement.findMany({
            where: args.where,
            select: { id: true, status: true },
          });
          for (const record of records) {
            validateTransition(record.status, args.data.status as string);
          }
        }
        return query(args);
      },
    },
  },
}) as unknown as typeof prismaBase;

type SettlementJobData = {
  id: string;
  merchantId: string;
  grossAmount: string;
  asset: string;
  traceId?: string;
};

type SettlementRecord = NonNullable<Awaited<ReturnType<typeof prisma.settlement.findUnique>>>;

const fastify = Fastify({
  logger: createLoggerOptions({ level: env.LOG_LEVEL }),
  // Explicitly set body limit to 1MB (Fastify's default)
  bodyLimit: 1_048_576,
});

registerRequestId(fastify);
setupPrismaQueryLogging(prismaBase, fastify.log);
startPrismaPoolMetricsCollector(pool, promClient.register, 10000, fastify.log, promClient);

// Shared Redis client (use createRedisClient factory with connection sharing)
const redisHealthState: import('@bettapay/validation').RedisHealthState = {
  connected: false,
  errors: 0,
  reconnects: 0,
};

const redis = createRedisClient(env.REDIS_URL, fastify.log, {
  shared: true,
  healthState: redisHealthState,
});

fastify.addHook('onClose', async () => {
  await redis.quit().catch(() => {});
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

// ── Settlement processing queue ────────────────────────────────────────────────

const settlementQueue = new Queue('settlements', {
  connection: redis,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 2000 },
    removeOnComplete: { count: 1000 },
    removeOnFail: { count: 5000 },
  },
});
const settlementDLQ = new Queue('settlements-dlq', { connection: redis });

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
const webhookQueue = createWebhookQueue('settlement-webhooks', redis);
const webhookWorker = createWebhookWorker('settlement-webhooks', redis, {
  logger: {
    info: (obj, msg) => fastify.log.info(obj, msg),
    warn: (obj, msg) => fastify.log.warn(obj, msg),
    error: (obj, msg) => fastify.log.error(obj, msg),
  },
  redis,
});
const getActiveWebhookJob = trackActiveJob(webhookWorker);

// ── Metrics ─────────────────────────────────────────────────────────────────
const settlementDelayCounter = new promClient.Counter({
  name: 'settlement_semaphore_delay_total',
  help: 'Total number of settlements delayed due to per-merchant concurrency limit',
  labelNames: ['merchant_id'],
});

// Served on its own port (see startMetricsServer below), not on the
// application port — keeps the scrape endpoint unauthenticated without
// exposing it alongside application traffic.
const metricsServer = startMetricsServer({
  appPort: PORT,
  contentType: promClient.register.contentType,
  getMetrics: () => promClient.register.metrics(),
  log: fastify.log,
});

// ── Database & Redis Setup ───────────────────────────────────────────────────────

// ── Monthly volume helper (Redis-cached, 5-min TTL) ─────────────────────────
//
// Used by volume-based fee discounts (#323).  Queries the sum of grossAmount
// for the current calendar month for a given merchant, caching the result in
// Redis for MONTHLY_VOLUME_CACHE_TTL_SECONDS to avoid a DB round-trip on
// every settlement request.
//
// Cache key: `monthlyVol:{merchantId}:{YYYY-MM}`
// On Redis miss or error: falls back to a live DB query; on DB error: returns 0.
const MONTHLY_VOLUME_CACHE_TTL_SECONDS = 300; // 5 minutes

async function getMonthlyVolume(merchantId: string): Promise<number> {
  const now = new Date();
  const yearMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const cacheKey = `monthlyVol:${merchantId}:${yearMonth}`;

  try {
    const cached = await redis.get(cacheKey);
    if (cached !== null) {
      const parsed = parseFloat(cached);
      return isFinite(parsed) ? parsed : 0;
    }
  } catch {
    // Redis unavailable — fall through to DB query
  }

  try {
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const result = await prisma.$queryRaw<[{ sum: string | null }]>`
      SELECT COALESCE(SUM(CAST("grossAmount" AS DECIMAL)), 0)::text AS sum
      FROM "Settlement"
      WHERE "merchantId" = ${merchantId}
        AND "initiatedAt" >= ${monthStart}
        AND "status" IN ('completed', 'pending', 'processing')
    `;
    const volume = parseFloat(result[0]?.sum ?? '0');
    const safeVolume = isFinite(volume) ? volume : 0;

    // Populate cache (best-effort; ignore Redis errors)
    await redis.set(cacheKey, String(safeVolume), 'EX', MONTHLY_VOLUME_CACHE_TTL_SECONDS).catch(() => {});

    return safeVolume;
  } catch {
    return 0;
  }
}

// Custom webhook headers (idempotency keys, auth tokens, etc.) are configured
// per-merchant via PATCH /api/merchants/:id/settings (settings.webhookHeaders,
// see UpdateMerchantSettingsBody) and captured onto the Settlement row at
// creation time — the same lifecycle webhookUrl already follows (#569).
// Re-validate here (rather than trusting the DB blob) since settings is a
// loosely-typed JSON column that could have been written before validation
// existed or hand-edited.
function extractWebhookHeaders(settings: unknown): Record<string, string> | undefined {
  if (settings === null || typeof settings !== 'object') return undefined;
  const raw = (settings as Record<string, unknown>).webhookHeaders;
  const parsed = WebhookHeadersSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

// BullMQ has no per-job timeout option in WorkerOptions, so the configurable
// SETTLEMENT_JOB_TIMEOUT_MS is enforced with a watchdog that races the
// processor. Jobs that exceed the timeout are failed like any other error.
function withJobTimeout<T>(
  processor: (job: Job) => Promise<T>,
  job: Job,
  timeoutMs: number,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Settlement job timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
  return Promise.race([processor(job), timeoutPromise]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

const baseSettlementProcessor = async (job: Job): Promise<void> => {
  const settlementId = job.data.id;
  const merchantId = job.data.merchantId;
  const traceId = job.data.traceId;

  const log = traceId
    ? fastify.log.child({ traceId })
    : fastify.log;

  if (job.attemptsMade > 0) {
    log.warn({
      jobId: job.id,
      attempt: job.attemptsMade + 1,
      maxAttempts: 3,
      settlementId,
    }, 'Retrying settlement job');
  }

  // ── Per-merchant concurrency semaphore ──────────────────────────────────────
  const maxRetries = 3;
  const requeueDelayMs = 5000;
  // The member token this job holds; used to renew and to release exactly its
  // own slot (#487). null until acquired.
  let semaphoreToken: string | null = null;

  log.info({
    jobId: job.id,
    merchantId,
    amount: job.data.grossAmount,
    asset: job.data.asset,
    jobName: job.name,
  }, 'Processing settlement job');

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    semaphoreToken = await acquireSemaphore(redis, merchantId);
    if (semaphoreToken) break;

    if (attempt < maxRetries) {
      log.info({
        merchantId,
        settlementId,
        attempt: attempt + 1,
        maxRetries,
      }, 'Settlement delayed: merchant at concurrency limit, re-queuing');

      settlementDelayCounter.inc({ merchant_id: merchantId });

      await settlementQueue.add('process-settlement', job.data, {
        delay: requeueDelayMs,
        attempts: job.opts.attempts,
        backoff: job.opts.backoff,
      });
      return;
    }

    log.error({
      merchantId,
      settlementId,
    }, 'Settlement failed: merchant concurrency limit exceeded after max retries');
    throw new Error(`Merchant ${merchantId} at concurrency limit after ${maxRetries} retries`);
  }

  // Keep the slot reserved for as long as this job runs, even past the
  // semaphore TTL — otherwise a slow settlement's slot ages out and a 4th
  // concurrent job for the merchant slips through (#486).
  const renewal = semaphoreToken
    ? startSemaphoreRenewal(redis, merchantId, semaphoreToken, {
        onLost: () =>
          log.warn({ merchantId, settlementId }, 'Settlement semaphore slot lost mid-job'),
        onError: (err) =>
          log.warn({ err, merchantId, settlementId }, 'Settlement semaphore renewal failed'),
      })
    : undefined;

  try {
    // Transition to processing first
    await prisma.settlement.update({
      where: { id: settlementId },
      data: { status: 'processing' },
    });

    // In a real app this interacts with Soroban; here we mark completed.
    const updatedSettlement = await prisma.settlement.update({
      where: { id: settlementId },
      data: { status: 'completed', completedAt: new Date() },
    });

    log.info({ settlementId }, 'Settlement completed in database');

    if (updatedSettlement.webhookUrl) {
      await webhookQueue.add('deliver', {
        url: updatedSettlement.webhookUrl,
        eventId: crypto.randomUUID(),
        event: { event: 'settlement.completed', data: buildSettlementWebhookData(updatedSettlement) },
        headers: extractWebhookHeaders({ webhookHeaders: updatedSettlement.webhookHeaders }),
      });
    }
  } catch (error) {
    log.error({ error, settlementId }, 'Settlement processing failed');

    const updatedSettlement = await prisma.settlement.update({
      where: { id: settlementId },
      data: { status: 'failed', completedAt: new Date() },
    }).catch(() => null);

    if (updatedSettlement?.webhookUrl) {
      // Best-effort enqueue — don't let a queue error mask the original failure.
      await webhookQueue.add('deliver', {
        url: updatedSettlement.webhookUrl,
        eventId: crypto.randomUUID(),
        event: { event: 'settlement.failed', data: buildSettlementWebhookData(updatedSettlement) },
        headers: extractWebhookHeaders({ webhookHeaders: updatedSettlement.webhookHeaders }),
      }).catch((err: unknown) => {
        log.error({ err, settlementId }, 'Failed to enqueue failure webhook');
      });
    }

    throw error;
  } finally {
    renewal?.stop();
    if (semaphoreToken) {
      // Release exactly this job's slot; a double-release or a crashed
      // sibling's release can never drop it (#487).
      await releaseSemaphore(redis, merchantId, semaphoreToken).catch(() => {});
    }
  }
};

const worker = new Worker(
  'settlements',
  (job) => withJobTimeout(baseSettlementProcessor, job, env.SETTLEMENT_JOB_TIMEOUT_MS),
  {
    connection: redis,
    concurrency: 5,
  },
);

const getActiveSettlementJob = trackActiveJob(worker);

worker.on('failed', async (job, err) => {
  if (job) {
    const processedOn = job.processedOn ? job.processedOn : undefined;
    const durationMs = processedOn !== undefined ? Date.now() - processedOn : undefined;

    fastify.log.error({
      jobId: job.id,
      settlementId: job.data.id,
      merchantId: job.data.merchantId,
      durationMs,
      attempt: job.attemptsMade,
      error: err.message,
      jobName: job.name,
      queueName: 'settlements',
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
    redisHealthState,
    getQueueJobCounts: () => settlementQueue.getJobCounts(),
    getQueueIsPaused: () => settlementQueue.isPaused(),
    startTime,
    service: 'settlement-engine',
    version: SERVICE_VERSION,
  });
  const statusCode = health.status === 'unhealthy' ? 503 : 200;
  return reply.code(statusCode).send(health);
});

fastify.get('/api/settlements', async (request, reply): Promise<PaginatedResponse<SettlementRecord>> => {
  const { page, limit, status, from, to, includeDeleted } = SettlementListQuery.parse(request.query ?? {});
  const where: any = {};
  if (status) where.status = status;
  if (from || to) {
    where.initiatedAt = {};
    if (from) where.initiatedAt.gte = new Date(from);
    if (to) where.initiatedAt.lte = new Date(to);
  }
  // Exclude superseded settlements by default (#322)
  if (!includeDeleted) {
    where.supersededById = null;
  }
  const records = await prisma.settlement.findMany({
    where,
    take: limit,
    skip: (page - 1) * limit,
    orderBy: { initiatedAt: 'desc' },
  });
  const total = await prisma.settlement.count({ where });
  return {
    data: records,
    pagination: buildPaginationMeta(page, limit, total)
  };
});

// ============================================================================
// SETTLEMENT RETRY (#322)
// ============================================================================

fastify.post<{ Params: { id: string } }>(
  '/api/settlements/:id/retry',
  async (request, reply) => {
    const { id } = request.params;

    // Fetch the original settlement
    const original = await prisma.settlement.findUnique({
      where: { id },
    });

    if (!original) {
      return reply.code(404).send(createErrorResponse(ErrorCodes.NOT_FOUND, 'Settlement not found'));
    }

    // Only failed settlements can be retried
    if (original.status !== 'failed') {
      return reply.code(422).send(createErrorResponse(
        ErrorCodes.VALIDATION_ERROR,
        'Only failed settlements can be retried',
        { currentStatus: original.status }
      ));
    }

    // Count the retry chain to enforce max 3 retries
    const retryChain = await prisma.settlement.findMany({
      where: {
        OR: [
          { supersededById: id },
          { id: original.supersededById ?? '' },
        ],
      },
    });

    // Find the root of the chain
    let current = original;
    let chainLength = 0;
    const visited = new Set<string>();

    while (current.supersededById && !visited.has(current.id)) {
      visited.add(current.id);
      chainLength++;
      const parent = await prisma.settlement.findUnique({
        where: { id: current.supersededById },
      });
      if (!parent) break;
      current = parent;
    }

    // Count forward retries from original
    const forwardRetries = await prisma.settlement.count({
      where: { supersededById: id },
    });

    const totalRetries = chainLength + forwardRetries;

    if (totalRetries >= 3) {
      return reply.code(422).send(createErrorResponse(
        ErrorCodes.VALIDATION_ERROR,
        'Maximum retry limit (3) exceeded',
        { retryCount: totalRetries }
      ));
    }

    // Clone the settlement
    const newSettlementId = 'set_' + crypto.randomUUID().replace(/-/g, '');
    const traceId = crypto.randomUUID();

    const newSettlement = await prisma.settlement.create({
      data: {
        id: newSettlementId,
        merchantId: original.merchantId,
        totalAmount: original.totalAmount,
        grossAmount: original.grossAmount,
        feeAmount: original.feeAmount,
        netAmount: original.netAmount,
        feeBps: original.feeBps,
        asset: original.asset,
        status: 'pending',
        webhookUrl: original.webhookUrl,
        webhookHeaders: (original.webhookHeaders ?? undefined) as any,
        feeSnapshot: (original.feeSnapshot ?? undefined) as any,
      },
    });

    // Mark original as superseded. Guard against a self-reference (#626): a
    // settlement must never supersede itself (a 1-row loop that would break
    // chain unwinding). The DB has a CHECK constraint as a backstop
    // (Settlement_supersededById_no_self), but catch it here for a clean 409.
    if (id === newSettlementId) {
      return reply.code(409).send(createErrorResponse(
        ErrorCodes.CONFLICT,
        'Settlement cannot supersede itself',
      ));
    }
    await prisma.settlement.update({
      where: { id },
      data: { supersededById: newSettlementId },
    });

    // Queue the new settlement for processing
    await settlementQueue.add('process-settlement', {
      id: newSettlementId,
      merchantId: newSettlement.merchantId,
      grossAmount: newSettlement.grossAmount,
      asset: newSettlement.asset,
      traceId,
    });

    fastify.log.info({ originalId: id, newId: newSettlementId, retryCount: totalRetries + 1 }, 'Settlement retried');

    return reply.code(201).send({ data: newSettlement });
  }
);

interface ReconcileQuery {
  merchantId?: string;
  from?: string;
  to?: string;
}

/**
 * Local Consistency Check for Settlements
 *
 * This endpoint performs internal validation of settlement records to ensure
 * data integrity. It verifies:
 * - Mathematical consistency: grossAmount - feeAmount = netAmount
 * - Fee calculation accuracy: feeAmount matches feeBps applied to grossAmount
 * - Merchant reference validity: all settlements reference existing merchants
 *
 * This is a LOCAL consistency check - it does not make external HTTP calls.
 * All validation is performed against the settlement engine's own database.
 */
fastify.get<{ Querystring: ReconcileQuery }>('/api/settlements/reconcile', async (request, reply) => {
  try {
    const { merchantId, from, to } = request.query;

    const where: Record<string, unknown> = {};
    if (merchantId) {
      where.merchantId = merchantId;
    }
    if (from || to) {
      where.initiatedAt = {};
      if (from) {
        (where.initiatedAt as Record<string, Date>).gte = new Date(from);
      }
      if (to) {
        (where.initiatedAt as Record<string, Date>).lte = new Date(to);
      }
    }

    // Query settlements from local database
    const settlements = await prisma.settlement.findMany({
      where,
      orderBy: { initiatedAt: 'desc' },
    });

    // 2. Fetch api-gateway records via HTTP call
    const gatewayUrl = process.env.API_GATEWAY_URL || 'http://localhost:3000';
    const url = new URL(`${gatewayUrl}/api/settlements`);
    if (merchantId) url.searchParams.append('merchantId', merchantId);
    if (from) url.searchParams.append('from', from);
    if (to) url.searchParams.append('to', to);

    const token = env.INTER_SERVICE_SECRET;

    let gatewayRecords: any[] = [];
    try {
      const response = await fetch(url.toString(), {
        headers: {
          'x-service-token': token,
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        throw new Error(`API Gateway returned status ${response.status}`);
      }

      const data = await response.json() as { data: any[] };
      gatewayRecords = data.data;
    } catch (error) {
      fastify.log.error({ error }, 'Failed to fetch settlements from API Gateway');
      return reply.code(502).send({
        error: { code: 'UPSTREAM_ERROR', message: 'Failed to fetch settlement records from api-gateway', details: error instanceof Error ? error.message : String(error) }
      });
    }

    // 3. Diff the two sets by settlement ID and compare records
    const localMap = new Map<string, SettlementRecord>();
    for (const r of settlements) {
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

    const parseBN = (val: unknown): BigNumber => {
      const bn = new BigNumber(val as string ?? 0);
      return bn.isFinite() ? bn : new BigNumber(0);
    };

    const inconsistencies: Array<{
      settlementId: string;
      type: 'amount_mismatch' | 'fee_calculation' | 'missing_merchant';
      details: Record<string, unknown>;
    }> = [];

    let totalGross = new BigNumber(0);
    let totalFee = new BigNumber(0);
    let totalNet = new BigNumber(0);
    let validCount = 0;

    const statusCounts: Record<string, number> = {
      pending: 0,
      processing: 0,
      completed: 0,
      failed: 0,
    };

    const merchants = await prisma.merchant.findMany({ select: { id: true } });
    const existingMerchantIds = new Set(merchants.map(m => m.id));

    for (const settlement of settlements) {
      const gross = parseBN(settlement.grossAmount);
      const fee = parseBN(settlement.feeAmount);
      const net = parseBN(settlement.netAmount);

      totalGross = totalGross.plus(gross);
      totalFee = totalFee.plus(fee);
      totalNet = totalNet.plus(net);

      statusCounts[settlement.status] = (statusCounts[settlement.status] || 0) + 1;

      // Check 1: Verify grossAmount - feeAmount = netAmount
      const expectedNet = gross.minus(fee);
      if (!expectedNet.isEqualTo(net)) {
        inconsistencies.push({
          settlementId: settlement.id,
          type: 'amount_mismatch',
          details: {
            grossAmount: settlement.grossAmount,
            feeAmount: settlement.feeAmount,
            netAmount: settlement.netAmount,
            expectedNet: expectedNet.toString(),
          },
        });
        continue;
      }

      // Check 2: Verify fee calculation matches feeBps
      // feeAmount = floor(grossAmount × feeBps / 10000)
      const expectedFee = gross.times(settlement.feeBps).dividedBy(10000).integerValue(BigNumber.ROUND_DOWN);
      // Allow for minor precision differences (within 1 unit)
      if (expectedFee.minus(fee).abs().isGreaterThan(1)) {
        inconsistencies.push({
          settlementId: settlement.id,
          type: 'fee_calculation',
          details: {
            grossAmount: settlement.grossAmount,
            feeBps: settlement.feeBps,
            actualFee: settlement.feeAmount,
            expectedFee: expectedFee.toString(),
          },
        });
        continue;
      }

      // Check 3: Verify merchant exists
      if (!existingMerchantIds.has(settlement.merchantId)) {
        inconsistencies.push({
          settlementId: settlement.id,
          type: 'missing_merchant',
          details: {
            merchantId: settlement.merchantId,
          },
        });
        continue;
      }

      validCount++;
    }

    return {
      summary: {
        total: settlements.length,
        valid: validCount,
        inconsistent: inconsistencies.length,
      },
      statusBreakdown: statusCounts,
      totals: {
        gross: totalGross.toString(),
        fee: totalFee.toString(),
        net: totalNet.toString(),
      },
      inconsistencies,
      reconciliationType: 'local_consistency_check',
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

    // ── Pre-validation ──────────────────────────────────────────────────────
    if (!merchant) {
      return reply.code(404).send(createErrorResponse(ErrorCodes.NOT_FOUND, 'Merchant not found'));
    }
    if (merchant.deletedAt) {
      return reply.code(422).send(createErrorResponse(ErrorCodes.VALIDATION_ERROR, 'Merchant is deleted'));
    }
    if (merchant.kycStatus === 'rejected') {
      return reply.code(403).send(createErrorResponse(ErrorCodes.FORBIDDEN, 'Merchant is suspended'));
    }

    const parsedFeeRule = FeeRule.passthrough().safeParse(merchant.settings);
    if (!parsedFeeRule.success) {
      return reply.code(422).send(createErrorResponse(ErrorCodes.VALIDATION_ERROR, 'Merchant has no fee configuration'));
    }

    // Optional daily volume limit check
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const volumeResult = await prisma.$queryRaw<[{ sum: string | null }]>`
      SELECT COALESCE(SUM(CAST("totalAmount" AS DECIMAL)), 0)::text as sum
      FROM "Settlement"
      WHERE "merchantId" = ${d.merchantId}
      AND "initiatedAt" >= ${todayStart}
    `;
    const currentDailyTotal = volumeResult?.[0]?.sum ? parseFloat(volumeResult[0].sum) : 0;
    const requestAmount = parseFloat(d.amount);
    const dailyLimit = env.DAILY_SETTLEMENT_VOLUME_LIMIT;
    if (currentDailyTotal + requestAmount > dailyLimit) {
      return reply.code(429).send(createErrorResponse(
        ErrorCodes.RATE_LIMITED,
        'Daily settlement volume limit exceeded',
        { current: currentDailyTotal, requested: requestAmount, limit: dailyLimit },
      ));
    }

    let feeBps = parsedFeeRule.data.feeBps;
    const settings = parsedFeeRule.data as Record<string, unknown>;
    const maxFeeBps = settings.maxFeeBps as number | undefined;
    const maxFeeThreshold = settings.maxFeeThreshold as string | undefined;
    const webhookUrl = parsedFeeRule.success ? (parsedFeeRule.data as Record<string, unknown>).webhookUrl as string ?? null : null;
    const webhookHeaders = parsedFeeRule.success ? extractWebhookHeaders(parsedFeeRule.data) : undefined;

    // Fetch monthly volume for volume-based fee discount (#323).
    // Redis-cached with a 5-min TTL; falls back to DB query on cache miss.
    const monthlyVolume = await getMonthlyVolume(d.merchantId);
    const discountTiers: DiscountTier[] = env.FEE_DISCOUNT_TIERS ?? [];

    let computeResult;
    try {
      computeResult = computeSettlementAmounts(
        d.amount,
        feeBps,
        monthlyVolume,
        discountTiers,
      );
    } catch (error) {
      if (error instanceof SettlementAmountError) {
        return reply.code(422).send(createErrorResponse(ErrorCodes.VALIDATION_ERROR, error.message));
      }
      throw error;
    }
    const { grossAmount, feeAmount, netAmount, feeSnapshot } = computeResult;

    if (feeSnapshot.discountApplied > 0) {
      fastify.log.info({
        merchantId: d.merchantId,
        monthlyVolume,
        baseBps: feeBps,
        effectiveBps: feeSnapshot.feeBpsApplied,
        discountBps: feeSnapshot.discountApplied,
      }, '[Settlement] Volume-based fee discount applied');
    }

    const rawIdempotencyKey = request.headers['idempotency-key'];
    const idempotencyKey = Array.isArray(rawIdempotencyKey) ? rawIdempotencyKey[0] : rawIdempotencyKey;

    const settlementId = 'set_' + crypto.randomUUID().replace(/-/g, '');

    if (idempotencyKey) {
      let claimed: string | null = null;
      try {
        claimed = await redis.set(`idempotency:${idempotencyKey}`, settlementId, 'EX', 86400, 'NX');
      } catch {
        // Redis unavailable — fall through to DB @unique constraint
      }

      if (claimed === null) {
        // Another request atomically claimed this idempotency key first
        const existingId = await redis.get(`idempotency:${idempotencyKey}`).catch(() => null);
        if (existingId) {
          const existingSettlement = await prisma.settlement.findUnique({
            where: { id: existingId },
          });
          if (existingSettlement) {
            return reply.code(200).send({ data: existingSettlement });
          }
        }
      }
    }

    const settlement = await prisma.settlement.create({
      data: {
        id: settlementId,
        merchantId: d.merchantId,
        totalAmount: grossAmount,
        grossAmount,
        feeAmount,
        netAmount,
        feeBps,
        asset: d.asset,
        status: 'pending',
        webhookUrl,
        webhookHeaders: webhookHeaders as any,
        feeSnapshot: feeSnapshot as any,
        idempotencyKey: idempotencyKey ?? undefined,
        idempotencyKeyExpiresAt: idempotencyKey ? new Date(Date.now() + 86400_000) : undefined,
      },
    });

    const traceId = (request as unknown as { traceId?: string }).traceId;

    const jobData: SettlementJobData = {
      id: settlement.id,
      merchantId: settlement.merchantId,
      grossAmount: settlement.grossAmount,
      asset: settlement.asset,
      traceId,
    };

    await settlementQueue.add('process-settlement', jobData);

    return reply.code(201).send({ data: settlement });
});

fastify.post<{ Body: z.infer<typeof BulkSettlementBody> }>(
  '/api/settlements/bulk',
  {
    config: {
      rateLimit: {
        max: 30,
        timeWindow: 60 * 1000,
      },
    },
  },
  async (request, reply) => {
    const d = BulkSettlementBody.parse(request.body);

    const rawIdempotencyKey = request.headers['idempotency-key'];
    const idempotencyKey = Array.isArray(rawIdempotencyKey) ? rawIdempotencyKey[0] : rawIdempotencyKey;
    const payloadHash = idempotencyKey ? crypto.createHash('sha256').update(JSON.stringify(d)).digest('hex') : null;

    if (idempotencyKey && payloadHash) {
      try {
        const claimed = await redis.set(`idempotency:bulk:${idempotencyKey}`, payloadHash, 'EX', 86400, 'NX');
        if (claimed === null) {
          const existingHash = await redis.get(`idempotency:bulk:${idempotencyKey}`);
          if (existingHash && existingHash !== payloadHash) {
            return reply.code(409).send(createErrorResponse(ErrorCodes.VALIDATION_ERROR, 'Idempotency key already used with a different payload'));
          }

          const existingResponse = await redis.get(`idempotency:bulk_res:${idempotencyKey}`);
          if (existingResponse) {
            return reply.code(200).send(JSON.parse(existingResponse));
          }
          // If still processing, just fall through or return 409
          return reply.code(409).send(createErrorResponse(ErrorCodes.VALIDATION_ERROR, 'Bulk settlement for this idempotency key is currently processing'));
        }
      } catch (err) {
        request.log.error({ err }, 'Redis error during bulk idempotency check');
      }
    }

    if (d.settlements.length > 100) {
      return reply.code(400).send(createErrorResponse(ErrorCodes.VALIDATION_ERROR, 'Batch size exceeds maximum limit of 100 settlements'));
    }

    const merchant = await prisma.merchant.findUnique({ where: { id: d.merchantId } });
    if (!merchant) {
      return reply.code(404).send(createErrorResponse(ErrorCodes.NOT_FOUND, 'Merchant not found'));
    }
    if (merchant.deletedAt) {
      return reply.code(422).send(createErrorResponse(ErrorCodes.VALIDATION_ERROR, 'Merchant is deleted'));
    }
    if (merchant.kycStatus === 'rejected') {
      return reply.code(403).send(createErrorResponse(ErrorCodes.FORBIDDEN, 'Merchant is suspended'));
    }

    const settings = merchant.settings as {
      webhookUrl?: string;
      minSettlementAmount?: string;
      maxSettlementAmount?: string;
      dailySettlementLimit?: string;
      feeSchedules?: FeeScheduleItem[];
    } | null | undefined;

    const parsedFeeRule = FeeRule.passthrough().safeParse(merchant?.settings);
    const feeBps = parsedFeeRule.success ? parsedFeeRule.data.feeBps : env.FEES_DEFAULT_BPS;
    const settings_data = parsedFeeRule.success ? (parsedFeeRule.data as Record<string, unknown>) : {};
    const maxFeeBps = settings_data.maxFeeBps as number | undefined;
    const maxFeeThreshold = settings_data.maxFeeThreshold as string | undefined;
    const webhookUrl = settings_data.webhookUrl as string ?? null;
    const webhookHeaders = extractWebhookHeaders(settings_data);

    // Fetch monthly volume for volume-based fee discount (#323).
    const monthlyVolume = await getMonthlyVolume(d.merchantId);
    const discountTiers: DiscountTier[] = env.FEE_DISCOUNT_TIERS ?? [];

    // Fetch current daily total
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const aggregateResult = await prisma.$queryRaw<[{ sum: string | null }]>`
      SELECT COALESCE(SUM(CAST("totalAmount" AS DECIMAL)), 0)::text as sum
      FROM "Settlement"
      WHERE "merchantId" = ${d.merchantId}
      AND "initiatedAt" >= ${todayStart}
    `;

    const currentDailyTotal = aggregateResult?.[0]?.sum ? parseFloat(aggregateResult[0].sum) : 0;

    let runningBatchTotal = 0;
    const validItems: Array<{ amount: string; asset: string; id: string; grossAmount: string; feeAmount: string; netAmount: string; feeBps: number }> = [];
    const errors: Array<{ index: number; reason: string }> = [];

    for (let i = 0; i < d.settlements.length; i++) {
      const item = d.settlements[i];
      const amount = parseFloat(item.amount);

      if (isNaN(amount) || amount <= 0) {
        errors.push({ index: i, reason: 'amount must be greater than zero' });
        continue;
      }

      // Check min/max amount limits
      if (settings?.minSettlementAmount) {
        const minAmount = parseFloat(settings.minSettlementAmount);
        if (amount < minAmount) {
          errors.push({
            index: i,
            reason: `Settlement amount ${item.amount} is below minimum ${settings.minSettlementAmount}`
          });
          continue;
        }
      }

      if (settings?.maxSettlementAmount) {
        const maxAmount = parseFloat(settings.maxSettlementAmount);
        if (amount > maxAmount) {
          errors.push({
            index: i,
            reason: `Settlement amount ${item.amount} exceeds maximum ${settings.maxSettlementAmount}`
          });
          continue;
        }
      }

      // Check daily settlement limits
      if (settings?.dailySettlementLimit) {
        const dailyLimit = parseFloat(settings.dailySettlementLimit);
        if (currentDailyTotal + runningBatchTotal + amount > dailyLimit) {
          errors.push({
            index: i,
            reason: `Daily settlement limit exceeded. Current: ${currentDailyTotal + runningBatchTotal}, Requested: ${amount}, Limit: ${settings.dailySettlementLimit}`
          });
          continue;
        }
      }

      let itemResult;
      try {
        itemResult = computeSettlementAmounts(item.amount, feeBps, monthlyVolume, discountTiers);
      } catch (error) {
        if (error instanceof SettlementAmountError) {
          errors.push({ index: i, reason: error.message });
          continue;
        }
        throw error;
      }
      const { grossAmount, feeAmount, netAmount } = itemResult;
      const settlementId = 'set_' + crypto.randomUUID().replace(/-/g, '');

      validItems.push({
        id: settlementId,
        amount: item.amount,
        asset: item.asset,
        grossAmount,
        feeAmount,
        netAmount,
        feeBps: feeSnapshot.feeBpsApplied
      });
      runningBatchTotal += amount;
    }

    const batchId = 'batch_' + crypto.randomUUID().replace(/-/g, '');

    if (validItems.length > 0) {
      await prisma.$transaction(async (tx) => {
        for (const item of validItems) {
          await tx.settlement.create({
            data: {
              id: item.id,
              merchantId: d.merchantId,
              totalAmount: item.grossAmount,
              grossAmount: item.grossAmount,
              feeAmount: item.feeAmount,
              netAmount: item.netAmount,
              feeBps: item.feeBps,
              asset: item.asset,
              status: 'pending',
              webhookUrl,
              webhookHeaders: webhookHeaders as any,
              batchId,
            },
          });
        }
      });

      // Enqueue job for each successfully created settlement record
      for (const item of validItems) {
        const jobData: SettlementJobData = {
          id: item.id,
          merchantId: d.merchantId,
          grossAmount: item.grossAmount,
          asset: item.asset,
        };
        await settlementQueue.add('process-settlement', jobData).catch((err) => {
          request.log.error({ err, settlementId: item.id }, 'Failed to enqueue bulk settlement job');
        });
      }
    }

    const responsePayload = {
      data: {
        batchId,
        total: d.settlements.length,
        created: validItems.length,
        errors,
      },
    };

    if (idempotencyKey) {
      await redis.set(`idempotency:bulk_res:${idempotencyKey}`, JSON.stringify(responsePayload), 'EX', 86400).catch(err => {
        request.log.error({ err }, 'Redis error saving bulk idempotency response');
      });
    }

    return reply.code(201).send(responsePayload);
  }
);

fastify.get<{ Params: { batchId: string } }>(
  '/api/settlements/batch/:batchId/status',
  {
    config: {
      rateLimit: {
        max: 60,
        timeWindow: 60 * 1000,
      },
    },
  },
  async (request, reply) => {
    const { batchId } = request.params;

    if (!batchId || !batchId.startsWith('batch_')) {
      return reply.code(400).send(createErrorResponse(ErrorCodes.VALIDATION_ERROR, 'Invalid batchId format'));
    }

    const settlements = await prisma.settlement.findMany({
      where: { batchId },
    });

    if (settlements.length === 0) {
      return reply.code(404).send(createErrorResponse(ErrorCodes.NOT_FOUND, `Batch ${batchId} not found`));
    }

    const total = settlements.length;
    let pending = 0;
    let processing = 0;
    let completed = 0;
    let failed = 0;

    for (const s of settlements) {
      if (s.status === 'pending') pending++;
      else if (s.status === 'processing') processing++;
      else if (s.status === 'completed') completed++;
      else if (s.status === 'failed') failed++;
    }

    let overallStatus = 'processing';
    if (completed === total) overallStatus = 'completed';
    else if (failed === total) overallStatus = 'failed';
    else if (pending === total) overallStatus = 'pending';

    return {
      data: {
        batchId,
        total,
        pending,
        processing,
        completed,
        failed,
        status: overallStatus,
      },
    };
  }
);

// ============================================================================
// SETTLEMENT BATCHING JOB (#320)
// ============================================================================

// BullMQ repeatable job that runs every BATCH_INTERVAL_SECONDS to batch
// pending settlements by asset. Only creates batches for assets with
// >= BATCH_MIN_COUNT settlements.

const batchQueue = new Queue('settlement-batching', {
  connection: redis,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: 100,
    removeOnFail: 100,
  },
});

const batchWorker = new Worker(
  'settlement-batching',
  async (job) => {
    const traceId = job.data.traceId || crypto.randomUUID();
    fastify.log.info({ traceId }, 'Starting settlement batching job');

    try {
      // Fetch all pending settlements
      const pendingSettlements = await prisma.settlement.findMany({
        where: { status: 'pending' },
      });

      if (pendingSettlements.length === 0) {
        fastify.log.info({ traceId }, 'No pending settlements to batch');
        return { batched: 0 };
      }

      // Group by asset
      const grouped = pendingSettlements.reduce((acc, s) => {
        if (!acc[s.asset]) acc[s.asset] = [];
        acc[s.asset].push(s);
        return acc;
      }, {} as Record<string, typeof pendingSettlements>);

      let batchedCount = 0;

      // Create batches for assets with >= BATCH_MIN_COUNT
      for (const [asset, settlements] of Object.entries(grouped)) {
        if (settlements.length >= env.BATCH_MIN_COUNT) {
          const totalGross = settlements.reduce(
            (sum, s) => sum.plus(s.grossAmount),
            new BigNumber(0)
          ).toString();
          const totalFees = settlements.reduce(
            (sum, s) => sum.plus(s.feeAmount),
            new BigNumber(0)
          ).toString();
          const totalNet = settlements.reduce(
            (sum, s) => sum.plus(s.netAmount),
            new BigNumber(0)
          ).toString();

          const batch = await prisma.settlementBatch.create({
            data: {
              asset,
              totalCount: settlements.length,
              totalGross,
              totalFees,
              totalNet,
            },
          });

          // Update settlements to processing first
          await prisma.settlement.updateMany({
            where: { id: { in: settlements.map((s) => s.id) } },
            data: { status: 'processing' },
          });

          // Update settlements with batchId and mark completed
          await prisma.settlement.updateMany({
            where: { id: { in: settlements.map((s) => s.id) } },
            data: { batchId: batch.id, status: 'completed' },
          });

          fastify.log.info(
            { traceId, batchId: batch.id, asset, count: settlements.length },
            'Created settlement batch'
          );

          batchedCount += settlements.length;
        } else {
          fastify.log.info(
            { traceId, asset, count: settlements.length },
            'Skipping batch (below min count)'
          );
        }
      }

      fastify.log.info({ traceId, batchedCount }, 'Settlement batching job completed');
      return { batched: batchedCount };
    } catch (error) {
      fastify.log.error({ traceId, error }, 'Settlement batching job failed');
      throw error;
    }
  },
  { connection: redis, concurrency: 1 }
);

// Schedule the batching job to run every BATCH_INTERVAL_SECONDS
await batchQueue.add(
  'batch-pending-settlements',
  { traceId: crypto.randomUUID() },
  {
    repeat: {
      every: env.BATCH_INTERVAL_SECONDS * 1000,
    },
  }
);

batchWorker.on('completed', (job) => {
  fastify.log.info({ jobId: job.id }, 'Batching job completed');
});

batchWorker.on('failed', (job, err) => {
  fastify.log.error({ jobId: job?.id, error: err }, 'Batching job failed');
});



// ============================================================================
// GRACEFUL SHUTDOWN
// ============================================================================

let isShuttingDown = false;

async function gracefulShutdown(signal: string): Promise<void> {
  // Prevent multiple shutdown attempts
  if (isShuttingDown) {
    fastify.log.warn({ signal }, 'Shutdown already in progress, ignoring duplicate signal');
    return;
  }
  
  isShuttingDown = true;
  fastify.log.info({ signal }, 'Received shutdown signal, starting graceful shutdown');

  // Set a timeout to force exit if shutdown hangs
  const forceExitTimeout = setTimeout(() => {
    fastify.log.error('Graceful shutdown timed out after 30 seconds, forcing exit');
    process.exit(1);
  }, 30000);

  try {
    // 1. Close Fastify server (stops accepting new connections)
    fastify.log.info('Closing Fastify server...');
    await fastify.close();
    fastify.log.info('Fastify server closed');

    // 1b. Close the metrics server
    await new Promise<void>((resolve) => metricsServer.close(() => resolve()));

    // 2. Close BullMQ workers (drain and close gracefully, force-stop after 10s)
    fastify.log.info('Closing BullMQ workers...');
    await closeWorkerWithTimeout(worker, 'settlements', fastify.log, getActiveSettlementJob);
    await closeWorkerWithTimeout(batchWorker, 'batching', fastify.log, () => undefined);
    fastify.log.info('BullMQ workers closed');

    // 3. Close BullMQ queues
    fastify.log.info('Closing BullMQ queues...');
    await settlementQueue.close();
    await settlementDLQ.close();
    await batchQueue.close();
    await closeWorkerWithTimeout(webhookWorker, 'settlement-webhooks', fastify.log, getActiveWebhookJob);
    await webhookQueue.close();
    fastify.log.info('BullMQ queues closed');

    // 4. Close Redis connection
    fastify.log.info('Closing Redis connection...');
    await redis.quit();
    fastify.log.info('Redis connection closed');

    // 5. Disconnect Prisma
    fastify.log.info('Disconnecting Prisma...');
    await prisma.$disconnect();
    fastify.log.info('Prisma disconnected');

    // Clear the force exit timeout
    clearTimeout(forceExitTimeout);

    fastify.log.info({ signal }, 'Graceful shutdown completed successfully');
    process.exit(0);
  } catch (error) {
    fastify.log.error({ error, signal }, 'Error during graceful shutdown');
    clearTimeout(forceExitTimeout);
    process.exit(1);
  }
}

// Register shutdown handlers for SIGTERM and SIGINT
process.on('SIGTERM', () => {
  void gracefulShutdown('SIGTERM');
});

process.on('SIGINT', () => {
  void gracefulShutdown('SIGINT');
});

// ============================================================================
// STARTUP
// ============================================================================

const start = async () => {
  try {
    await runStartupChecks({
      service: 'settlement-engine',
      version: SERVICE_VERSION,
      logger: fastify.log,
      checks: [
        {
          name: 'prisma',
          fn: () => connectWithRetry(prisma, fastify.log),
          critical: true,
        },
        {
          name: 'redis',
          fn: () => waitForRedis(redis, fastify.log),
          critical: true,
        },
        {
          name: 'bullmq',
          fn: async () => {
            const counts = await settlementQueue.getJobCounts();
            fastify.log.info({ counts }, 'BullMQ queue reachable');
          },
          critical: false,
        },
      ],
    });

    // #387 — Redis memory monitoring
    startRedisMemoryMonitor(redis, fastify.log);

    await fastify.listen({ port: PORT, host: '0.0.0.0' });
    fastify.log.info({ port: PORT }, 'Settlement Engine started successfully');
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

export { fastify, prisma, redis, settlementQueue };

const isDirectRun = 
  !process.argv[1] || 
  process.argv[1].endsWith('index.ts') || 
  process.argv[1].endsWith('index.js') ||
  process.argv[1].endsWith('dist/index.js');

if (isDirectRun && process.env.NODE_ENV !== 'test') {
  start();
}