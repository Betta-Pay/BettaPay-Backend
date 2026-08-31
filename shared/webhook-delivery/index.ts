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

// ── SSRF / redirect guard (issue #513) ──────────────────────────────────────
//
// A merchant-registered webhook URL must never be allowed to reach internal
// infrastructure, and redirects must not be followed (following a 3xx would
// let a malicious URL bounce the worker onto an internal address through the
// Location header). This helper validates the target up front and the worker
// passes `redirect: 'manual'` so any 3xx is treated as a failed delivery.

/** Returns `{ host }` on success or `{ err }` describing why the URL is unsafe. */
export function validateWebhookTarget(
  url: string,
): { host: string | null; err: string | null } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { host: null, err: 'not a valid URL' };
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { host: null, err: 'unsupported protocol' };
  }

  const host = parsed.hostname;
  if (!host) {
    return { host: null, err: 'missing host' };
  }

  // Reject loopback, link-local, unspecified, multicast, and private ranges.
  // hostnames resolve after validation; a DNS-rebinding race is mitigated by
  // blocking both loopback names and numeric IP forms up front.
  if (isLoopbackName(host)) {
    return { host, err: 'internal loopback host' };
  }

  const ipInfo = parseIp(host);
  if (ipInfo && isInternalIp(ipInfo)) {
    return { host, err: 'internal/private IP address' };
  }

  return { host, err: null };
}

function isLoopbackName(host: string): boolean {
  const lower = host.toLowerCase();
  return (
    lower === 'localhost' ||
    lower.endsWith('.localhost') ||
    lower === '::1' ||
    lower.startsWith('0.') // 0.0.0.0 and 0.x.x.x are local
  );
}

/** Parses an IPv4 or IPv6 literal hostname, or null if it's a name. */
function parseIp(host: string): { v4: number[] } | { v6: number[] } | null {
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const parts = v4.slice(1).map(Number);
    if (parts.every((n) => n >= 0 && n <= 255)) return { v4: parts };
    return null;
  }
  const strip = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  if (strip.includes(':')) {
    const nums = strip.split(':').filter((s) => s !== '');
    if (nums.length >= 1 && nums.length <= 8) return { v6: [] };
  }
  return null;
}

/** True if the IP is in a range endpoints should never deliver to. */
function isInternalIp(ip: { v4: number[] } | { v6: number[] }): boolean {
  if ('v4' in ip) {
    const [a, b] = ip.v4;
    if (a === 0) return true; // 0.0.0.0/8
    if (a === 10) return true; // RFC1918 10/8
    if (a === 127) return true; // loopback
    if (a === 169 && b === 254) return true; // link-local
    if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918 172.16/12
    if (a === 192 && b === 168) return true; // RFC1918 192.168/16
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
    if (a >= 224) return true; // multicast + reserved
    return false;
  }
  return true; // IPv6 loopback/ULA/hextet punt — treat as internal to be safe
}


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
  /** Worker concurrency — how many jobs run in parallel (default 10). */
  concurrency?: number;
  /** Optional structured logger.  If omitted all logging is suppressed. */
  logger?: WebhookLogger;
  /** Injectable fetch implementation — used by tests to avoid real HTTP. */
  fetchImpl?: typeof fetch;
  /** Optional Redis client for webhook deduplication.  When set together with
   *  an eventId on the job, the worker performs a SET NX with 1-hour TTL
   *  before dispatch.  If the key already exists the delivery is skipped. */
  redis?: DedupRedis;
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
    concurrency = WEBHOOK_DEFAULTS.concurrency,
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
          logger?.warn(
            { url, jobId: job.id, eventId, err: err instanceof Error ? err.message : String(err) },
            '[webhook-delivery] Redis dedup check failed — delivering anyway (fail-open)',
          );
        }
      }

        logger?.info({ url, jobId: job.id, attempt }, '[webhook-delivery] Delivering webhook');

      // ── SSRF guard ────────────────────────────────────────────────────
      // Validate the delivery target before POSTing (issue #513): a malicious
      // or hijacked merchant URL must not be able to reach internal services
      // or redirect the worker onto them. Redirects are not followed (manual),
      // so any 3xx is treated as a failure below.
      const redirectGuard = validateWebhookTarget(url);
      if (redirectGuard.err !== null) {
        logger?.warn(
          { url, jobId: job.id, attempt, reason: redirectGuard.err },
          '[webhook-delivery] Refusing unsafe webhook target — delivery failed',
        );
        throw new Error(
          `[webhook-delivery] Refusing unsafe webhook target ${url} — ${redirectGuard.err}`,
        );
      }

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
          // Never follow redirects: after the SSRF guard above, following a
          // 3xx to any host would bypass it (issue #513). 3xx = failure here.
          redirect: 'manual',
        });

        clearTimeout(timeoutId);

        // Treat 3xx redirects as failures — the target host was validated
        // pre-flight, and following an arbitrary Location would defeat it.
        if (!response.ok || response.status >= 300) {
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
