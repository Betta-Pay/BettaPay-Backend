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
 * Provides fail-closed deduplication, dead-letter archiving, and delivery reliability.
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
 *    Custom headers: pass `headers` on `WebhookJobData` to have the worker
 *    send merchant-specific headers (idempotency keys, bearer tokens, etc.)
 *    with every attempt.  Because they're part of the persisted job data,
 *    the same headers are sent on retries — not just the initial attempt.
 *    `Content-Type` and `X-BettaPay-Signature` can't be overridden this way.
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
import crypto from 'crypto';

// ── Public types ──────────────────────────────────────────────────────────────

/** Payload for every webhook delivery job. */
export interface WebhookJobData {
  /** The HTTPS (or HTTP in dev) URL to POST to. */
  url: string;
  /** Arbitrary JSON-serialisable event payload. */
  event: Record<string, unknown>;
  /** Optional HMAC signing secret.  When present the worker includes an
   *  X-BettaPay-Signature header so the merchant can verify authenticity. */
  signingSecret?: string;
  /** Optional unique event identifier used for Redis-backed deduplication.
   *  When set together with a redis client on the worker, the worker will
   *  attempt a SET NX with 1-hour TTL before dispatch.  If the key already
   *  exists the delivery is skipped (duplicate detected). */
  eventId?: string;
  /** Semantic version of the event payload structure. */
  version?: string;
  /**
   * Optional per-subscription custom headers (e.g. merchant-specific
   * idempotency or auth headers) to send with every delivery attempt.
   *
   * Because these live on `WebhookJobData`, BullMQ persists them as part of
   * the job — the same headers are replayed on every retry attempt, not just
   * the first.  `Content-Type` and `X-BettaPay-Signature` are reserved and
   * cannot be overridden this way (checked case-insensitively) so a
   * misconfigured or malicious header set can't spoof the HMAC signature or
   * change how the body is interpreted.
   */
  headers?: Record<string, string>;
}

/** Header names the worker always controls; custom headers cannot override them. */
const RESERVED_HEADER_NAMES = new Set(['content-type', 'x-bettapay-signature']);

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
  /**
   * Number of failed jobs to keep in Redis for inspection (default 500).
   * Set to `false` to keep ALL failed jobs (useful for dead-letter patterns).
   */
  removeOnFail?: false | number;
  /** Number of delivery attempts before the job is marked failed (default 5). */
  attempts?: number;
  /** Initial back-off delay in milliseconds for exponential retry (default 1000). */
  backoffDelay?: number;
  /** Any additional BullMQ QueueOptions to pass through. */
  queueOptions?: Partial<QueueOptions>;
}

/** Minimal Redis client interface for webhook deduplication. */
export interface DedupRedis {
  set(key: string, value: string, mode: string, duration: string, flag: string): Promise<'OK' | null>;
}

/** Options accepted by createWebhookWorker. */
export interface WebhookWorkerOptions {
  /** Per-attempt HTTP timeout in milliseconds (default 5000). */
  timeoutMs?: number;
  /** 
   * Worker concurrency — how many jobs run in parallel.
   * Defaults to WEBHOOK_CONCURRENCY env var if set, otherwise 10.
   * Can be overridden per-worker for fine-tuned control (#516).
   */
  concurrency?: number;
  /** Optional structured logger.  If omitted all logging is suppressed. */
  logger?: WebhookLogger;
  /** Injectable fetch implementation — used by tests to avoid real HTTP. */
  fetchImpl?: typeof fetch;
  /** Optional Redis client for webhook deduplication.  When set together with
   *  an eventId on the job, the worker performs a SET NX with 1-hour TTL
   *  before dispatch.  If the key already exists the delivery is skipped. */
  redis?: DedupRedis;
  /** Optional dead-letter queue or archive queue to route permanently failed jobs. */
  deadLetterQueue?: Queue<WebhookJobData> | { add: (name: string, data: WebhookJobData) => Promise<unknown> };
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

/**
 * Resolves webhook worker concurrency from environment or default.
 * 
 * Checks WEBHOOK_CONCURRENCY env var first; falls back to default of 10.
 * This allows operators to tune concurrency without code changes (#516).
 * 
 * @param defaultValue  Fallback if env var is unset or invalid (default: 10)
 * @returns             Resolved concurrency value
 */
export function resolveWebhookConcurrency(defaultValue = WEBHOOK_DEFAULTS.concurrency): number {
  const envValue = process.env.WEBHOOK_CONCURRENCY;
  if (envValue) {
    const parsed = parseInt(envValue, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return defaultValue;
}
// ── Canonical JSON serialization ─────────────────────────────────────────────

/**
 * Serializes any JSON-serialisable value into a canonical, deterministic string.
 *
 * `JSON.stringify` emits object keys in insertion order, so two semantically
 * identical payloads can produce different byte strings — e.g. after a
 * parse → log/store → re-stringify round-trip, or when keys were inserted in
 * a different order.  Signing those strings yields different HMACs, which is
 * why a signature computed over `JSON.stringify(payload)` breaks the moment
 * the payload is reserialized anywhere between signing and verification.
 *
 * `canonicalize` removes that fragility:
 *
 *  - object keys are sorted lexicographically, recursively
 *  - no insignificant whitespace is emitted
 *  - array element order is preserved (arrays are ordered by definition)
 *  - strings/numbers/booleans/null serialize exactly as JSON.stringify does
 *
 * Semantically identical payloads therefore always produce byte-identical
 * output, so signer and verifier can always agree on the exact string the
 * HMAC was computed over — even after arbitrary reserialization.
 *
 * @param value Any JSON-serialisable value (e.g. the result of JSON.parse,
 *              or an object literal containing only JSON-safe data).
 * @returns The canonical JSON string.
 */
export function canonicalize(value: unknown): string {
  return serializeCanonical(value);
}

function serializeCanonical(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    return `[${value.map((v) => serializeCanonical(isJsonValue(v) ? v : null)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => isJsonValue(obj[k]))
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${serializeCanonical(obj[k])}`).join(',')}}`;
  }
  if (typeof value === 'number') {
    // JSON.stringify renders NaN/±Infinity as null; mirror that so the
    // canonical form stays valid JSON.
    return Number.isFinite(value) ? JSON.stringify(value) : 'null';
  }
  return JSON.stringify(value);
}

/** True for values JSON.stringify would keep (undefined/functions/symbols are dropped). */
function isJsonValue(value: unknown): boolean {
  return value !== undefined && typeof value !== 'function' && typeof value !== 'symbol';
}

// ── HMAC-SHA256 signing & verification ───────────────────────────────────────

/**
 * Computes an HMAC-SHA256 signature over a canonical JSON body.
 *
 * The returned header format is: `t={unix_seconds},s={hex_hmac}`
 * Merchants should reject signatures older than 5 minutes to prevent replay.
 *
 * Sign the canonical serialization of the payload (see `canonicalize`) — the
 * exact bytes that will be POSTed.  The worker does this automatically before
 * delivery.  Signing and verification both use the canonical form, so the
 * signature survives reserialization.  Use `verifySignature` on the receiving
 * side.
 *
 * @param body   The canonical JSON string that will be POSTed.
 * @param secret The per-subscription signing secret.
 * @returns      The value for the X-BettaPay-Signature header.
 */
export function signPayload(body: string, secret: string): string {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const hmac = crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return `t=${timestamp},s=${hmac}`;
}

/** Options accepted by verifySignature. */
export interface VerifySignatureOptions {
  /**
   * Reject signatures whose embedded timestamp is older than this many
   * seconds.  Recommended: 300 (5 minutes) to prevent replay attacks.
   */
  maxAgeSeconds?: number;
  /** Current unix time in seconds — injectable for deterministic tests. */
  now?: number;
}

/**
 * Verifies an X-BettaPay-Signature header against a payload body.
 *
 * The body must be the canonical serialization that was signed: pass the raw
 * body bytes exactly as received (the worker POSTs the canonical form), or —
 * if the payload was reserialized in transit (logging, storing, resending) —
 * canonicalize it first: `canonicalize(JSON.parse(rawBody))`.  Because signing
 * and verification agree on the canonical form, the signature survives
 * canonical re-serialization.
 *
 * @param body      The (canonical) JSON body that was signed.
 * @param secret    The per-subscription signing secret.
 * @param signature The value of the X-BettaPay-Signature header.
 * @param opts      Optional replay-window enforcement.
 * @returns true if the signature matches (constant-time comparison).
 */
export function verifySignature(
  body: string,
  secret: string,
  signature: string,
  opts: VerifySignatureOptions = {},
): boolean {
  const match = /^t=(\d+),s=([0-9a-f]{64})$/.exec(signature);
  if (!match) return false;

  const timestamp = Number(match[1]);
  const providedHmac = match[2];

  if (opts.maxAgeSeconds !== undefined) {
    const now = opts.now ?? Math.floor(Date.now() / 1000);
    if (!Number.isFinite(timestamp) || now - timestamp > opts.maxAgeSeconds) return false;
  }

  const expected = crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  const expectedBuf = Buffer.from(expected, 'hex');
  const providedBuf = Buffer.from(providedHmac, 'hex');
  return expectedBuf.length === providedBuf.length && crypto.timingSafeEqual(expectedBuf, providedBuf);
}

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
    removeOnFail: removeOnFailOpt,
    queueOptions = {},
  } = opts;

  const removeOnFailCount = removeOnFailOpt ?? WEBHOOK_DEFAULTS.removeOnFailCount;
  const removeOnFailVal = removeOnFailOpt === false ? false : (typeof removeOnFailCount === 'number' ? removeOnFailCount : WEBHOOK_DEFAULTS.removeOnFailCount);

  return new Queue(name, {
    connection,
    defaultJobOptions: {
      attempts,
      backoff: { type: 'exponential', delay: backoffDelay },
      removeOnComplete: { count: removeOnCompleteCount },
      removeOnFail: removeOnFailVal,
    },
    ...queueOptions,
  }) as unknown as Queue<WebhookJobData>;
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
    concurrency = resolveWebhookConcurrency(), // Env-driven default (#516)
    logger,
    fetchImpl = fetch,
    workerOptions = {},
  } = opts;

  const { redis: redisClient } = opts;

  const worker = new Worker<WebhookJobData>(
    queueName,
    async (job) => {
      const { url, event, signingSecret, eventId, version = '1.0', headers: customHeaders } = job.data;
      const attempt = job.attemptsMade + 1; // attemptsMade is 0-indexed

      // ── Deduplication check ─────────────────────────────────────────────
      if (redisClient && eventId) {
        try {
          const dedupKey = `webhook_sent:${eventId}`;
          const claimed = await redisClient.set(dedupKey, '1', 'PX', '3600000', 'NX');
          if (claimed === null) {
            logger?.warn(
              { url, jobId: job.id, eventId },
              '[webhook-delivery] Duplicate webhook detected — skipping delivery',
            );
            return;
          }
        } catch (err) {
          logger?.error(
            { url, jobId: job.id, eventId, err: err instanceof Error ? err.message : String(err) },
            '[webhook-delivery] Redis dedup check failed — failing closed with backoff to prevent duplicate delivery',
          );
          throw new Error(
            `[webhook-delivery] Redis dedup check failed for event ${eventId}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      logger?.info({ url, jobId: job.id, attempt }, '[webhook-delivery] Delivering webhook');

      const body = canonicalize({ version, event });
      const headers: Record<string, string> = {};

      // Custom headers first — merchant-configured idempotency/auth headers
      // are preserved on every attempt because they live on job.data, which
      // BullMQ persists across retries.  Reserved names are dropped here so
      // they can't shadow the Content-Type / signature headers set below.
      for (const [key, value] of Object.entries(customHeaders ?? {})) {
        if (RESERVED_HEADER_NAMES.has(key.toLowerCase())) continue;
        headers[key] = value;
      }

      headers['Content-Type'] = 'application/json';

      if (signingSecret) {
        headers['X-BettaPay-Signature'] = signPayload(body, signingSecret);
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const response = await fetchImpl(url, {
          method: 'POST',
          headers,
          body,
          signal: controller.signal,
        });

        if (!response.ok) {
          // Throw so BullMQ marks this attempt failed and schedules a retry.
          throw new Error(
            `[webhook-delivery] HTTP ${response.status} from ${url} — job ${job.id} attempt ${attempt}`,
          );
        }

        logger?.info({ url, jobId: job.id, attempt, status: response.status }, '[webhook-delivery] Webhook delivered');
      } catch (err) {
        logger?.warn(
          { url, jobId: job.id, attempt, err: err instanceof Error ? err.message : String(err) },
          '[webhook-delivery] Delivery attempt failed — BullMQ will retry',
        );
        // Re-throw so BullMQ applies back-off and retry logic.
        throw err;
      } finally {
        // Ensure timer and abort signal are always cleaned up (#517)
        clearTimeout(timeoutId);
        // Abort if still pending (e.g., on error path before response completes)
        if (!controller.signal.aborted) {
          controller.abort();
        }
      }
    },
    {
      connection,
      concurrency,
      ...workerOptions,
    },
  );

  if (opts.deadLetterQueue) {
    const dlq = opts.deadLetterQueue;
    worker.on('failed', async (job: any, err: any) => {
      if (job && job.attemptsMade >= (job.opts?.attempts ?? WEBHOOK_DEFAULTS.attempts)) {
        try {
          await dlq.add('dead-letter', job.data);
          logger?.info(
            { jobId: job.id, eventId: job.data.eventId },
            '[webhook-delivery] Archived permanently failed job to dead-letter queue',
          );
        } catch (dlqErr) {
          logger?.error(
            { jobId: job.id, err: dlqErr instanceof Error ? dlqErr.message : String(dlqErr) },
            '[webhook-delivery] Failed to archive job to dead-letter queue',
          );
        }
      }
    });
  }

  return worker;
}
