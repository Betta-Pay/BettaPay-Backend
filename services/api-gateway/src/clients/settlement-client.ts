import { propagateTracingHeaders } from '@bettapay/validation';
import { defaultInterServiceMetrics, type InterServiceMetrics } from './inter-service-metrics.js';

type IncomingHeaders = Record<string, string | string[] | undefined>;

interface MinimalLogger {
  warn: (obj: unknown, msg?: string) => void;
}

export interface SettlementClientOptions {
  baseUrl: string;
  serviceToken?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  logger?: MinimalLogger;
  metrics?: InterServiceMetrics;
}

export interface SettlementClientResult {
  status: number;
  body: unknown;
  contentType: string;
}

export interface SettlementClient {
  createSettlement(
    payload: unknown,
    incomingHeaders?: IncomingHeaders
  ): Promise<SettlementClientResult>;
}

export const DEFAULT_SETTLEMENT_TIMEOUT_MS = 30_000;

export class SettlementEngineUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SettlementEngineUnavailableError';
  }
}

export function createSettlementClient(options: SettlementClientOptions): SettlementClient {
  const {
    baseUrl,
    serviceToken,
    timeoutMs = DEFAULT_SETTLEMENT_TIMEOUT_MS,
    fetchImpl = fetch,
    logger,
    metrics = defaultInterServiceMetrics,
  } = options;

  const root = baseUrl.replace(/\/+$/, '');
  const authHeaders: Record<string, string> = serviceToken
    ? { 'x-service-token': serviceToken }
    : {};

  const TARGET = 'settlement-engine';
  const ENDPOINT = '/api/settlements';

  async function createSettlement(
    payload: unknown,
    incomingHeaders: IncomingHeaders = {}
  ): Promise<SettlementClientResult> {
    const url = `${root}/api/settlements`;
    const headers = propagateTracingHeaders(incomingHeaders, {
      ...authHeaders,
      'content-type': 'application/json',
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const startedAt = Date.now();

    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      const durationSeconds = (Date.now() - startedAt) / 1000;
      const statusCode = String(response.status);

      metrics.duration.observe({ target_service: TARGET, endpoint: ENDPOINT, status_code: statusCode }, durationSeconds);

      if (!response.ok) {
        metrics.failures.inc({ target_service: TARGET, endpoint: ENDPOINT, status_code: statusCode });
      }

      const contentType = response.headers.get('content-type') ?? '';
      let body: unknown;
      let effectiveContentType = contentType || 'application/json';

      if (contentType.includes('application/json')) {
        try {
          body = typeof response.json === 'function' ? await response.json() : JSON.parse(await response.text());
        } catch {
          let rawText = '';
          try {
            rawText = typeof response.text === 'function' ? await response.text() : '';
          } catch {
            rawText = '';
          }
          body = {
            error: {
              code: 'UPSTREAM_ERROR',
              message: rawText || `Upstream returned status ${response.status}`,
            },
          };
          effectiveContentType = 'application/json';
        }
      } else {
        let rawText = '';
        try {
          rawText = typeof response.text === 'function' ? await response.text() : '';
        } catch {
          rawText = '';
        }
        if (!response.ok) {
          body = {
            error: {
              code: 'UPSTREAM_ERROR',
              message: rawText || `Upstream returned status ${response.status}`,
            },
          };
          effectiveContentType = 'application/json';
        } else {
          body = rawText;
        }
      }

      return { status: response.status, body, contentType: effectiveContentType };
    } catch (err) {
      const durationSeconds = (Date.now() - startedAt) / 1000;
      const isTimeout = err instanceof Error && err.name === 'AbortError';
      const statusCode = isTimeout ? 'timeout' : 'network_error';

      metrics.failures.inc({ target_service: TARGET, endpoint: ENDPOINT, status_code: statusCode });
      metrics.duration.observe({ target_service: TARGET, endpoint: ENDPOINT, status_code: statusCode }, durationSeconds);

      logger?.warn({ err }, 'settlement-client: settlement-engine request failed');
      throw new SettlementEngineUnavailableError(
        err instanceof Error ? err.message : 'settlement-engine unavailable'
      );
    } finally {
      clearTimeout(timer);
    }
  }

  return { createSettlement };
}
