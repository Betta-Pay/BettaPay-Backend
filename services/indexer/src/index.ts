/**
 * Indexer Service — BettaPay Backend
 *
 * Listens to Soroban contract event streams and indexes payment/settlement events.
 * Supports monitoring multiple contracts via CONTRACT_IDS (comma-separated env var).
 *
 * Endpoints:
 *   GET  /api/events              — list indexed events (paginated, from DB)
 *   POST /api/events/replay       — re-index events for a historical ledger range
 *   POST /api/webhooks            — register a webhook URL subscription
 *   GET  /api/webhooks            — list all webhook subscriptions
 *   DELETE /api/webhooks/:id      — unsubscribe a webhook
 *   GET  /api/health              — dependency and upstream health probe
 */

import Fastify from 'fastify';
import cors from '@fastify/cors';
import crypto from 'crypto';
import { Redis } from 'ioredis';
import { createWebhookQueue, createWebhookWorker } from '@bettapay/webhook-delivery';
import { PrismaClient } from '@prisma/client';
import { rpc, scValToNative, xdr } from '@stellar/stellar-sdk';
import pg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { z } from 'zod';
import {
  validateEnv,
  registerErrorHandler,
  registerRequestId,
  registerServiceAuth,
  PaginationQuery,
  DateRangeQuery,
  EVENT_TYPES,
  WebhookUrlSchema,
  buildPrismaConnectionUrl,
  connectWithRetry,
  createLoggerOptions,
  getPrismaLogLevels,
  setupPrismaQueryLogging,
  registerTracing,
  genReqId,
  buildIndexerHealthResponse,
  readServiceVersion,
  createAuditLogger,
  registerGracefulShutdown,
} from '@bettapay/validation';
import type { EventType } from '@bettapay/validation';

export const env = validateEnv(process.env);
const PORT = Number(process.env.PORT ?? '3000');
const startTime = Date.now();
const SERVICE_VERSION = readServiceVersion(import.meta.url);

import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';

const fastifyInstance = Fastify({ logger: createLoggerOptions({ level: env.LOG_LEVEL }) });
export const fastify = fastifyInstance;
registerRequestId(fastify);
const pool = new pg.Pool({
  connectionString: buildPrismaConnectionUrl(env.DATABASE_URL, env.DATABASE_POOL_SIZE, env.DATABASE_POOL_TIMEOUT),
  max: env.DATABASE_POOL_SIZE,
  connectionTimeoutMillis: env.DATABASE_POOL_TIMEOUT * 1000,
});
const prismaAdapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter: prismaAdapter, log: getPrismaLogLevels() });
setupPrismaQueryLogging(prisma, fastify.log);
const logAuditEvent = createAuditLogger(prisma as unknown as Parameters<typeof createAuditLogger>[0], fastify.log);

fastify.register(cors, { origin: env.ALLOWED_ORIGINS });
fastify.register(helmet, { contentSecurityPolicy: false });
registerErrorHandler(fastify);
// Distributed tracing: log + propagate x-request-id / x-trace-id (#118).
registerTracing(fastify);
// Inter-service auth: internal endpoints require a valid x-service-token (#117).
registerServiceAuth(fastify, env.INTER_SERVICE_SECRET);

fastify.register(rateLimit, {
  max: 500,
  timeWindow: '1 minute'
});

let latestLedgerCursor: number | undefined = undefined;
let latestLedgerSequence: number | undefined = undefined;
const BASE_BACKOFF = 1000;
const MAX_BACKOFF = 30000;
let currentBackoff: number = BASE_BACKOFF;

// ── BullMQ webhook delivery queue ────────────────────────────────────────────

const redisConn = new URL(env.REDIS_URL);
const connectionParams = {
  host: redisConn.hostname,
  port: parseInt(redisConn.port || '6379', 10),
  maxRetriesPerRequest: 3,
};

// ── Webhook delivery queue & worker (shared @bettapay/webhook-delivery) ───────
//
// Queue name kept as 'indexer-webhooks' so any jobs already in Redis from the
// previous inline implementation are picked up without data loss (migration
// safety — see shared/webhook-delivery/index.ts for details).
const webhookQueue = createWebhookQueue('indexer-webhooks', connectionParams);
const webhookWorker = createWebhookWorker('indexer-webhooks', connectionParams, {
  logger: {
    info: (obj, msg) => fastify.log.info(obj, msg),
    warn: (obj, msg) => fastify.log.warn(obj, msg),
    error: (obj, msg) => fastify.log.error(obj, msg),
  },
});

const redisHealth = new Redis(env.REDIS_URL, { enableOfflineQueue: false });
redisHealth.on('error', (err) => fastify.log.warn({ err: err.message }, '[Indexer] Redis health client error'));
fastify.addHook('onClose', async () => {
  await redisHealth.quit().catch(() => {});
});

webhookWorker.on('error', (err) => {
  fastify.log.error({ err: err.message }, '[Indexer] Webhook worker error');
});
webhookQueue.on('error', (err) => {
  fastify.log.error({ err: err.message }, '[Indexer] Webhook queue error');
});

// ── Multi-contract config ────────────────────────────────────────────────────

// validateEnv resolves CONTRACT_IDS as a string[] (falls back to SETTLEMENT_CONTRACT_ID
// when the env var is unset).
const CONTRACT_IDS: string[] = env.CONTRACT_IDS;

fastify.log.info({ contracts: CONTRACT_IDS }, '[Indexer] Monitoring contract IDs');

const CONTRACT_NAMES: Record<string, string> = (() => {
  const raw = env.CONTRACT_NAMES ?? '';
  const map: Record<string, string> = {};
  raw.split(',').forEach((entry) => {
    const trimmed = entry.trim();
    if (!trimmed) return;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) return;
    const id = trimmed.slice(0, eqIdx).trim();
    const name = trimmed.slice(eqIdx + 1).trim();
    if (id && name) map[id] = name;
  });
  return map;
})();

function getContractName(contractId: string): string {
  return CONTRACT_NAMES[contractId] ?? 'unknown';
}

// ── Stellar RPC client ────────────────────────────────────────────────────────
const server = new rpc.Server(env.STELLAR_RPC_URL, { allowHttp: true });

// ── XDR decoding ─────────────────────────────────────────────────────────────

function serializeNative(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Buffer || Buffer.isBuffer(value)) return (value as Buffer).toString('hex');
  if (Array.isArray(value)) return value.map(serializeNative);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, serializeNative(v)])
    );
  }
  return value;
}

function decodeScVal(evtValue: xdr.ScVal, topicHint: string): unknown {
  try {
    const native = scValToNative(evtValue);
    return serializeNative(native);
  } catch (err) {
    fastify.log.warn({ topicHint, err: String(err) }, '[Indexer] Failed to decode XDR — raw value preserved');
    return null;
  }
}

// ── Event persistence ─────────────────────────────────────────────────────────

async function persistEvent(
  stellarId: string | null,
  topics: string[],
  type: string,
  contractId: string,
  contractName: string,
  rawValue: string,
  decodedPayload: unknown,
  ledger: number
): Promise<Record<string, unknown>> {
  const id = 'evt_' + crypto.randomUUID().replace(/-/g, '');

  const record = await prisma.indexedEvent.create({
    data: {
      id,
      stellarId,
      contractId,
      contractName,
      topics,
      type,
      rawValue,
      decodedPayload: decodedPayload !== null ? (decodedPayload as any) : undefined,
      ledger,
      indexedAt: new Date(),
    },
  });

  fastify.log.info({ id, type, contractName, ledger }, '[Indexer] Event indexed');

  const subs = await prisma.webhookSubscription.findMany();
  for (const sub of subs) {
    await webhookQueue.add('deliver', { url: sub.url, event: record as Record<string, unknown> });
  }

  return record as Record<string, unknown>;
}

// ── HTTP API ──────────────────────────────────────────────────────────────────

fastify.get('/api/health', async (_request, reply) => {
  const health = await buildIndexerHealthResponse({
    queryDatabase: () => prisma.$queryRaw`SELECT 1`,
    pingRedis: () => redisHealth.ping(),
    getQueueJobCounts: () => webhookQueue.getJobCounts(),
    getLatestLedger: () => server.getLatestLedger(),
    latestLedgerCursor,
    latestLedgerSequence,
    lagWarnThreshold: env.INDEXER_LAG_WARN_THRESHOLD,
    startTime,
    service: 'indexer',
    version: SERVICE_VERSION,
  });
  const statusCode = health.status === 'unhealthy' ? 503 : 200;
  return reply.code(statusCode).send(health);
});

// Issue #67 — paginated events endpoint with { total, limit, offset, hasMore }
// Internal endpoint — requires a valid x-service-token (#117).
fastify.get('/api/events', { preValidation: [fastify.serviceAuth] }, async (request) => {
  const { limit, offset } = PaginationQuery.parse(request.query ?? {});
  const typeParam = (request.query as Record<string, unknown>)?.type as string | undefined;

  const where: Record<string, unknown> = {};
  if (typeParam) {
    const requestedTypes = typeParam.split(',').map((t) => t.trim());
    const validTypes = requestedTypes.filter((t): t is EventType =>
      (EVENT_TYPES as readonly string[]).includes(t)
    );
    if (validTypes.length > 0) where.type = { in: validTypes };
  }

  const [dbEvents, total] = await Promise.all([
    prisma.indexedEvent.findMany({
      where,
      take: limit,
      skip: offset,
      orderBy: { indexedAt: 'desc' },
    }),
    prisma.indexedEvent.count({ where }),
  ]);

  const hasMore = offset + limit < total;
  return { events: dbEvents, total, limit, offset, hasMore, latestLedgerCursor };
});

// Issue #68 — replay historical events for a ledger range (all contracts)
// Issue #76 — extended to iterate over all configured contract IDs
const ReplayBody = z.object({
  fromLedger: z.number().int().min(1),
  toLedger: z.number().int().min(1),
}).refine((d) => d.fromLedger <= d.toLedger, {
  message: 'fromLedger must be <= toLedger',
});

fastify.post(
  '/api/events/replay',
  {
    config: {
      rateLimit: {
        max: 60,
        timeWindow: '1 minute'
      }
    }
  },
  async (request, reply) => {
  const { fromLedger, toLedger } = ReplayBody.parse(request.body);

  fastify.register(rateLimit, {
    max: 60,
    timeWindow: '1 minute'
  });

  let newEvents = 0;
  let skippedDuplicates = 0;

  for (const contractId of CONTRACT_IDS) {
    let cursor = fromLedger;

    while (cursor <= toLedger) {
      const response = await server.getEvents({
        startLedger: cursor,
        filters: [{ type: 'contract' as const, contractIds: [contractId], topics: [] }],
        limit: 100,
      });

      if (!response.events || response.events.length === 0) break;

      for (const evt of response.events) {
        if (evt.ledger > toLedger) break;
        cursor = Math.max(cursor, evt.ledger + 1);

        const topics = Array.isArray(evt.topic) ? evt.topic.map(String) : [String(evt.topic)];
        const rawValue = evt.value.toXDR('base64');
        const decodedPayload = decodeScVal(evt.value, topics[0]);
        const resolvedContractId = evt.contractId ? evt.contractId.toString() : contractId;
        const contractName = getContractName(resolvedContractId);
        const stellarId = typeof evt.id === 'string' ? evt.id : null;

        // Skip duplicates using Stellar's own event ID (most reliable key)
        if (stellarId) {
          const existing = await prisma.indexedEvent.findUnique({ where: { stellarId } });
          if (existing) {
            skippedDuplicates++;
            continue;
          }
        } else {
          // Fall back to ledger + contractId + rawValue fingerprint
          const existing = await prisma.indexedEvent.findFirst({
            where: { ledger: evt.ledger, contractId: resolvedContractId, rawValue },
          });
          if (existing) {
            skippedDuplicates++;
            continue;
          }
        }

        await prisma.indexedEvent.create({
          data: {
            id: 'evt_' + crypto.randomUUID().replace(/-/g, ''),
            stellarId,
            contractId: resolvedContractId,
            contractName,
            topics,
            type: topics[0],
            rawValue,
            decodedPayload: decodedPayload !== null ? (decodedPayload as any) : undefined,
            ledger: evt.ledger,
            indexedAt: new Date(),
          },
        });
        newEvents++;
      }

      const lastEvt = response.events[response.events.length - 1];
      if (lastEvt.ledger >= toLedger || response.events.length < 100) break;
    }
  }
});

// Issue #70 — webhook subscription CRUD
const WebhookBody = z.object({
  url: WebhookUrlSchema,
});

fastify.post('/api/webhooks', async (request, reply) => {
  const { url } = WebhookBody.parse(request.body);
  const sub = await prisma.$transaction(async (tx) => {
    const created = await tx.webhookSubscription.create({
      data: { id: 'wh_' + crypto.randomUUID().replace(/-/g, ''), url },
    });
    await logAuditEvent('webhook.registered', 'webhook', created.id, { before: null, after: created }, request, tx as unknown as Parameters<typeof logAuditEvent>[5]);
    return created;
  });
  return reply.code(201).send(sub);
});

fastify.get('/api/webhooks', async () => {
  return prisma.webhookSubscription.findMany({ orderBy: { createdAt: 'desc' } });
});

fastify.delete<{ Params: { id: string } }>('/api/webhooks/:id', async (request, reply) => {
  const { id } = request.params;
  const existing = await prisma.webhookSubscription.findUnique({ where: { id } });
  if (!existing) {
    return reply.code(404).send({
      error: { code: 'NOT_FOUND', message: `Webhook subscription ${id} not found` },
    });
  }
  await prisma.$transaction(async (tx) => {
    await tx.webhookSubscription.delete({ where: { id } });
    await logAuditEvent('webhook.deleted', 'webhook', id, { before: existing, after: null }, request, tx as unknown as Parameters<typeof logAuditEvent>[5]);
  });
  return reply.code(204).send();
});

// ── Stellar RPC polling loop ──────────────────────────────────────────────────

async function pollEvents() {
  // On each poll, fetch the latest Stellar ledger to track lag
  try {
    const latest = await server.getLatestLedger();
    latestLedgerSequence = latest.sequence;
  } catch {
    // Cannot reach the network; keep the previous sequence for lag computation
  }

  try {
    let cursor = latestLedgerCursor;
    if (cursor === undefined) {
      cursor = latestLedgerSequence;
    }

    if (cursor === undefined) {
      currentBackoff = BASE_BACKOFF;
      setTimeout(pollEvents, currentBackoff);
      return;
    }

    const response = await server.getEvents({
      startLedger: latestLedgerCursor ?? 0,
      filters: CONTRACT_IDS.map((contractId) => ({
        type: 'contract' as const,
        contractIds: [contractId],
        topics: [],
      })),
      limit: 100,
    });

    if (response.events && response.events.length > 0) {
      for (const evt of response.events) {
        const topics = Array.isArray(evt.topic) ? evt.topic.map(String) : [String(evt.topic)];
        const rawValue = evt.value.toXDR('base64');
        const decodedPayload = decodeScVal(evt.value, topics[0]);
        const resolvedContractId = evt.contractId ? evt.contractId.toString() : CONTRACT_IDS[0];
        const contractName = getContractName(resolvedContractId);
        const stellarId = typeof evt.id === 'string' ? evt.id : null;

        await persistEvent(stellarId, topics, topics[0], resolvedContractId, contractName, rawValue, decodedPayload, evt.ledger);
        if (latestLedgerCursor !== undefined) {
          latestLedgerCursor = Math.max(latestLedgerCursor, evt.ledger + 1);
        }
      }
    } else if (latestLedgerSequence !== undefined && latestLedgerCursor !== undefined) {
      latestLedgerCursor = Math.max(latestLedgerCursor, latestLedgerSequence);
    }

    latestLedgerCursor = cursor;

    // Warn if the indexer is too far behind the network tip
    if (latestLedgerSequence !== undefined) {
      const lag = latestLedgerSequence - cursor;
      if (lag > env.INDEXER_LAG_WARN_THRESHOLD) {
        fastify.log.warn({ lag, threshold: env.INDEXER_LAG_WARN_THRESHOLD }, '[Indexer] Indexer lag exceeds threshold');
      }
    }

    currentBackoff = BASE_BACKOFF;
    setTimeout(pollEvents, currentBackoff);
  } catch (err) {
    fastify.log.error(`[Indexer] Polling error: ${err}`);
    const jitter = currentBackoff * (0.75 + Math.random() * 0.5);
    fastify.log.info(`[Indexer] Retrying in ${Math.round(jitter)}ms (backoff: ${currentBackoff}ms)`);
    currentBackoff = Math.min(currentBackoff * 2, MAX_BACKOFF);
    setTimeout(pollEvents, jitter);
  }
}

/**
 * Builds the Prisma `where` clause for the DB cleanup query.
 * Extracted as a pure function so it can be unit-tested without a DB connection.
 *
 * @internal exported for testing only
 */
export function buildCleanupWhere(retentionDays: number, now: Date): { indexedAt: { lt: Date } } | null {
  if (retentionDays <= 0) return null;
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
  return { indexedAt: { lt: cutoff } };
}

/**
 * Deletes IndexedEvent rows from the database that are older than
 * `EVENT_RETENTION_DAYS`. Returns the number of rows deleted.
 *
 * When `EVENT_RETENTION_DAYS` is 0 (the default), cleanup is disabled and the
 * function returns 0 immediately.
 */
export async function cleanupOldEvents(): Promise<number> {
  const retentionDays = env.EVENT_RETENTION_DAYS;
  const where = buildCleanupWhere(retentionDays, new Date());
  if (!where) return 0;

  const { count } = await prisma.indexedEvent.deleteMany({ where });
  return count;
}

export async function runCleanupJob(): Promise<void> {
  try {
    const deletedCount = await cleanupOldEvents();
    fastify.log.info({
      retentionDays: env.EVENT_RETENTION_DAYS,
      deletedCount,
      status: 'success'
    }, `[Indexer] Event retention cleanup completed. Retention period: ${env.EVENT_RETENTION_DAYS} days. Deleted: ${deletedCount} events. Status: success`);
  } catch (error: any) {
    fastify.log.error({
      retentionDays: env.EVENT_RETENTION_DAYS,
      error: error?.message || error,
      status: 'failed'
    }, `[Indexer] Event retention cleanup failed. Retention period: ${env.EVENT_RETENTION_DAYS} days. Error: ${error}. Status: failed`);
  }
}

let cleanupInterval: NodeJS.Timeout | undefined = undefined;

export function startCleanupScheduler(): void {
  if (env.EVENT_RETENTION_DAYS > 0) {
    // Run once during startup, then every 24 hours.
    // Fire-and-forget: errors are caught and logged inside runCleanupJob().
    void runCleanupJob();
    cleanupInterval = setInterval(() => void runCleanupJob(), 24 * 60 * 60 * 1000);
  }
}

export function stopCleanupScheduler(): void {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = undefined;
  }
}
// ── Startup ───────────────────────────────────────────────────────────────────

const start = async () => {
  try {
    await connectWithRetry(prisma, fastify.log);
    await fastify.listen({ port: PORT, host: '0.0.0.0' });
    fastify.log.info('[Indexer] Starting Stellar RPC polling loop...');
    pollEvents();
    startCleanupScheduler();
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

// Graceful shutdown — delegated to the shared helper in @bettapay/validation.
// It closes resources in the canonical order (server → worker → queue → prisma)
// and now also wires up SIGINT, which the previous inline handler omitted.
// The Redis health client is released via the server's onClose hook.
registerGracefulShutdown({
  fastify,
  prisma,
  bullmq: {
    worker: webhookWorker,
    queues: [webhookQueue],
  },
});

if (process.env.NODE_ENV !== 'test') {
  start();
}
