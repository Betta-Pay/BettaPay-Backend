import type { FastifyBaseLogger, FastifyRequest } from 'fastify';
import { propagateTracingHeaders } from '@bettapay/validation';

export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
export const MAX_REQUEST_TIMEOUT_MS = 60_000;
export const MIN_REQUEST_TIMEOUT_MS = 1;
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

export function getRequestTimeoutMs(
  request: FastifyRequest,
  defaultTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  maxTimeoutMs = MAX_REQUEST_TIMEOUT_MS,
  minTimeoutMs = MIN_REQUEST_TIMEOUT_MS,
): number {
  const header = request.headers['request-timeout'];
  if (!header) return defaultTimeoutMs;

  const raw = Array.isArray(header) ? header[0] : header;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return defaultTimeoutMs;
  return Math.max(minTimeoutMs, Math.min(parsed, maxTimeoutMs));
}

export function getDownstreamDeadlineMs(
  request: FastifyRequest,
  defaultTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  maxTimeoutMs = MAX_REQUEST_TIMEOUT_MS,
  minTimeoutMs = MIN_REQUEST_TIMEOUT_MS,
): number {
  const startTime = getRequestStartTime(request);
  const totalTimeout = getRequestTimeoutMs(request, defaultTimeoutMs, maxTimeoutMs, minTimeoutMs);
  const elapsed = Date.now() - startTime;
  const remaining = totalTimeout - elapsed;
  if (remaining <= 0) {
    return 0;
  }
  return Math.max(1, Math.floor(remaining * DOWNSTREAM_DEADLINE_RATIO));
}

export function createDownstreamAbortSignal(
  request: FastifyRequest,
  logger: FastifyBaseLogger,
  targetUrl: string,
  defaultTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  maxTimeoutMs = MAX_REQUEST_TIMEOUT_MS,
  minTimeoutMs = MIN_REQUEST_TIMEOUT_MS,
): { signal: AbortSignal; cleanup: () => void } {
  const deadlineMs = getDownstreamDeadlineMs(request, defaultTimeoutMs, maxTimeoutMs, minTimeoutMs);
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

function parseIpv4Candidate(host: string): [number, number, number, number] | null {
  let clean = host.trim().toLowerCase();
  if (clean.startsWith('[') && clean.endsWith(']')) {
    clean = clean.slice(1, -1);
  }
  const parts = clean.split('.');
  if (parts.length < 1 || parts.length > 4) return null;
  const numbers: number[] = [];
  for (const part of parts) {
    if (!part) return null;
    let n: number;
    if (/^0x[0-9a-f]+$/i.test(part)) {
      n = Number.parseInt(part, 16);
    } else if (/^0[0-7]+$/.test(part)) {
      n = Number.parseInt(part, 8);
    } else if (/^[0-9]+$/.test(part)) {
      n = Number.parseInt(part, 10);
    } else {
      return null;
    }
    if (Number.isNaN(n) || n < 0) return null;
    numbers.push(n);
  }

  const len = numbers.length;
  for (let i = 0; i < len - 1; i++) {
    if (numbers[i] > 255) return null;
  }
  const maxLast = [0xffffffff, 0xffffff, 0xffff, 0xff][len - 1];
  if (numbers[len - 1] > maxLast) return null;

  let val = 0;
  if (len === 1) {
    val = numbers[0];
  } else if (len === 2) {
    val = numbers[0] * 16777216 + numbers[1];
  } else if (len === 3) {
    val = numbers[0] * 16777216 + numbers[1] * 65536 + numbers[2];
  } else if (len === 4) {
    val = numbers[0] * 16777216 + numbers[1] * 65536 + numbers[2] * 256 + numbers[3];
  }

  const b1 = Math.floor(val / 16777216) % 256;
  const b2 = Math.floor(val / 65536) % 256;
  const b3 = Math.floor(val / 256) % 256;
  const b4 = val % 256;
  return [b1, b2, b3, b4];
}

function parseIpv6Candidate(host: string): { hexNums: number[] } | null {
  let ip = host.trim().toLowerCase();
  if (ip.startsWith('[') && ip.endsWith(']')) {
    ip = ip.slice(1, -1);
  }
  if (ip.includes('%')) {
    ip = ip.split('%')[0];
  }
  if (!ip.includes(':')) return null;
  if (!/^[0-9a-f:.]+$/i.test(ip)) return null;

  const lastColon = ip.lastIndexOf(':');
  const potentialIpv4 = ip.slice(lastColon + 1);
  if (potentialIpv4.includes('.')) {
    const parsed = parseIpv4Candidate(potentialIpv4);
    if (!parsed) return null;
    const high = (parsed[0] << 8) | parsed[1];
    const low = (parsed[2] << 8) | parsed[3];
    ip = ip.slice(0, lastColon + 1) + high.toString(16) + ':' + low.toString(16);
  }

  const doubleColonMatches = ip.match(/::/g);
  if (doubleColonMatches && doubleColonMatches.length > 1) return null;

  let blocks: string[];
  if (doubleColonMatches && doubleColonMatches.length === 1) {
    const [left, right] = ip.split('::');
    const leftBlocks = left ? left.split(':') : [];
    const rightBlocks = right ? right.split(':') : [];
    const missing = 8 - (leftBlocks.length + rightBlocks.length);
    if (missing < 1) return null;
    blocks = [...leftBlocks, ...Array(missing).fill('0'), ...rightBlocks];
  } else {
    blocks = ip.split(':');
  }

  if (blocks.length !== 8) return null;

  const hexNums: number[] = [];
  for (const b of blocks) {
    if (!/^[0-9a-f]{1,4}$/i.test(b)) return null;
    hexNums.push(Number.parseInt(b, 16));
  }
  return { hexNums };
}

function isPrivateIpv4(b1: number, b2: number, b3: number, _b4: number): boolean {
  if (b1 === 0) return true;
  if (b1 === 10) return true;
  if (b1 === 127) return true;
  if (b1 === 169 && b2 === 254) return true;
  if (b1 === 172 && b2 >= 16 && b2 <= 31) return true;
  if (b1 === 192 && b2 === 168) return true;
  if (b1 === 100 && b2 >= 64 && b2 <= 127) return true;
  if (b1 === 192 && b2 === 0 && b3 === 0) return true;
  if (b1 === 192 && b2 === 0 && b3 === 2) return true;
  if (b1 === 198 && (b2 === 18 || b2 === 19)) return true;
  if (b1 === 198 && b2 === 51 && b3 === 100) return true;
  if (b1 === 203 && b2 === 0 && b3 === 113) return true;
  if (b1 >= 224) return true;
  return false;
}

export function isPrivateOrReservedHost(hostname: string): boolean {
  if (!hostname || typeof hostname !== 'string') return false;
  let lower = hostname.trim().toLowerCase();
  if (lower.startsWith('[') && lower.endsWith(']')) {
    lower = lower.slice(1, -1);
  }
  if (lower.includes('%')) {
    lower = lower.split('%')[0];
  }
  if (lower === 'localhost' || lower.endsWith('.localhost')) return true;

  const ipv6 = parseIpv6Candidate(lower);
  if (ipv6) {
    const { hexNums } = ipv6;
    // Loopback ::1
    const isLoopback = hexNums.slice(0, 7).every((n) => n === 0) && hexNums[7] === 1;
    if (isLoopback) return true;
    // Unspecified ::
    const isUnspecified = hexNums.every((n) => n === 0);
    if (isUnspecified) return true;
    // ULA fc00::/7 (covers fc00::/8 and fd00::/8)
    if ((hexNums[0] & 0xfe00) === 0xfc00) return true;
    // Link-local fe80::/10 (fe80:: to febf::)
    if ((hexNums[0] & 0xffc0) === 0xfe80) return true;
    // IPv4-mapped ::ffff:0:0/96
    const isIpv4Mapped = hexNums.slice(0, 5).every((n) => n === 0) && hexNums[5] === 0xffff;
    if (isIpv4Mapped) {
      const b1 = hexNums[6] >> 8;
      const b2 = hexNums[6] & 0xff;
      const b3 = hexNums[7] >> 8;
      const b4 = hexNums[7] & 0xff;
      return isPrivateIpv4(b1, b2, b3, b4);
    }
    // IPv4-compatible ::/96 (deprecated)
    const isIpv4Compat = hexNums.slice(0, 6).every((n) => n === 0) && (hexNums[6] !== 0 || hexNums[7] > 1);
    if (isIpv4Compat) {
      const b1 = hexNums[6] >> 8;
      const b2 = hexNums[6] & 0xff;
      const b3 = hexNums[7] >> 8;
      const b4 = hexNums[7] & 0xff;
      return isPrivateIpv4(b1, b2, b3, b4);
    }
    return false;
  }

  const ipv4 = parseIpv4Candidate(lower);
  if (ipv4) {
    return isPrivateIpv4(ipv4[0], ipv4[1], ipv4[2], ipv4[3]);
  }

  return false;
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
  defaultTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  maxTimeoutMs = MAX_REQUEST_TIMEOUT_MS,
  minTimeoutMs = MIN_REQUEST_TIMEOUT_MS,
): Promise<Response> {
  validateUpstreamUrl(url);

  const { signal, cleanup } = createDownstreamAbortSignal(
    request,
    logger,
    url,
    defaultTimeoutMs,
    maxTimeoutMs,
    minTimeoutMs,
  );

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
