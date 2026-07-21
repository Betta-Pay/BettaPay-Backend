/**
 * @bettapay/webhook-delivery
 *
 * Shared, production-grade webhook delivery built on BullMQ.
 *
 * Both the indexer and the settlement engine need to deliver HTTP POST
 * payloads to merchant-registered URLs with reliable retry semantics.
 * Previously the settlement engine used a hand-rolled `sendWebhookWithRetries`
 * that blocked the BullMQ worker thread during back-off sleeps and offered
 * no persistence, no dead-letter handling, and no observability.  This
 * package replaces both implementations with a single, queue-backed approach.
 *
 * Design
 * ──────
 *  createWebhookQueue(name, connection, opts?)
 *    Returns a configured BullMQ Queue ready to accept `WebhookJobData` jobs.
 *    Callers enqueue a job; the worker does all retrying.
 *
 *  createWebhookWorker(queueName, connection, opts?)
 *    Returns a BullMQ Worker that processes `WebhookJobData` jobs.
 *    Delivery uses a 5 s AbortController timeout per attempt.
 *    BullMQ's own exponential back-off handles retry scheduling — no
 *    in-process `setTimeout` sleeping required.
 *
 * Retry / back-off
 * ────────────────
 *  Default: 5 attempts, exponential back-off starting at 1 000 ms.
 *  Attempt 1 → immediate, attempt 2 → ~1 s, attempt 3 → ~2 s, …
 *  These defaults match the indexer's original inline queue config and
 *  replace the settlement engine's manual loop.
 *
 * Migration / in-flight jobs
 * ──────────────────────────
 *  Queues are named.  The indexer previously used 'indexer-webhooks';
 *  the settlement engine had no persistent queue.  When deploying:
 *
 *  1. Indexer: pass `name: 'indexer-webhooks'` to createWebhookQueue /
 *     createWebhookWorker so existing in-flight jobs in Redis are picked up
 *     by the new worker without data loss.
 *
 *  2. Settlement engine: a fresh queue name (e.g. 'settlement-webhooks')
 *     is fine — the old code had no persistence so there are no in-flight
 *     jobs to migrate.
 *
 * Usage
 * ─────
 *  import { createWebhookQueue, createWebhookWorker } from '@bettapay/webhook-delivery';
 *
 *  const queue  = createWebhookQueue('my-webhooks', redisConnection);
 *  const worker = createWebhookWorker('my-webhooks', redisConnection, { logger });
 *
 *  // Enqueue a delivery
 *  await queue.add('deliver', { url: 'https://merchant.example/hook', event: { ... } });
 *
 *  // Cleanup on shutdown
 *  await worker.close();
 *  await queue.close();
 */

import { Queue, Worker, type ConnectionOptions, type WorkerOptions, type QueueOptions } from 'bullmq';

// ── Public types ──────────────────────────────────────────────────────────────

/** Payload for every webhook delivery job. */
export interface WebhookJobData {
  /** The HTTPS (or HTTP in dev) URL to POST to. */
  url: string;
  /** Arbitrary JSON-serialisable event payload. */
  event: Record<string, unknown>;
}

/** Subset of a logger that the worker uses for structured output. */
export interface WebhookLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

/** Options accepted by createWebhookQueue. */
export interface WebhookQueueOptions {
  /** Number of completed jobs to keep in Redis (default 100). */
  removeOnCompleteCount?: number;
  /** Number of failed jobs to keep in Redis for inspection (default 500). */
  removeOnFailCount?: number;
  /** Number of delivery attempts before the job is marked failed (default 5). */
  attempts?: number;
  /** Initial back-off delay in milliseconds for exponential retry (default 1000). */
  backoffDelay?: number;
  /** Any additional BullMQ QueueOptions to pass through. */
  queueOptions?: Partial<QueueOptions>;
}

/** Options accepted by createWebhookWorker. */
export interface WebhookWorkerOptions {
  /** Per-attempt HTTP timeout in milliseconds (default 5000). */
  timeoutMs?: number;
  /** Worker concurrency — how many jobs run in parallel (default 10). */
  concurrency?: number;
  /** Optional structured logger.  If omitted all logging is suppressed. */
  logger?: WebhookLogger;
  /** Injectable fetch implementation — used by tests to avoid real HTTP. */
  fetchImpl?: typeof fetch;
  /** Any additional BullMQ WorkerOptions to pass through. */
  workerOptions?: Partial<WorkerOptions>;
}

// ── Defaults ──────────────────────────────────────────────────────────────────

export const WEBHOOK_DEFAULTS = {
  attempts: 5,
  backoffDelay: 1_000,
  concurrency: 10,
  timeoutMs: 5_000,
  removeOnCompleteCount: 100,
  removeOnFailCount: 500,
} as const;

// ── Factory: Queue ────────────────────────────────────────────────────────────

/**
 * Creates a BullMQ Queue pre-configured for webhook delivery.
 *
 * @param name       Queue name.  Use the same name as the matching worker.
 * @param connection BullMQ ConnectionOptions (host/port or ioredis instance).
 * @param opts       Optional overrides for job defaults.
 */
export function createWebhookQueue(
  name: string,
  connection: ConnectionOptions,
  opts: WebhookQueueOptions = {},
): Queue<WebhookJobData> {
  const {
    attempts = WEBHOOK_DEFAULTS.attempts,
    backoffDelay = WEBHOOK_DEFAULTS.backoffDelay,
    removeOnCompleteCount = WEBHOOK_DEFAULTS.removeOnCompleteCount,
    removeOnFailCount = WEBHOOK_DEFAULTS.removeOnFailCount,
    queueOptions = {},
  } = opts;

  return new Queue<WebhookJobData>(name, {
    connection,
    defaultJobOptions: {
      attempts,
      backoff: { type: 'exponential', delay: backoffDelay },
      removeOnComplete: { count: removeOnCompleteCount },
      removeOnFail: { count: removeOnFailCount },
    },
    ...queueOptions,
  });
}

// ── Factory: Worker ───────────────────────────────────────────────────────────

/**
 * Creates a BullMQ Worker that processes webhook delivery jobs.
 *
 * Each job attempt POSTs `event` as JSON to `url` with a bounded timeout.
 * On non-2xx response the job throws so BullMQ applies the configured
 * exponential back-off — no in-process sleep loop required.
 *
 * @param queueName  Must match the queue name used with createWebhookQueue.
 * @param connection BullMQ ConnectionOptions.
 * @param opts       Optional overrides for concurrency, timeout, logger, fetch.
 */
export function createWebhookWorker(
  queueName: string,
  connection: ConnectionOptions,
  opts: WebhookWorkerOptions = {},
): Worker<WebhookJobData> {
  const {
    timeoutMs = WEBHOOK_DEFAULTS.timeoutMs,
    concurrency = WEBHOOK_DEFAULTS.concurrency,
    logger,
    fetchImpl = fetch,
    workerOptions = {},
  } = opts;

  const worker = new Worker<WebhookJobData>(
    queueName,
    async (job) => {
      const { url, event } = job.data;
      const attempt = job.attemptsMade + 1; // attemptsMade is 0-indexed

      logger?.info({ url, jobId: job.id, attempt }, '[webhook-delivery] Delivering webhook');

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const response = await fetchImpl(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ event }),
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          // Throw so BullMQ marks this attempt failed and schedules a retry.
          throw new Error(
            `[webhook-delivery] HTTP ${response.status} from ${url} — job ${job.id} attempt ${attempt}`,
          );
        }

        logger?.info({ url, jobId: job.id, attempt, status: response.status }, '[webhook-delivery] Webhook delivered');
      } catch (err) {
        clearTimeout(timeoutId);
        logger?.warn(
          { url, jobId: job.id, attempt, err: err instanceof Error ? err.message : String(err) },
          '[webhook-delivery] Delivery attempt failed — BullMQ will retry',
        );
        // Re-throw so BullMQ applies back-off and retry logic.
        throw err;
      }
    },
    {
      connection,
      concurrency,
      ...workerOptions,
    },
  );

  return worker;
}
