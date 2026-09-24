/**
 * Indexer HTTP client (Issue #116)
 *
 * The api-gateway has `INDEXER_URL` configured but historically never queried the
 * indexer. This client lets payment-status lookups cross-reference on-chain
 * events indexed from the settlement contract, giving end-to-end visibility of a
 * payment's lifecycle.
 *
 * Design goals:
 *  - **Graceful degradation:** the indexer is an *enrichment* source, never a
 *    dependency for serving payment data. Any failure (timeout, network error,
 *    non-2xx, malformed body) resolves to `null` so callers can return the
 *    payment without events instead of failing the request.
 *  - **Bounded latency:** every request is capped by a 5s timeout via
 *    `AbortController`, so a slow/hung indexer cannot stall the gateway.
 *  - **Testable:** `fetchImpl` is injectable for unit tests.
 */

import type { IndexedEvent, EventType } from '@bettapay/validation';
import { propagateTracingHeaders } from '@bettapay/validation';
import { defaultInterServiceMetrics, type InterServiceMetrics } from './inter-service-metrics.js';

type IncomingHeaders = Record<string, string | string[] | undefined>;

/**
 * A single indexed on-chain event as returned by the indexer's `/api/events`.
 * Aliased to the shared `IndexedEvent` type so the gateway and indexer stay in
 * lock-step on the event shape (`{ topics, type, rawValue, … }`).
 */
export type IndexerEvent = IndexedEvent;

interface MinimalLogger {
  warn: (obj: unknown, msg?: string) => void;
}

export interface IndexerClientOptions {
  /** Base URL of the indexer service, e.g. `http://localhost:3003`. */
  baseUrl: string;
  /**
   * Shared INTER_SERVICE_SECRET sent as the `x-service-token` header so the
   * indexer's serviceAuth accepts the request (#117). Optional for backwards
   * compatibility / local setups without inter-service auth.
   */
  serviceToken?: string;
  /** Per-request timeout in milliseconds (default 5000). */
  timeoutMs?: number;
  /** Injectable fetch implementation (defaults to global `fetch`). */
  fetchImpl?: typeof fetch;
  /** Optional logger for degradation diagnostics. */
  logger?: MinimalLogger;
  /** Optional metrics instance (defaults to shared singleton). */
  metrics?: InterServiceMetrics;
}

export const DEFAULT_INDEXER_TIMEOUT_MS = 2_000;

/** Event type identifying a completed payment on-chain. */
export const PAYMENT_COMPLETED_TYPE: EventType = 'PaymentCompleted';

export interface IndexerClient {
  /**
   * Fetch on-chain `PaymentCompleted` events related to a merchant.
   *
   * @param merchantId      merchant whose events to fetch
   * @param incomingHeaders inbound request headers; tracing headers
   *                        (x-request-id / x-trace-id) are propagated downstream (#118)
   * @returns the matching events on success (possibly empty), or `null` when the
   *          indexer is unavailable so the caller can degrade gracefully.
   */
  getPaymentEvents(merchantId: string, incomingHeaders?: IncomingHeaders): Promise<IndexerEvent[] | null>;

  /**
   * Triggers a synthetic test event for a webhook subscription via the indexer.
   *
   * @param id The webhook subscription ID to test.
   * @param merchantId The calling merchant's own id (#624) — forwarded so the
   *        indexer can enforce ownership as a second, independent check even
   *        though this gateway route already rejects a cross-merchant test
   *        before ever reaching here (defense in depth, not the only guard).
   * @param incomingHeaders inbound request headers; tracing headers are propagated.
   * @returns the test result, or `null` if the indexer is unavailable.
   */
  testWebhook(id: string, merchantId: string, incomingHeaders?: IncomingHeaders): Promise<{ success: boolean; statusCode?: number; error?: string } | null>;
}

export function createIndexerClient(options: IndexerClientOptions): IndexerClient {
  const {
    baseUrl,
    serviceToken,
    timeoutMs = DEFAULT_INDEXER_TIMEOUT_MS,
    fetchImpl = fetch,
    logger,
    metrics = defaultInterServiceMetrics,
  } = options;

  const root = baseUrl.replace(/\/+$/, '');
  // Service token authenticates this gateway to the indexer (#117).
  const authHeaders: Record<string, string> = serviceToken
    ? { 'x-service-token': serviceToken }
    : {};

  const TARGET = 'indexer';
  const ENDPOINT = '/api/events';

  async function getPaymentEvents(
    merchantId: string,
    incomingHeaders: IncomingHeaders = {},
  ): Promise<IndexerEvent[] | null> {
    // Auth (#117) + tracing (#118) headers for this inter-service call.
    const headers = propagateTracingHeaders(incomingHeaders, { ...authHeaders });
    // The indexer filters by `?type=` server-side; `merchantId` is forwarded for
    // forward-compatibility (ignored until the indexer decodes it). We still
    // filter by the typed `event.type` client-side as a defensive backstop.
    const url =
      `${root}/api/events` +
      `?type=${encodeURIComponent(PAYMENT_COMPLETED_TYPE)}` +
      `&merchantId=${encodeURIComponent(merchantId)}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const startedAt = Date.now();

    try {
      const res = await fetchImpl(url, { signal: controller.signal, headers });
      const durationSeconds = (Date.now() - startedAt) / 1000;
      const statusCode = String(res.status);

      metrics.duration.observe({ target_service: TARGET, endpoint: ENDPOINT, status_code: statusCode }, durationSeconds);

      if (!res.ok) {
        metrics.failures.inc({ target_service: TARGET, endpoint: ENDPOINT, status_code: statusCode });
        logger?.warn(
          { status: res.status, merchantId },
          'indexer-client: non-OK response — returning no events',
        );
        return null;
      }

      const body = (await res.json()) as { events?: unknown };
      const events = Array.isArray(body?.events) ? (body.events as IndexerEvent[]) : [];

      return events.filter((e) => e?.type === PAYMENT_COMPLETED_TYPE);
    } catch (err) {
      // Timeout (AbortError), network failure, or malformed JSON all degrade to
      // "no events available" rather than failing the payment lookup.
      const durationSeconds = (Date.now() - startedAt) / 1000;
      const isTimeout = err instanceof Error && err.name === 'AbortError';
      const statusCode = isTimeout ? 'timeout' : 'network_error';

      metrics.failures.inc({ target_service: TARGET, endpoint: ENDPOINT, status_code: statusCode });
      metrics.duration.observe({ target_service: TARGET, endpoint: ENDPOINT, status_code: statusCode }, durationSeconds);

      // Circuit-breaker log: distinguish fast read-timeout from other failures
      // so the outage is always visible in logs even though we degrade gracefully.
      logger?.warn(
        { err, merchantId, timedOut: isTimeout },
        isTimeout
          ? 'indexer-client: read timeout — degrading without events'
          : 'indexer-client: request failed — degrading without events',
      );
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async function testWebhook(
    id: string,
    merchantId: string,
    incomingHeaders: IncomingHeaders = {},
  ): Promise<{ success: boolean; statusCode?: number; error?: string } | null> {
    const headers = propagateTracingHeaders(incomingHeaders, { ...authHeaders });
    const url =
      `${root}/api/webhooks/${encodeURIComponent(id)}/test` +
      `?merchantId=${encodeURIComponent(merchantId)}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const startedAt = Date.now();

    try {
      const res = await fetchImpl(url, { method: 'POST', signal: controller.signal, headers });
      const durationSeconds = (Date.now() - startedAt) / 1000;
      const statusCode = String(res.status);

      metrics.duration.observe({ target_service: TARGET, endpoint: '/api/webhooks/:id/test', status_code: statusCode }, durationSeconds);

      if (!res.ok) {
        metrics.failures.inc({ target_service: TARGET, endpoint: '/api/webhooks/:id/test', status_code: statusCode });
        
        let errorData: any = null;
        try { errorData = await res.json(); } catch { /* ignore */ }
        
        logger?.warn(
          { status: res.status, id, errorData },
          'indexer-client: testWebhook non-OK response',
        );
        // We could return null or bubble up the error. We return the JSON error if it conforms, else null.
        if (errorData?.error && typeof errorData.error === 'object' && errorData.error.code === 'NOT_FOUND') {
            throw new Error('NOT_FOUND');
        }
        return null;
      }

      const body = await res.json();
      return body as { success: boolean; statusCode?: number; error?: string };
    } catch (err) {
      if (err instanceof Error && err.message === 'NOT_FOUND') throw err;
      const durationSeconds = (Date.now() - startedAt) / 1000;
      const isTimeout = err instanceof Error && err.name === 'AbortError';
      const statusCode = isTimeout ? 'timeout' : 'network_error';

      metrics.failures.inc({ target_service: TARGET, endpoint: '/api/webhooks/:id/test', status_code: statusCode });
      metrics.duration.observe({ target_service: TARGET, endpoint: '/api/webhooks/:id/test', status_code: statusCode }, durationSeconds);

      logger?.warn(
        { err, id, timedOut: isTimeout },
        isTimeout
          ? 'indexer-client: testWebhook read timeout'
          : 'indexer-client: testWebhook request failed',
      );
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  return { getPaymentEvents, testWebhook };
}
