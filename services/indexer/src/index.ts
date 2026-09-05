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

import Fastify from "fastify";
import cors from "@fastify/cors";
import crypto from "crypto";
import { Queue, Worker, QueueEvents } from "bullmq";
import {
  createWebhookQueue,
  createWebhookWorker,
  WEBHOOK_DEFAULTS,
} from "@bettapay/webhook-delivery";
import { closeWorkerWithTimeout, trackActiveJob } from "./worker-shutdown.js";
import { PrismaClient, WebhookSubscription } from "@prisma/client";
import { rpc, scValToNative, xdr } from "@stellar/stellar-sdk";
import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { z } from "zod";
import {
  encryptField,
  decryptField,
  validateEnvOrExit,
  registerErrorHandler,
  registerRequestId,
  registerServiceAuth,
  PaginationQuery,
  EventListQuery,
  DateRangeQuery,
  EVENT_TYPES,
  WebhookUrlSchema,
  WebhookHeadersSchema,
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
  createRedisClient,
  waitForRedis,
  startRedisMemoryMonitor,
  startMetricsServer,
  startPrismaPoolMetricsCollector,
  CleanupQuery,
  paymentInitiatedEvent,
  paymentCompletedEvent,
  settlementTriggeredEvent,
  fxExecutedEvent,
  billPaidEvent,
  anchorSettledEvent,
  isFeatureEnabled,
  logFeatureFlags,
} from "@bettapay/validation";
import { buildPaginationMeta } from "@bettapay/shared-types";
import type { EventType, CleanupDryRunResult } from "@bettapay/validation";
import * as promClient from "prom-client";

export const env = validateEnvOrExit(process.env);
const PORT = Number(process.env.PORT ?? "3000");
const startTime = Date.now();
const SERVICE_VERSION = readServiceVersion(import.meta.url);

import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";

const fastifyInstance = Fastify({
  logger: createLoggerOptions({ level: env.LOG_LEVEL }),
});
export const fastify = fastifyInstance;
registerRequestId(fastify);
const pool = new pg.Pool({
  connectionString: buildPrismaConnectionUrl(
    env.DATABASE_URL,
    env.DATABASE_POOL_SIZE,
    env.DATABASE_POOL_TIMEOUT,
  ),
  max: env.DATABASE_POOL_SIZE,
  connectionTimeoutMillis: env.DATABASE_POOL_TIMEOUT * 1000,
});
const prismaAdapter = new PrismaPg(pool);
export const prisma = new PrismaClient({
  adapter: prismaAdapter,
  log: getPrismaLogLevels(),
});
startPrismaPoolMetricsCollector(
  pool,
  promClient.register,
  10000,
  fastify.log,
  promClient,
);
setupPrismaQueryLogging(prisma, fastify.log);
const logAuditEvent = createAuditLogger(
  prisma as unknown as Parameters<typeof createAuditLogger>[0],
  fastify.log,
);

fastify.register(cors, { origin: env.ALLOWED_ORIGINS });
fastify.register(helmet, { contentSecurityPolicy: false });
fastify.register(rateLimit, {
  max: 500,
  timeWindow: "1 minute",
  addHeaders: {
    "x-ratelimit-limit": true,
    "x-ratelimit-remaining": true,
    "x-ratelimit-reset": true,
    "retry-after": true,
  },
});
registerErrorHandler(fastify);
// Distributed tracing: log + propagate x-request-id / x-trace-id (#118).
registerTracing(fastify);
// Inter-service auth: internal endpoints require a valid x-service-token (#117).
registerServiceAuth(fastify, env.INTER_SERVICE_SECRET);

fastify.register(rateLimit, {
  max: 500,
  timeWindow: "1 minute",
});

// Served on its own port (see startMetricsServer below), not on the
// application port — keeps the scrape endpoint unauthenticated without
// exposing it alongside application traffic.
promClient.collectDefaultMetrics();

const pollDurationHistogram = new promClient.Histogram({
  name: "indexer_poll_duration_seconds",
  help: "Duration of poll cycles",
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30],
});

const eventsFetchedCounter = new promClient.Counter({
  name: "indexer_events_fetched_total",
  help: "Total events fetched per contract",
  labelNames: ["contractId"] as const,
});

const pollCyclesCounter = new promClient.Counter({
  name: "indexer_poll_cycles_total",
  help: "Total poll cycles by status",
  labelNames: ["status"] as const,
});

const metricsServer = startMetricsServer({
  appPort: PORT,
  contentType: promClient.register.contentType,
  getMetrics: () => promClient.register.metrics(),
  log: fastify.log,
});

let latestLedgerCursor: number | undefined = undefined;
let latestLedgerSequence: number | undefined = undefined;
const BASE_BACKOFF = 1000;
const MAX_BACKOFF = env.MAX_BACKOFF_INTERVAL_MS;
let currentBackoff: number = BASE_BACKOFF;

// Per-ledger timeout retry state (#565)
let consecutiveSkips = 0;
const MAX_CONSECUTIVE_SKIPS = 5;

// ── Shared Redis client ──────────────────────────────────────────────────────
const redisHealthState: import("@bettapay/validation").RedisHealthState = {
  connected: false,
  errors: 0,
  reconnects: 0,
};

const sharedRedis = createRedisClient(env.REDIS_URL, fastify.log, {
  shared: true,
  healthState: redisHealthState,
});
fastify.addHook("onClose", async () => {
  await sharedRedis.quit().catch(() => {});
});

const indexerPollBackoffGauge = new promClient.Gauge({
  name: "indexer_poll_backoff_ms",
  help: "Current indexer polling backoff interval in milliseconds",
});
indexerPollBackoffGauge.set(currentBackoff);

// Issue #345 — Indexer lag metrics
const indexerLagGauge = new promClient.Gauge({
  name: "indexer_lag_ledgers",
  help: "Number of ledgers the indexer is behind the network tip",
  labelNames: ["contractId"] as const,
});

const indexerLastIndexedLedgerGauge = new promClient.Gauge({
  name: "indexer_last_indexed_ledger",
  help: "Last ledger sequence number indexed by the indexer",
});

const indexerNetworkTipLedgerGauge = new promClient.Gauge({
  name: "indexer_network_tip_ledger",
  help: "Current network tip ledger sequence number",
});

// Per-ledger timeout metrics (#565)
const indexerLedgerTimeoutsCounter = new promClient.Counter({
  name: "indexer_ledger_timeouts_total",
  help: "Total number of per-ledger timeouts (stuck ledgers skipped)",
});

const indexerLedgerSkipsCounter = new promClient.Counter({
  name: "indexer_ledger_skips_total",
  help: "Total number of ledger retries/skips due to stuck ledgers",
});

function parseRetryAfterMs(err: unknown): number | null {
  const status = (err as any)?.response?.status ?? (err as any)?.status;
  if (status !== 429) return null;

  const retryHeader =
    (err as any)?.response?.headers?.["retry-after"] ??
    (err as any)?.response?.headers?.get?.("retry-after");
  if (!retryHeader) return null;

  const retrySeconds = parseInt(String(retryHeader), 10);
  if (!Number.isFinite(retrySeconds) || retrySeconds <= 0) return null;
  return retrySeconds * 1000;
}

export function getCurrentBackoffMs(): number {
  return currentBackoff;
}

export function calculateBackoffAfterSuccess(): number {
  currentBackoff = Math.max(BASE_BACKOFF, Math.floor(currentBackoff / 2));
  indexerPollBackoffGauge.set(currentBackoff);
  return currentBackoff;
}

export function calculateBackoffAfter429(err: unknown): number {
  const retryAfterMs = parseRetryAfterMs(err);
  if (retryAfterMs !== null) {
    currentBackoff = Math.min(retryAfterMs, MAX_BACKOFF);
  } else {
    currentBackoff = Math.min(currentBackoff * 2, MAX_BACKOFF);
  }
  indexerPollBackoffGauge.set(currentBackoff);
  return currentBackoff;
}

export function calculateBackoffAfterError(err: unknown): number {
  if ((err as any)?.response?.status === 429 || (err as any)?.status === 429) {
    return calculateBackoffAfter429(err);
  }
  currentBackoff = Math.min(currentBackoff * 2, MAX_BACKOFF);
  indexerPollBackoffGauge.set(currentBackoff);
  return currentBackoff;
}

// ── Webhook delivery queue & worker (shared @bettapay/webhook-delivery) ───────
// (Resolved previous merge conflict markers here)
//
// Queue name kept as 'indexer-webhooks' so any jobs already in Redis from the
// previous inline implementation are picked up without data loss (migration
// safety — see shared/webhook-delivery/index.ts for details).
export const webhookQueue = createWebhookQueue("indexer-webhooks", sharedRedis);
// Ensure only one webhook worker is created to prevent duplicate deliveries
const webhookWorker = createWebhookWorker("indexer-webhooks", sharedRedis, {
  logger: {
    info: (obj, msg) => fastify.log.info(obj, msg),
    warn: (obj, msg) => fastify.log.warn(obj, msg),
    error: (obj, msg) => fastify.log.error(obj, msg),
  },
});
const getActiveWebhookJob = trackActiveJob(webhookWorker);

// ── Dead-letter queue (DLQ) for webhooks that exhaust all retries (#354) ─────
// The queue relies on the unconditionally initialized canonical sharedRedis client
const DLQ_QUEUE_NAME = "indexer-webhooks-dlq";
const dlqQueue = new Queue(DLQ_QUEUE_NAME, {
  connection: sharedRedis,
  defaultJobOptions: {
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 1000 },
  },
});

webhookWorker.on("failed", async (job, err) => {
  if (
    !job ||
    job.attemptsMade < (job.opts.attempts ?? WEBHOOK_DEFAULTS.attempts)
  )
    return;
  // All retries exhausted — move to DLQ
  try {
    await dlqQueue.add("failed-delivery", {
      ...job.data,
      failedAt: new Date().toISOString(),
      error: err?.message ?? String(err),
      attempts: job.attemptsMade,
      originalJobId: job.id,
    } as any);
    fastify.log.warn(
      { jobId: job.id, url: job.data.url },
      "[Indexer] Webhook moved to dead-letter queue after all retries",
    );
  } catch (dlqErr) {
    fastify.log.error(
      { err: dlqErr },
      "[Indexer] Failed to enqueue job to DLQ",
    );
  }
});

// #386 — exponential backoff retry strategy
const redisHealth = createRedisClient(env.REDIS_URL, fastify.log);
redisHealth.on("error", (err) =>
  fastify.log.warn({ err: err.message }, "[Indexer] Redis health client error"),
);
fastify.addHook("onClose", async () => {
  await redisHealth.quit().catch(() => {});
});

webhookWorker.on("error", (err) => {
  fastify.log.error({ err: err.message }, "[Indexer] Webhook worker error");
});
webhookQueue.on("error", (err) => {
  fastify.log.error({ err: err.message }, "[Indexer] Webhook queue error");
});

// ── Replay queue & worker ─────────────────────────────────────────────────────

const replayQueue = new Queue("indexer-replays", {
  connection: sharedRedis,
  defaultJobOptions: {
    attempts: 2,
    backoff: { type: "exponential", delay: 2000 },
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 50 },
  },
});

// #386 — exponential backoff retry strategy
const replayProgressRedis = createRedisClient(env.REDIS_URL, fastify.log);
replayProgressRedis.on("error", (err) =>
  fastify.log.warn(
    { err: err.message },
    "[Indexer] Replay progress Redis error",
  ),
);

const PROGRESS_KEY_PREFIX = "replay:progress:";

async function updateReplayProgress(
  jobId: string,
  data: {
    totalLedgers: number;
    processedLedgers: number;
    status: "running" | "completed" | "failed";
    error?: string;
  },
): Promise<void> {
  try {
    await sharedRedis.set(
      `${PROGRESS_KEY_PREFIX}${jobId}`,
      JSON.stringify(data),
      "EX",
      86400,
    );
  } catch {
    // Non-fatal: progress is best-effort
  }
}

const replayWorker = new Worker(
  "indexer-replays",
  async (job) => {
    type ReplayJobData = {
      fromLedger: number;
      toLedger: number;
      contractId?: string;
      force?: boolean;
    };
    const { fromLedger, toLedger, contractId, force } =
      job.data as ReplayJobData;
    const totalLedgers = toLedger - fromLedger + 1;

    await updateReplayProgress(job.id!, {
      totalLedgers,
      processedLedgers: 0,
      status: "running",
    });

    let processedCount = 0;

    try {
      // If contractId is specified, only replay that contract; otherwise replay all
      const contractsToReplay = contractId ? [contractId] : CONTRACT_IDS;

      for (const targetContractId of contractsToReplay) {
        let cursor = fromLedger;

        // If force=true, delete existing events in the range for this contract
        if (force) {
          await prisma.indexedEvent.deleteMany({
            where: {
              contractId: targetContractId,
              ledger: {
                gte: fromLedger,
                lte: toLedger,
              },
            },
          });
          fastify.log.info(
            { contractId: targetContractId, fromLedger, toLedger },
            "[Indexer] Deleted existing events for forced replay",
          );
        }

        const processedLedgerSet = new Set<number>();
        let currentLedger = -1;

        while (cursor <= toLedger) {
          const response = await server.getEvents({
            startLedger: cursor,
            filters: [
              {
                type: "contract" as const,
                contractIds: [targetContractId],
                topics: [],
              },
            ],
            limit: REPLAY_CHUNK_SIZE,
          });

          if (!response.events || response.events.length === 0) break;

          const stellarIds = response.events
            .map((evt) => (typeof evt.id === "string" ? evt.id : null))
            .filter((id): id is string => id !== null);

          // When force=false, check for existing events to skip
          const existingStellarIds = force
            ? new Set<string>()
            : new Set<string>(
                stellarIds.length > 0
                  ? (
                      await prisma.indexedEvent.findMany({
                        where: { stellarId: { in: stellarIds } },
                        select: { stellarId: true },
                      })
                    )
                      .map((e) => e.stellarId)
                      .filter((id): id is string => id !== null)
                  : [],
              );

          for (const evt of response.events) {
            if (evt.ledger > toLedger) continue;

            if (currentLedger !== -1 && currentLedger !== evt.ledger) {
              processedLedgerSet.add(currentLedger);
            }
            currentLedger = evt.ledger;

            if (processedLedgerSet.has(evt.ledger)) {
              fastify.log.warn(
                { ledger: evt.ledger },
                "[Indexer] Skipping out-of-order or duplicate ledger",
              );
              continue;
            }

            cursor = Math.max(cursor, evt.ledger + 1);

            const topics = Array.isArray(evt.topic)
              ? evt.topic.map(String)
              : [String(evt.topic)];
            const rawValue = evt.value.toXDR("base64");
            const decodedPayload = decodeScVal(evt.value, topics[0]);
            const resolvedContractId = evt.contractId
              ? evt.contractId.toString()
              : targetContractId;
            const contractName = getContractName(resolvedContractId);
            const stellarId = typeof evt.id === "string" ? evt.id : null;
            const validationError = validatePayload(topics[0], decodedPayload);

            // Skip if already indexed (when force=false)
            if (!force) {
              if (stellarId) {
                if (existingStellarIds.has(stellarId)) continue;
              } else {
                const existing = await prisma.indexedEvent.findFirst({
                  where: {
                    ledger: evt.ledger,
                    contractId: resolvedContractId,
                    rawValue,
                  },
                });
                if (existing) continue;
              }
            }

            try {
              await prisma.indexedEvent.create({
                data: {
                  id: "evt_" + crypto.randomUUID().replace(/-/g, ""),
                  stellarId,
                  contractId: resolvedContractId,
                  contractName,
                  topics,
                  type: topics[0],
                  rawValue,
                  decodedPayload:
                    decodedPayload !== null
                      ? (decodedPayload as any)
                      : undefined,
                  validationError: validationError ?? undefined,
                  ledger: evt.ledger,
                  indexedAt: new Date(),
                },
              });
            } catch (err: any) {
              if (err?.code === "P2002") {
                fastify.log.debug(
                  {
                    stellarId,
                    contractId: resolvedContractId,
                    ledger: evt.ledger,
                  },
                  "[Indexer] Replay duplicate event — skipping (composite constraint)",
                );
                continue;
              }
              throw err;
            }

            processedCount = Math.max(
              processedCount,
              evt.ledger - fromLedger + 1,
            );
            await updateReplayProgress(job.id!, {
              totalLedgers,
              processedLedgers: processedCount,
              status: "running",
            });
          }

          const lastEvt = response.events[response.events.length - 1];
          if (
            lastEvt.ledger >= toLedger ||
            response.events.length < REPLAY_CHUNK_SIZE
          )
            break;
        }
      }

      await updateReplayProgress(job.id!, {
        totalLedgers,
        processedLedgers: processedCount,
        status: "completed",
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      fastify.log.error(
        { err: errMsg, jobId: job.id },
        "[Indexer] Replay job failed",
      );
      await updateReplayProgress(job.id!, {
        totalLedgers,
        processedLedgers: processedCount,
        status: "failed",
        error: errMsg,
      });
      throw err;
    }
  },
  {
    connection: sharedRedis,
    concurrency: 1,
  },
);
const getActiveReplayJob = trackActiveJob(replayWorker);

replayWorker.on("error", (err) => {
  fastify.log.error({ err: err.message }, "[Indexer] Replay worker error");
});
replayQueue.on("error", (err) => {
  fastify.log.error({ err: err.message }, "[Indexer] Replay queue error");
});

// ── Multi-contract config ────────────────────────────────────────────────────

// validateEnv resolves CONTRACT_IDS as a string[] (falls back to SETTLEMENT_CONTRACT_ID
// when the env var is unset).
const CONTRACT_IDS: string[] = env.CONTRACT_IDS;

fastify.log.info(
  { contracts: CONTRACT_IDS },
  "[Indexer] Monitoring contract IDs",
);

const CONTRACT_NAMES: Record<string, string> = (() => {
  const raw = env.CONTRACT_NAMES ?? "";
  const map: Record<string, string> = {};
  raw.split(",").forEach((entry) => {
    const trimmed = entry.trim();
    if (!trimmed) return;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) return;
    const id = trimmed.slice(0, eqIdx).trim();
    const name = trimmed.slice(eqIdx + 1).trim();
    if (id && name) map[id] = name;
  });
  return map;
})();

const MAX_REPLAY_LEDGER_RANGE = 1000;
const REPLAY_CHUNK_SIZE = 100;

function getContractName(contractId: string): string {
  return CONTRACT_NAMES[contractId] ?? "unknown";
}

// ── Stellar RPC client ────────────────────────────────────────────────────────
const server = new rpc.Server(env.STELLAR_RPC_URL, { allowHttp: true });

// ── XDR decoding ─────────────────────────────────────────────────────────────

function serializeNative(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Buffer || Buffer.isBuffer(value))
    return (value as Buffer).toString("hex");
  if (Array.isArray(value)) return value.map(serializeNative);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        serializeNative(v),
      ]),
    );
  }
  return value;
}

function decodeScVal(evtValue: xdr.ScVal, topicHint: string): unknown {
  try {
    const native = scValToNative(evtValue);
    return serializeNative(native);
  } catch (err) {
    fastify.log.warn(
      { topicHint, err: String(err) },
      "[Indexer] Failed to decode XDR — raw value preserved",
    );
    return null;
  }
}

// ── Event payload validation ──────────────────────────────────────────────────

const EVENT_SCHEMA_MAP: Record<string, z.ZodTypeAny> = {
  PaymentInitiated: paymentInitiatedEvent,
  PaymentCompleted: paymentCompletedEvent,
  SettlementTriggered: settlementTriggeredEvent,
  FXExecuted: fxExecutedEvent,
  BillPaid: billPaidEvent,
  AnchorSettled: anchorSettledEvent,
};

function validatePayload(type: string, payload: unknown): string | null {
  const schema = EVENT_SCHEMA_MAP[type];
  if (!schema) return null;
  const result = schema.safeParse(payload);
  if (!result.success) {
    const msg = result.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    fastify.log.warn(
      { type, validationError: msg },
      "[Indexer] Event payload validation failed",
    );
    return msg;
  }
  return null;
}

// ── Event persistence ─────────────────────────────────────────────────────────

export const cacheState: {
  subscriptions: { data: WebhookSubscription[]; cachedAt: number } | null;
} = { subscriptions: null };

export async function dispatchPendingWebhookDeliveries(): Promise<void> {
  const store = (prisma as any).indexedEventWebhookDelivery;
  let pending: any[];
  try {
    pending = await store.findMany({
      where: { status: "pending" },
      orderBy: { createdAt: "asc" },
      take: 100,
    });
  } catch (err) {
    fastify.log.warn(
      { err: String(err) },
      "[Indexer] Unable to load pending webhook deliveries",
    );
    return;
  }
  for (const delivery of pending) {
    try {
      // Decrypt signingSecret on read (#617)
      const decryptedSecret = delivery.signingSecret
        ? decryptField(delivery.signingSecret)
        : undefined;
      await webhookQueue.add(
        "deliver",
        {
          url: delivery.url,
          event: delivery.event,
          version: "1.0",
          signingSecret: decryptedSecret,
          headers: delivery.headers ?? undefined,
        },
        { jobId: `indexed-event-delivery-${delivery.id}` },
      );
      await store.update({
        where: { id: delivery.id },
        data: { status: "processed", processedAt: new Date() },
      });
    } catch (err) {
      fastify.log.warn(
        { deliveryId: delivery.id, err: String(err) },
        "[Indexer] Webhook enqueue failed; delivery remains pending",
      );
    }
  }
}

export async function persistEvent(
  stellarId: string | null,
  topics: string[],
  type: string,
  contractId: string,
  contractName: string,
  rawValue: string,
  decodedPayload: unknown,
  ledger: number,
  validationError?: string | null,
): Promise<Record<string, unknown> | null> {
  const id = "evt_" + crypto.randomUUID().replace(/-/g, "");

  let record: Record<string, unknown>;
  try {
    record = (await prisma.indexedEvent.create({
      data: {
        id,
        stellarId,
        contractId,
        contractName,
        topics,
        type,
        rawValue,
        decodedPayload:
          decodedPayload !== null ? (decodedPayload as any) : undefined,
        validationError: validationError ?? undefined,
        ledger,
        indexedAt: new Date(),
      },
    })) as Record<string, unknown>;
  } catch (err: any) {
    if (err?.code === "P2002") {
      fastify.log.debug(
        { stellarId, contractId, ledger, type },
        "[Indexer] Duplicate event — skipping (composite constraint)",
      );
      return null;
    }
    throw err;
  }

  fastify.log.info(
    { id, type, contractName, ledger },
    "[Indexer] Event indexed",
  );

  const now = Date.now();
  if (
    cacheState.subscriptions &&
    now - cacheState.subscriptions.cachedAt < 30000
  ) {
    fastify.log.debug("[Indexer] Webhook subscriptions cache hit");
    // #511 — renew TTL on read for hot entries so frequently-used subscription
    // lists never expire under load. Gated behind a feature flag so the old
    // fixed-30 s behaviour can be restored without a code change.
    if (isFeatureEnabled('webhook_cache_ttl_refresh')) {
      cacheState.subscriptions.cachedAt = now;
    }
  } else {
    fastify.log.debug(
      "[Indexer] Webhook subscriptions cache miss, fetching from DB",
    );
    const freshSubs = await prisma.webhookSubscription.findMany();
    cacheState.subscriptions = { data: freshSubs, cachedAt: now };
  }

  const subs = cacheState.subscriptions.data;
  if (subs.length)
    await (prisma as any).indexedEventWebhookDelivery.createMany({
      data: subs.map((sub) => ({
        id: `whd_${crypto.randomUUID().replace(/-/g, "")}`,
        indexedEventId: id,
        subscriptionId: sub.id,
        url: sub.url,
        event: record,
        // Encrypt signingSecret on write (#617)
        signingSecret: sub.signingSecret
          ? encryptField(sub.signingSecret)
          : undefined,
        headers: (sub.headers as Record<string, string> | null) ?? undefined,
      })),
      skipDuplicates: true,
    });
  await dispatchPendingWebhookDeliveries();

  return record as Record<string, unknown>;
}

// ── HTTP API ──────────────────────────────────────────────────────────────────

fastify.get("/api/health", async (_request, reply) => {
  const health = await buildIndexerHealthResponse({
    queryDatabase: () => prisma.$queryRaw`SELECT 1`,
    pingRedis: () => sharedRedis.ping(),
    redisHealthState,
    getQueueJobCounts: () => webhookQueue.getJobCounts(),
    getQueueIsPaused: () => webhookQueue.isPaused(),
    getLatestLedger: () => server.getLatestLedger(),
    latestLedgerCursor,
    latestLedgerSequence,
    lagWarnThreshold: env.INDEXER_LAG_WARN_THRESHOLD,
    startTime,
    service: "indexer",
    version: SERVICE_VERSION,
  });
  const statusCode = health.status === "unhealthy" ? 503 : 200;
  return reply.code(statusCode).send(health);
});

// Issue #67 — paginated events endpoint using the shared PaginatedResponse envelope
// Internal endpoint — requires a valid x-service-token (#117).
fastify.get(
  "/api/events",
  { preValidation: [fastify.serviceAuth] },
  async (request) => {
    const { limit, page, type, topic, contractId, fromLedger, toLedger } =
      EventListQuery.parse(request.query ?? {});

    const where: Record<string, unknown> = {};
    if (type) where.type = type;
    if (topic) where.topics = { has: topic };
    if (contractId) where.contractId = contractId;
    if (fromLedger !== undefined || toLedger !== undefined) {
      const ledgerFilter: Record<string, number> = {};
      if (fromLedger !== undefined) ledgerFilter.gte = fromLedger;
      if (toLedger !== undefined) ledgerFilter.lte = toLedger;
      where.ledger = ledgerFilter;
    }

    const [dbEvents, total] = await Promise.all([
      prisma.indexedEvent.findMany({
        where,
        take: limit,
        skip: (page - 1) * limit,
        orderBy: { indexedAt: "desc" },
      }),
      prisma.indexedEvent.count({ where }),
    ]);

    return {
      data: dbEvents,
      pagination: buildPaginationMeta(page, limit, total),
      latestLedgerCursor,
    };
  },
);

// Issue #68 — replay historical events for a ledger range (all contracts)
// Issue #76 — extended to iterate over all configured contract IDs
const ReplayBody = z
  .object({
    fromLedger: z.number().int().min(1),
    toLedger: z.number().int().min(1),
  })
  .refine((d) => d.fromLedger <= d.toLedger, {
    message: "fromLedger must be <= toLedger",
  });

// Issue #343 — per-contract replay body
const PerContractReplayBody = z
  .object({
    startLedger: z.number().int().min(1),
    endLedger: z.number().int().min(1),
    force: z.boolean().optional().default(false),
  })
  .refine((d) => d.startLedger <= d.endLedger, {
    message: "startLedger must be <= endLedger",
  });

fastify.post(
  "/api/events/replay",
  {
    config: {
      rateLimit: {
        max: 60,
        timeWindow: "1 minute",
      },
    },
  },
  async (request, reply) => {
    const { fromLedger, toLedger } = ReplayBody.parse(request.body);

    const range = toLedger - fromLedger;
    if (range > MAX_REPLAY_LEDGER_RANGE) {
      return reply.code(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message: `Ledger range exceeds maximum of ${MAX_REPLAY_LEDGER_RANGE} (requested ${range})`,
          details: { fromLedger, toLedger, maxRange: MAX_REPLAY_LEDGER_RANGE },
        },
      });
    }

    const job = await replayQueue.add("replay", { fromLedger, toLedger });

    return reply.code(202).send({
      jobId: job.id,
      status: "queued",
      fromLedger,
      toLedger,
      range,
    });
  },
);

// Issue #343 — per-contract replay endpoint
fastify.post<{ Params: { contractId: string }; Body: unknown }>(
  "/api/events/replay/contract/:contractId",
  {
    config: {
      rateLimit: {
        max: 60,
        timeWindow: "1 minute",
      },
    },
  },
  async (request, reply) => {
    const { contractId } = request.params;

    // Validate that the contract ID is in the monitored list
    if (!CONTRACT_IDS.includes(contractId)) {
      return reply.code(422).send({
        error: {
          code: "VALIDATION_ERROR",
          message: `Contract ID ${contractId} is not monitored by this indexer`,
          details: { contractId, monitoredContracts: CONTRACT_IDS },
        },
      });
    }

    const { startLedger, endLedger, force } = PerContractReplayBody.parse(
      request.body,
    );

    const range = endLedger - startLedger;
    if (range > MAX_REPLAY_LEDGER_RANGE) {
      return reply.code(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message: `Ledger range exceeds maximum of ${MAX_REPLAY_LEDGER_RANGE} (requested ${range})`,
          details: {
            startLedger,
            endLedger,
            maxRange: MAX_REPLAY_LEDGER_RANGE,
          },
        },
      });
    }

    const job = await replayQueue.add("replay-contract", {
      contractId,
      fromLedger: startLedger,
      toLedger: endLedger,
      force,
    });

    return reply.code(202).send({
      jobId: job.id,
      status: "queued",
      contractId,
      startLedger,
      endLedger,
      force,
      range,
    });
  },
);

// Issue #229 — replay job progress status
fastify.get<{ Params: { jobId: string } }>(
  "/api/events/replay/:jobId/status",
  async (request, reply) => {
    const { jobId } = request.params;
    try {
      const raw = await replayProgressRedis.get(
        `${PROGRESS_KEY_PREFIX}${jobId}`,
      );
      if (!raw) {
        return reply.code(404).send({
          error: {
            code: "NOT_FOUND",
            message: `Replay job ${jobId} not found`,
          },
        });
      }
      const progress = JSON.parse(raw);
      return { jobId, ...progress };
    } catch (err) {
      fastify.log.warn(
        { err, jobId },
        "[Indexer] Failed to read replay progress",
      );
      return reply.code(500).send({
        error: {
          code: "INTERNAL_ERROR",
          message: "Failed to read replay progress",
        },
      });
    }
  },
);

// Issue #346 — cleanup trigger with optional dry-run
fastify.post(
  "/api/events/cleanup",
  {
    preValidation: [fastify.serviceAuth],
  },
  async (request, reply) => {
    const { dryRun } = CleanupQuery.parse(request.query ?? {});
    if (dryRun) {
      const dryResult = await cleanupOldEvents(true);
      return reply.code(200).send(dryResult);
    }
    const deletedCount = await cleanupOldEvents();
    return reply.code(200).send({ status: "completed", deletedCount });
  },
);

// Issue #70 — webhook subscription CRUD
// #569 — headers is optional: merchant-configured custom headers (idempotency
// keys, auth tokens, etc.) sent with every delivery attempt, including retries.
const WebhookBody = z.object({
  url: WebhookUrlSchema,
  headers: WebhookHeadersSchema.optional(),
});

fastify.post(
  "/api/webhooks",
  { preValidation: [fastify.serviceAuth] },
  async (request, reply) => {
    const { url, headers } = WebhookBody.parse(request.body);
    const sub = await prisma.$transaction(async (tx) => {
      const created = await tx.webhookSubscription.create({
        data: {
          id: "wh_" + crypto.randomUUID().replace(/-/g, ""),
          url,
          headers: headers ?? undefined,
        },
      });
      await logAuditEvent(
        "webhook.registered",
        "webhook",
        created.id,
        { before: null, after: created },
        request,
        tx as unknown as Parameters<typeof logAuditEvent>[5],
      );
      return created;
    });
    cacheState.subscriptions = null; // Invalidate cache
    return reply.code(201).send(sub);
  },
);

fastify.get(
  "/api/webhooks",
  { preValidation: [fastify.serviceAuth] },
  async () => {
    return prisma.webhookSubscription.findMany({
      orderBy: { createdAt: "desc" },
    });
  },
);

fastify.delete<{ Params: { id: string } }>(
  "/api/webhooks/:id",
  { preValidation: [fastify.serviceAuth] },
  async (request, reply) => {
    const { id } = request.params;
    const existing = await prisma.webhookSubscription.findUnique({
      where: { id },
    });
    if (!existing) {
      return reply.code(404).send({
        error: {
          code: "NOT_FOUND",
          message: `Webhook subscription ${id} not found`,
        },
      });
    }
    await prisma.$transaction(async (tx) => {
      await tx.webhookSubscription.delete({ where: { id } });
      await logAuditEvent(
        "webhook.deleted",
        "webhook",
        id,
        { before: existing, after: null },
        request,
        tx as unknown as Parameters<typeof logAuditEvent>[5],
      );
    });
    cacheState.subscriptions = null; // Invalidate cache
    return reply.code(204).send();
  },
);

fastify.post<{ Params: { id: string }; Querystring: { merchantId?: string } }>(
  "/api/webhooks/:id/test",
  { preValidation: [fastify.serviceAuth] },
  async (request, reply) => {
    const { id } = request.params;
    const { merchantId: callerMerchantId } = request.query;
    const existing = await prisma.webhookSubscription.findUnique({
      where: { id },
    });

    if (!existing) {
      return reply.code(404).send({
        error: {
          code: "NOT_FOUND",
          message: `Webhook subscription ${id} not found`,
        },
      });
    }

    // #624: this route sits behind serviceAuth (any trusted internal caller,
    // not a merchant-identity check), so it has no auth boundary of its own
    // for *which* merchant is allowed to test *which* subscription. The
    // merchant-facing api-gateway route already rejects a cross-merchant
    // test before ever calling this one, and forwards its own verified
    // caller as `?merchantId=`. Re-checking it here is defense in depth: a
    // future internal caller that skips that pre-check (or a stale/replayed
    // request) cannot silently poison another merchant's subscription
    // status. A subscription without a merchantId (a global/system
    // subscription) has no owner to check against here — see the analogous
    // gap already called out for the gateway route in issue #624.
    if (
      existing.merchantId &&
      callerMerchantId &&
      existing.merchantId !== callerMerchantId
    ) {
      return reply.code(403).send({
        error: {
          code: "FORBIDDEN",
          message: "Cannot test webhook subscription owned by another merchant",
        },
      });
    }

    const payload = {
      type: "test",
      timestamp: new Date().toISOString(),
      subscriptionId: id,
      test: true,
    };

    const job = await webhookQueue.add(
      "deliver",
      {
        url: existing.url,
        event: payload,
        version: "1.0",
        signingSecret: existing.signingSecret ?? undefined,
        headers:
          (existing.headers as Record<string, string> | null) ?? undefined,
      },
      { attempts: 1 },
    );

    const queueEvents = new QueueEvents("indexer-webhooks", {
      connection: sharedRedis,
    });
    try {
      await job.waitUntilFinished(queueEvents);

      const testedAt = new Date();
      await prisma.webhookSubscription.update({
        where: { id },
        data: {
          lastTestedAt: testedAt,
          lastTestStatus: "success",
          lastTestStatusCode: 200,
        },
      });
      return { success: true, statusCode: 200 };
    } catch (err: any) {
      let statusCode = null;
      let errorMsg = err.message || String(err);
      const match = errorMsg.match(/HTTP (\d+) from/);
      if (match) {
        statusCode = parseInt(match[1], 10);
        errorMsg = `HTTP ${statusCode}`;
      } else if (errorMsg.includes("connect ECONNREFUSED")) {
        errorMsg = "connect ECONNREFUSED";
      }

      const testedAt = new Date();
      await prisma.webhookSubscription.update({
        where: { id },
        data: {
          lastTestedAt: testedAt,
          lastTestStatus: "failed",
          lastTestStatusCode: statusCode,
        },
      });

      const response: any = { success: false, error: errorMsg };
      if (statusCode) response.statusCode = statusCode;
      return response;
    } finally {
      await queueEvents.close();
    }
  },
);

// ── Admin: dead-letter queue (#354) ──────────────────────────────────────────

fastify.get(
  "/api/admin/webhooks/dead-letter",
  { preValidation: [fastify.serviceAuth] },
  async (request) => {
    const { limit = 50, offset = 0 } = request.query as Record<
      string,
      unknown
    > as { limit?: number; offset?: number };
    const safeLimit = Math.min(Number(limit) || 50, 200);
    const safeOffset = Math.max(Number(offset) || 0, 0);

    const jobs = await dlqQueue.getJobs(
      ["failed"],
      safeOffset,
      safeOffset + safeLimit - 1,
    );
    const total = await dlqQueue.getJobCounts("failed");

    return {
      data: jobs.map((job) => ({
        id: job.id,
        url: job.data.url,
        event: job.data.event,
        failedAt: (job.data as any).failedAt,
        error: (job.data as any).error,
        attempts: (job.data as any).attempts,
        originalJobId: (job.data as any).originalJobId,
        timestamp: job.timestamp,
      })),
      pagination: { total: total.failed, limit: safeLimit, offset: safeOffset },
    };
  },
);

fastify.post<{ Params: { id: string } }>(
  "/api/admin/webhooks/dead-letter/:id/replay",
  { preValidation: [fastify.serviceAuth] },
  async (request, reply) => {
    const { id } = request.params;
    const job = await dlqQueue.getJob(id);
    if (!job) {
      return reply.code(404).send({
        error: { code: "NOT_FOUND", message: `DLQ job ${id} not found` },
      });
    }

    // Re-enqueue on the main webhook delivery queue. Custom headers
    // (Authorization, X-Idempotency-Key, ...) live on job.data.headers
    // alongside url/event/signingSecret (see dispatchPendingWebhookDeliveries
    // and the webhookWorker "failed" handler that spreads job.data into the
    // DLQ) — omitting it here meant a replayed delivery arrived without the
    // merchant's expected auth header and was rejected (#614).
    await webhookQueue.add("deliver", {
      url: job.data.url,
      event: job.data.event,
      signingSecret: job.data.signingSecret,
      headers: job.data.headers,
    });

    // Remove from DLQ
    await job.remove();

    fastify.log.info(
      { jobId: id, url: job.data.url },
      "[Indexer] DLQ job replayed",
    );
    return { status: "requeued", jobId: id, url: job.data.url };
  },
);

// ── Stellar RPC polling loop ──────────────────────────────────────────────────

async function pollEvents() {
  const pollStart = Date.now();
  let aborted = false;

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
      pollDurationHistogram.observe((Date.now() - pollStart) / 1000);
      pollCyclesCounter.inc({ status: "success" });
      setTimeout(pollEvents, currentBackoff);
      return;
    }

    const perLedgerTimeoutMs = env.POLL_TIMEOUT_MS;

    // Wrap server.getEvents() with per-ledger timeout (#565)
    let response: Awaited<ReturnType<typeof server.getEvents>>;
    try {
      response = await Promise.race([
        server.getEvents({
          startLedger: latestLedgerCursor ?? 0,
          filters: CONTRACT_IDS.map((contractId) => ({
            type: "contract" as const,
            contractIds: [contractId],
            topics: [],
          })),
          limit: 100,
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("PER_LEDGER_TIMEOUT")), perLedgerTimeoutMs),
        ),
      ]);
      consecutiveSkips = 0;
    } catch (err: unknown) {
      if (err instanceof Error && err.message === "PER_LEDGER_TIMEOUT") {
        indexerLedgerTimeoutsCounter.inc();
        consecutiveSkips++;
        fastify.log.warn(
          { consecutiveSkips, perLedgerTimeoutMs },
          "[Indexer] Per-ledger timeout — skipping stuck ledger",
        );
        if (consecutiveSkips >= MAX_CONSECUTIVE_SKIPS) {
          currentBackoff = Math.min(currentBackoff * 2, MAX_BACKOFF);
          indexerPollBackoffGauge.set(currentBackoff);
          fastify.log.error(
            { consecutiveSkips, backoff: currentBackoff },
            "[Indexer] Too many consecutive timeouts — backing off",
          );
        }
        indexerLedgerSkipsCounter.inc();
        pollCyclesCounter.inc({ status: "timeout" });
        pollDurationHistogram.observe((Date.now() - pollStart) / 1000);
        setTimeout(pollEvents, currentBackoff);
        return;
      }
      throw err;
    }

    const timeoutMs = env.POLL_TIMEOUT_MS;

    if (response.events && response.events.length > 0) {
      for (const evt of response.events) {
        if (aborted) break;
        const elapsed = Date.now() - pollStart;
        if (elapsed > timeoutMs) {
          fastify.log.warn(
            { elapsed, timeoutMs },
            "[Indexer] Poll cycle timeout exceeded — aborting",
          );
          aborted = true;
          break;
        }

        const topics = Array.isArray(evt.topic)
          ? evt.topic.map(String)
          : [String(evt.topic)];
        const rawValue = evt.value.toXDR("base64");
        const decodedPayload = decodeScVal(evt.value, topics[0]);
        const resolvedContractId = evt.contractId
          ? evt.contractId.toString()
          : CONTRACT_IDS[0];
        const contractName = getContractName(resolvedContractId);
        const stellarId = typeof evt.id === "string" ? evt.id : null;

        const validationError = validatePayload(topics[0], decodedPayload);

        const result = await persistEvent(
          stellarId,
          topics,
          topics[0],
          resolvedContractId,
          contractName,
          rawValue,
          decodedPayload,
          evt.ledger,
          validationError,
        );
        if (latestLedgerCursor !== undefined && result !== null) {
          latestLedgerCursor = Math.max(latestLedgerCursor, evt.ledger + 1);
        }

        eventsFetchedCounter.inc({ contractId: resolvedContractId });
      }
    } else if (
      latestLedgerSequence !== undefined &&
      latestLedgerCursor !== undefined
    ) {
      latestLedgerCursor = Math.max(latestLedgerCursor, latestLedgerSequence);
    }

    if (!aborted) {
      latestLedgerCursor = cursor;
    }

    // Warn if the indexer is too far behind the network tip
    if (latestLedgerSequence !== undefined && !aborted) {
      const lag = latestLedgerSequence - cursor;
      if (lag > env.INDEXER_LAG_WARN_THRESHOLD) {
        fastify.log.warn(
          { lag, threshold: env.INDEXER_LAG_WARN_THRESHOLD },
          "[Indexer] Indexer lag exceeds threshold",
        );
      }
    }

    // Issue #345 — Update lag metrics after each poll cycle
    if (latestLedgerSequence !== undefined) {
      indexerNetworkTipLedgerGauge.set(latestLedgerSequence);
      const currentLag =
        latestLedgerSequence - (latestLedgerCursor ?? latestLedgerSequence);
      for (const contractId of CONTRACT_IDS) {
        indexerLagGauge.set({ contractId }, currentLag);
      }
    } else {
      // Network tip unavailable — set lag to -1
      for (const contractId of CONTRACT_IDS) {
        indexerLagGauge.set({ contractId }, -1);
      }
    }

    if (latestLedgerCursor !== undefined) {
      indexerLastIndexedLedgerGauge.set(latestLedgerCursor);
    }

    calculateBackoffAfterSuccess();
    pollDurationHistogram.observe((Date.now() - pollStart) / 1000);
    pollCyclesCounter.inc({ status: "success" });
    setTimeout(pollEvents, currentBackoff);
  } catch (err) {
    fastify.log.error(`[Indexer] Polling error: ${err}`);
    pollCyclesCounter.inc({ status: "error" });
    const backoffMs = calculateBackoffAfterError(err);
    const jitter = backoffMs * (0.75 + Math.random() * 0.5);
    fastify.log.info(
      `[Indexer] Retrying in ${Math.round(jitter)}ms (backoff: ${backoffMs}ms)`,
    );
    setTimeout(pollEvents, jitter);
  }
}

/**
 * Builds the Prisma `where` clause for the DB cleanup query.
 * Extracted as a pure function so it can be unit-tested without a DB connection.
 *
 * @internal exported for testing only
 */
export function buildCleanupWhere(
  retentionDays: number,
  now: Date,
): { indexedAt: { lt: Date } } | null {
  if (retentionDays <= 0) return null;
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
  return { indexedAt: { lt: cutoff } };
}

/**
 * Deletes IndexedEvent rows from the database that are older than
 * `EVENT_RETENTION_DAYS`. Returns the number of rows deleted (or a dry-run result).
 *
 * When `EVENT_RETENTION_DAYS` is 0 (the default), cleanup is disabled and the
 * function returns 0 immediately.
 */
export async function cleanupOldEvents(
  dryRun?: boolean,
): Promise<number | CleanupDryRunResult> {
  const retentionDays = env.EVENT_RETENTION_DAYS;
  const where = buildCleanupWhere(retentionDays, new Date());
  if (!where) {
    if (dryRun)
      return {
        wouldDelete: 0,
        totalSizeBytes: 0,
        retentionDays: 0,
        oldestEventDate: "",
      };
    return 0;
  }

  if (dryRun) {
    const [count, oldest, sizeResult] = await Promise.all([
      prisma.indexedEvent.count({ where }),
      prisma.indexedEvent.findFirst({
        where,
        orderBy: { indexedAt: "asc" },
        select: { indexedAt: true },
      }),
      prisma.$queryRawUnsafe<Array<{ total_bytes: bigint }>>(
        `SELECT COALESCE(SUM(pg_column_size(t.*)), 0) as total_bytes FROM "IndexedEvent" t WHERE t."indexedAt" < $1`,
        where.indexedAt.lt,
      ),
    ]);
    const totalSizeBytes = Number(sizeResult[0]?.total_bytes ?? 0);
    return {
      wouldDelete: count,
      totalSizeBytes,
      retentionDays,
      oldestEventDate: oldest?.indexedAt.toISOString() ?? "",
    };
  }

  // Issue 507: Skip cleanup for entries with active webhook jobs
  const jobs = await webhookQueue.getJobs(["active", "waiting", "delayed"]);
  const activeEventIds = jobs
    .map((j) => (j.data as any)?.event?.id)
    .filter((id) => typeof id === "string");

  if (activeEventIds.length > 0) {
    (where as any).id = { notIn: activeEventIds };
  }

  const { count } = await prisma.indexedEvent.deleteMany({ where });
  return count;
}

export async function runCleanupJob(data?: {
  dryRun?: boolean;
}): Promise<void> {
  const dryRun = data?.dryRun ?? false;
  try {
    const result = await cleanupOldEvents(dryRun);
    if (dryRun) {
      const dryResult = result as CleanupDryRunResult;
      fastify.log.info(
        {
          wouldDelete: dryResult.wouldDelete,
          totalSizeBytes: dryResult.totalSizeBytes,
          retentionDays: dryResult.retentionDays,
          oldestEventDate: dryResult.oldestEventDate,
          status: "dry-run",
        },
        `[Indexer] Dry-run cleanup: would delete ${dryResult.wouldDelete} events (${dryResult.totalSizeBytes} bytes)`,
      );
    } else {
      const deletedCount = result as number;
      fastify.log.info(
        {
          retentionDays: env.EVENT_RETENTION_DAYS,
          deletedCount,
          status: "success",
        },
        `[Indexer] Event retention cleanup completed. Retention period: ${env.EVENT_RETENTION_DAYS} days. Deleted: ${deletedCount} events. Status: success`,
      );
    }
  } catch (error: any) {
    fastify.log.error(
      {
        retentionDays: env.EVENT_RETENTION_DAYS,
        error: error?.message || error,
        status: "failed",
      },
      `[Indexer] Event retention cleanup failed. Retention period: ${env.EVENT_RETENTION_DAYS} days. Error: ${error}. Status: failed`,
    );
  }
}

let cleanupInterval: NodeJS.Timeout | undefined = undefined;

export function startCleanupScheduler(): void {
  if (env.EVENT_RETENTION_DAYS > 0) {
    // Run once during startup, then every 24 hours.
    // Fire-and-forget: errors are caught and logged inside runCleanupJob().
    void runCleanupJob();
    cleanupInterval = setInterval(
      () => void runCleanupJob(),
      24 * 60 * 60 * 1000,
    );
  }
}

export function stopCleanupScheduler(): void {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = undefined;
  }
}
// ── Startup ───────────────────────────────────────────────────────────────────

/**
 * Discovers the correct starting ledger for the polling loop (#352).
 *
 * Priority:
 *   1. INDEX_FROM_LEDGER env var (manual override)
 *   2. Latest indexed event ledger + 1 (resume where we left off)
 *   3. Network tip - INITIAL_BACKFILL_LEDGERS (fresh deployment)
 *   4. Ledger 1 (RPC failure fallback)
 */
export async function discoverStartLedger(): Promise<number> {
  // 1. Manual override
  if (env.INDEX_FROM_LEDGER) {
    const manual = parseInt(env.INDEX_FROM_LEDGER, 10);
    if (Number.isFinite(manual) && manual >= 1) {
      fastify.log.info(
        { ledger: manual },
        "[Indexer] Starting from manual INDEX_FROM_LEDGER",
      );
      return manual;
    }
    fastify.log.warn(
      { raw: env.INDEX_FROM_LEDGER },
      "[Indexer] Invalid INDEX_FROM_LEDGER — ignoring",
    );
  }

  // 2. Resume from latest indexed event
  try {
    const latest = await prisma.indexedEvent.findFirst({
      orderBy: { ledger: "desc" },
      select: { ledger: true },
    });
    if (latest) {
      const resumeFrom = latest.ledger + 1;
      fastify.log.info(
        { ledger: resumeFrom, latestIndexed: latest.ledger },
        "[Indexer] Resuming from latest indexed event",
      );
      return resumeFrom;
    }
  } catch (err) {
    fastify.log.warn(
      { err: String(err) },
      "[Indexer] Failed to query latest indexed event",
    );
  }

  // 3. Fresh deployment — start from network tip minus backfill window
  try {
    const tip = await server.getLatestLedger();
    const backfill = env.INITIAL_BACKFILL_LEDGERS;
    const startLedger = Math.max(1, tip.sequence - backfill);
    fastify.log.info(
      { tip: tip.sequence, backfill, startLedger },
      "[Indexer] Fresh deployment — starting from network tip minus backfill",
    );
    return startLedger;
  } catch (err) {
    fastify.log.warn(
      { err: String(err) },
      "[Indexer] Failed to query Stellar RPC for tip — falling back to ledger 1",
    );
  }

  // 4. Fallback
  fastify.log.warn(
    "[Indexer] No indexed events and RPC unavailable — starting from ledger 1",
  );
  return 1;
}

const start = async () => {
  try {
    // #391 — wait for both dependencies before accepting traffic
    // #519 — log active feature flags at startup so the deployed flag set is
    // always visible in the service logs.
    logFeatureFlags(fastify.log);

    await connectWithRetry(prisma, fastify.log);
    await waitForRedis(redisHealth, fastify.log);

    // #387 — Redis memory monitoring
    startRedisMemoryMonitor(redisHealth, fastify.log);

    // #352 — smart startup ledger discovery
    latestLedgerCursor = await discoverStartLedger();

    await fastify.listen({ port: PORT, host: "0.0.0.0" });
    fastify.log.info("[Indexer] Starting Stellar RPC polling loop...");
    pollEvents();
    startCleanupScheduler();
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

process.on("SIGTERM", async () => {
  await prisma.$disconnect();
  await replayQueue.close();
  await closeWorkerWithTimeout(
    replayWorker,
    "indexer-replays",
    fastify.log,
    getActiveReplayJob,
  );
  await webhookQueue.close();
  await closeWorkerWithTimeout(
    webhookWorker,
    "indexer-webhooks",
    fastify.log,
    getActiveWebhookJob,
  );
  await dlqQueue.close();
  await replayProgressRedis.quit().catch(() => {});
  await fastify.close();
  await new Promise<void>((resolve) => metricsServer.close(() => resolve()));
  process.exit(0);
});

if (process.env.NODE_ENV !== "test") {
  start();
}
