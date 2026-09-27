import crypto from 'crypto';

/**
 * Capability-aware downstream readiness checks (Issue #556).
 *
 * A service is only considered "ready" when BOTH:
 *  1. its `/api/health` probe succeeds (liveness), and
 *  2. a real, work-bearing endpoint (the capability probe) returns a valid
 *     response — catching schema/DB drift that a bare ping would miss.
 *
 * Each service yields per-probe detail so operators can see exactly which
 * probe failed and why.
 */

export interface DownstreamService {
  name: string;
  healthUrl: string;
  capabilityUrl: string;
  /** Sent as x-service-token when the capability endpoint requires it (#117). */
  serviceToken?: string;
  /** Optional body-shape validator proving the capability response is the expected contract. */
  validateBody?: (body: unknown) => boolean;
}

export interface ProbeResult {
  endpoint: string;
  statusCode: number | null;
  ok: boolean;
  durationMs: number;
  error?: string;
}

export interface ServiceReadiness {
  name: string;
  ready: boolean;
  checkedAt: string;
  ping: ProbeResult;
  capability: ProbeResult;
}

export interface DownstreamReadinessOptions {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  logger?: {
    info?: (obj: unknown, msg?: string) => void;
    warn: (obj: unknown, msg?: string) => void;
  };
}

export const DEFAULT_READINESS_TIMEOUT_MS = 5_000;

async function probe(
  endpoint: string,
  headers: Record<string, string>,
  timeoutMs: number,
  fetchImpl: typeof fetch,
  validateBody?: (body: unknown) => boolean,
): Promise<ProbeResult> {
  const startTime = Date.now();

  try {
    const response = await fetchImpl(endpoint, {
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const durationMs = Date.now() - startTime;

    if (!response.ok) {
      return {
        endpoint,
        statusCode: response.status,
        ok: false,
        durationMs,
        error: `HTTP ${response.status}`,
      };
    }

    if (validateBody) {
      let body: unknown;
      try {
        body = await response.json();
      } catch (err) {
        return {
          endpoint,
          statusCode: response.status,
          ok: false,
          durationMs,
          error: 'Capability response body is not valid JSON',
        };
      }
      if (!validateBody(body)) {
        return {
          endpoint,
          statusCode: response.status,
          ok: false,
          durationMs,
          error: 'Capability response body does not match the expected contract',
        };
      }
    }

    return { endpoint, statusCode: response.status, ok: true, durationMs };
  } catch (err) {
    const durationMs = Date.now() - startTime;
    return {
      endpoint,
      statusCode: null,
      ok: false,
      durationMs,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function checkServiceReadiness(
  svc: DownstreamService,
  options: DownstreamReadinessOptions = {},
): Promise<ServiceReadiness> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? fetch;

  const headers: Record<string, string> = { 'x-trace-id': crypto.randomUUID() };
  if (svc.serviceToken) {
    headers['x-service-token'] = svc.serviceToken;
  }

  const [ping, capability] = await Promise.all([
    probe(svc.healthUrl, headers, timeoutMs, fetchImpl),
    probe(svc.capabilityUrl, headers, timeoutMs, fetchImpl, svc.validateBody),
  ]);

  return {
    name: svc.name,
    ready: ping.ok && capability.ok,
    checkedAt: new Date().toISOString(),
    ping,
    capability,
  };
}

/**
 * Run readiness checks for every downstream service and log per-service detail.
 * Never throws — a downstream that is still warming up must not prevent the
 * gateway from starting.
 */
export async function checkDownstreamReadiness(
  services: DownstreamService[],
  options: DownstreamReadinessOptions = {},
): Promise<ServiceReadiness[]> {
  const settled = await Promise.allSettled(
    services.map((svc) => checkServiceReadiness(svc, options)),
  );

  const results = settled.map<ServiceReadiness>((result, index) => {
    if (result.status === 'fulfilled') {
      return result.value;
    }
    const svc = services[index];
    return {
      name: svc.name,
      ready: false,
      checkedAt: new Date().toISOString(),
      ping: {
        endpoint: svc.healthUrl,
        statusCode: null,
        ok: false,
        durationMs: 0,
        error: result.reason instanceof Error ? result.reason.message : String(result.reason),
      },
      capability: {
        endpoint: svc.capabilityUrl,
        statusCode: null,
        ok: false,
        durationMs: 0,
        error: 'Readiness check itself failed',
      },
    };
  });

  for (const result of results) {
    if (result.ready) {
      options.logger?.info?.(result, 'Warmup completed');
    } else {
      options.logger?.warn?.(result, 'Warmup failed — downstream may not be ready');
    }
  }

  return results;
}