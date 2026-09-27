import type { FastifyBaseLogger, FastifyRequest } from 'fastify';
import { propagateTracingHeaders } from '@bettapay/validation';

export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
export const DOWNSTREAM_DEADLINE_RATIO = 0.8;

export class UpstreamTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UpstreamTimeoutError';
  }
}

/**
 * Thrown by read-path clients (fx-client, indexer-client) when a fast
 * READ_TIMEOUT_MS fires and no cached response is available to fall back on.
 * Callers should respond 503 Service Unavailable with a Retry-After header
 * rather than 504 Gateway Timeout, since the upstream may still be alive and
 * the client can safely retry.
 */
export class UpstreamReadTimeoutError extends Error {
  /** Target service name for logging / error responses. */
  readonly service: string;
  /** Endpoint that timed out. */
  readonly endpoint: string;

  constructor(service: string, endpoint: string) {
    super(`Read timeout: ${service}${endpoint} did not respond within the read deadline`);
    this.name = 'UpstreamReadTimeoutError';
    this.service = service;
    this.endpoint = endpoint;
  }
}

export function getRequestStartTime(request: FastifyRequest): number {
  return (request as FastifyRequest & { __startTime?: number }).__startTime ?? Date.now();
}

export function getRequestTimeoutMs(request: FastifyRequest, defaultTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): number {
  const header = request.headers['request-timeout'];
  if (!header) return defaultTimeoutMs;

  const raw = Array.isArray(header) ? header[0] : header;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return defaultTimeoutMs;
  return parsed;
}

export function getDownstreamDeadlineMs(
  request: FastifyRequest,
  defaultTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS
): number {
  const startTime = getRequestStartTime(request);
  const totalTimeout = getRequestTimeoutMs(request, defaultTimeoutMs);
  const elapsed = Date.now() - startTime;
  const remaining = Math.max(0, totalTimeout - elapsed);
  return Math.floor(remaining * DOWNSTREAM_DEADLINE_RATIO);
}

export function createDownstreamAbortSignal(
  request: FastifyRequest,
  logger: FastifyBaseLogger,
  targetUrl: string,
  defaultTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS
): { signal: AbortSignal; cleanup: () => void } {
  const deadlineMs = getDownstreamDeadlineMs(request, defaultTimeoutMs);
  const controller = new AbortController();

  if (deadlineMs <= 0) {
    logger.warn({ targetUrl, deadlineMs }, 'Downstream call aborted due to timeout');
    controller.abort();
    return { signal: controller.signal, cleanup: () => undefined };
  }

  const timer = setTimeout(() => {
    logger.warn({ targetUrl, deadlineMs }, 'Downstream call aborted due to timeout');
    controller.abort();
  }, deadlineMs);

  return {
    signal: controller.signal,
    cleanup: () => clearTimeout(timer),
  };
}

const PRIVATE_IP_PATTERNS = [
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^169\.254\./,
  /^0\./,
  /^::1$/,
  /^fc00:/i,
  /^fe80:/i,
];

export function isPrivateOrReservedHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  if (lower === 'localhost') return true;
  return PRIVATE_IP_PATTERNS.some((p) => p.test(lower));
}

export class SsrfRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SsrfRejectedError';
  }
}

export function validateUpstreamUrl(urlString: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(urlString);
  } catch {
    throw new SsrfRejectedError(`Invalid upstream URL: ${urlString}`);
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new SsrfRejectedError(`Rejected upstream URL with scheme ${parsed.protocol}`);
  }

  if (isPrivateOrReservedHost(parsed.hostname)) {
    throw new SsrfRejectedError(`Rejected upstream URL targeting private/reserved host: ${parsed.hostname}`);
  }

  return parsed;
}

export async function fetchUpstream(
  request: FastifyRequest,
  url: string,
  init: RequestInit,
  logger: FastifyBaseLogger,
  defaultTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS
): Promise<Response> {
  validateUpstreamUrl(url);

  const { signal, cleanup } = createDownstreamAbortSignal(request, logger, url, defaultTimeoutMs);

  // Propagate tracing headers (x-request-id / x-trace-id) to the downstream service (#118).
  const headers = propagateTracingHeaders(
    request.headers,
    (init.headers as Record<string, string>) ?? {},
  );

  try {
    return await fetch(url, { ...init, headers, signal });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new UpstreamTimeoutError(`Upstream request to ${url} timed out`);
    }
    throw err;
  } finally {
    cleanup();
  }
}
