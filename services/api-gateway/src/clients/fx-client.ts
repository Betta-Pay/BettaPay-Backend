import { z } from 'zod';
import { propagateTracingHeaders } from '@bettapay/validation';
import { defaultInterServiceMetrics, type InterServiceMetrics } from './inter-service-metrics.js';
import { UpstreamReadTimeoutError } from '../upstream-fetch.js';

type IncomingHeaders = Record<string, string | string[] | undefined>;

interface MinimalLogger {
  info?: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
}

export interface FxQuoteRequest {
  from: string;
  to: string;
  amount: string;
}

export interface FxQuoteResponse {
  quoteId: string | null;
  from: string;
  to: string;
  amount: string;
  result: string;
  rate: string;
  slippageBps: number;
  slippageLimit: string;
  cachedAt: string;
  expiresAt: string;
}

export const FxQuoteResponseSchema = z.object({
  quoteId: z.string().nullable().optional(),
  from: z.string().min(1),
  to: z.string().min(1),
  amount: z.string().min(1),
  result: z.string().min(1),
  rate: z.string().min(1),
  slippageBps: z.number(),
  slippageLimit: z.string(),
  cachedAt: z.string(),
  expiresAt: z.string(),
}).passthrough();

export interface FxClientOptions {
  baseUrl: string;
  serviceToken?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  logger?: MinimalLogger;
  metrics?: InterServiceMetrics;
  cacheMaxSize?: number;
  cacheTtlMs?: number;
}

export interface FxClient {
  getQuote(request: FxQuoteRequest, incomingHeaders?: IncomingHeaders): Promise<FxQuoteResponse | null>;
  _cacheSize?: () => number;
}

export const DEFAULT_FX_TIMEOUT_MS = 2_000;
export const DEFAULT_FX_CACHE_MAX_SIZE = 1_000;
export const DEFAULT_FX_CACHE_TTL_MS = 5 * 60 * 1000;

export function createFxClient(options: FxClientOptions): FxClient {
  const {
    baseUrl,
    serviceToken,
    timeoutMs = DEFAULT_FX_TIMEOUT_MS,
    fetchImpl = fetch,
    logger,
    metrics = defaultInterServiceMetrics,
    cacheMaxSize = DEFAULT_FX_CACHE_MAX_SIZE,
    cacheTtlMs = DEFAULT_FX_CACHE_TTL_MS,
  } = options;

  const root = baseUrl.replace(/\/+$/, '');
  const TARGET = 'fx-service';
  const ENDPOINT = '/api/quote';

  interface CacheEntry {
    quote: FxQuoteResponse;
    timestamp: number;
  }

  // Last-good response cache: keyed by `${from}:${to}:${amount}` to prevent amount collisions.
  // Enforces a max entry capacity (LRU eviction) and a TTL to prevent unbounded memory growth.
  const lastGoodCache = new Map<string, CacheEntry>();

  function getFromCache(key: string): FxQuoteResponse | null {
    const entry = lastGoodCache.get(key);
    if (!entry) return null;

    if (Date.now() - entry.timestamp > cacheTtlMs) {
      lastGoodCache.delete(key);
      return null;
    }

    // Refresh LRU order on access
    lastGoodCache.delete(key);
    lastGoodCache.set(key, entry);
    return entry.quote;
  }

  function setInCache(key: string, quote: FxQuoteResponse): void {
    if (cacheMaxSize <= 0) return;

    if (lastGoodCache.has(key)) {
      lastGoodCache.delete(key);
    } else if (lastGoodCache.size >= cacheMaxSize) {
      // Evict oldest inserted/accessed entry
      const oldestKey = lastGoodCache.keys().next().value;
      if (oldestKey !== undefined) {
        lastGoodCache.delete(oldestKey);
      }
    }

    lastGoodCache.set(key, { quote, timestamp: Date.now() });
  }

  async function getQuote(
    quoteRequest: FxQuoteRequest,
    incomingHeaders: IncomingHeaders = {},
  ): Promise<FxQuoteResponse | null> {
    const query = new URLSearchParams({
      from: quoteRequest.from,
      to: quoteRequest.to,
      amount: quoteRequest.amount,
    });
    const url = `${root}/api/quote?${query.toString()}`;
    const cacheKey = `${quoteRequest.from}:${quoteRequest.to}:${quoteRequest.amount}`;

    const baseHeaders: Record<string, string> = {};
    if (serviceToken) {
      baseHeaders['x-service-token'] = serviceToken;
    } else {
      const authorization = incomingHeaders.authorization ?? incomingHeaders.Authorization;
      const token = Array.isArray(authorization) ? authorization[0] : authorization;
      if (token) baseHeaders.authorization = token;
    }

    const headers = propagateTracingHeaders(incomingHeaders, baseHeaders);
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
          { status: res.status, durationMs: durationSeconds * 1000, from: quoteRequest.from, to: quoteRequest.to },
          'fx-client: non-OK quote response - continuing without quote',
        );
        return null;
      }

      let rawBody: unknown;
      try {
        rawBody = await res.json();
      } catch (parseErr) {
        metrics.failures.inc({ target_service: TARGET, endpoint: ENDPOINT, status_code: 'malformed_json' });
        logger?.warn(
          { err: parseErr, from: quoteRequest.from, to: quoteRequest.to },
          'fx-client: upstream returned malformed JSON',
        );
        const cached = getFromCache(cacheKey);
        if (cached) {
          logger?.warn(
            { from: quoteRequest.from, to: quoteRequest.to },
            'fx-client: malformed JSON — serving stale cached quote fallback',
          );
          return cached;
        }
        return null;
      }

      const validated = FxQuoteResponseSchema.safeParse(rawBody);
      if (!validated.success) {
        metrics.failures.inc({ target_service: TARGET, endpoint: ENDPOINT, status_code: 'invalid_quote_schema' });
        logger?.warn(
          { errors: validated.error.errors, from: quoteRequest.from, to: quoteRequest.to },
          'fx-client: upstream returned invalid quote schema',
        );
        const cached = getFromCache(cacheKey);
        if (cached) {
          logger?.warn(
            { from: quoteRequest.from, to: quoteRequest.to },
            'fx-client: invalid quote schema — serving stale cached quote fallback',
          );
          return cached;
        }
        return null;
      }

      const body = validated.data as FxQuoteResponse;

      // Populate / refresh the last-good cache on every valid successful response.
      setInCache(cacheKey, body);

      logger?.info?.(
        { durationMs: durationSeconds * 1000, from: quoteRequest.from, to: quoteRequest.to },
        'fx-client: quote fetched',
      );
      return body;
    } catch (err) {
      const durationSeconds = (Date.now() - startedAt) / 1000;
      const isTimeout = err instanceof Error && err.name === 'AbortError';
      const statusCode = isTimeout ? 'timeout' : 'network_error';

      metrics.failures.inc({ target_service: TARGET, endpoint: ENDPOINT, status_code: statusCode });
      metrics.duration.observe({ target_service: TARGET, endpoint: ENDPOINT, status_code: statusCode }, durationSeconds);

      if (isTimeout) {
        const cached = getFromCache(cacheKey);
        if (cached) {
          // Circuit-breaker event: fast timeout fired but we have a stale entry
          // we can serve. Log it so the outage is visible without failing the call.
          logger?.warn(
            { from: quoteRequest.from, to: quoteRequest.to, durationMs: durationSeconds * 1000 },
            'fx-client: read timeout — serving stale cached quote',
          );
          return cached;
        }

        // Timeout with no cache entry: propagate as UpstreamReadTimeoutError so
        // the route handler can reply 503 + Retry-After instead of silently
        // returning null (which would hide the outage from the client).
        logger?.warn(
          { from: quoteRequest.from, to: quoteRequest.to, durationMs: durationSeconds * 1000 },
          'fx-client: read timeout — no cached quote available',
        );
        throw new UpstreamReadTimeoutError(TARGET, ENDPOINT);
      }

      logger?.warn(
        { err, from: quoteRequest.from, to: quoteRequest.to },
        'fx-client: quote request failed - continuing without quote',
      );
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  return { getQuote, _cacheSize: () => lastGoodCache.size };
}
