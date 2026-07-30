import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import type { AggregatedHealthResponse, DependencyHealth, HealthResponse, HealthStatus } from './schemas.js';

export const HEALTH_CHECK_TIMEOUT_MS = 3_000;
export const UPSTREAM_HEALTH_TIMEOUT_MS = 5_000;
export const POSTGRESQL_DEGRADED_LATENCY_MS = 1000;

export function readServiceVersion(importMetaUrl: string): string {
  const serviceDir = dirname(fileURLToPath(importMetaUrl));
  const pkgPath = join(serviceDir, '../package.json');
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export function computeOverallStatus(
  dependencies: DependencyHealth[],
  options?: { criticalNames?: string[] },
): HealthStatus {
  if (dependencies.length === 0) {
    return 'healthy';
  }

  const critical = new Set(options?.criticalNames ?? dependencies.map((dep) => dep.name));
  const criticalDeps = dependencies.filter((dep) => critical.has(dep.name));
  const hasCriticalFailure = criticalDeps.some((dep) => dep.status === 'disconnected');
  const hasAnyFailure = dependencies.some((dep) => dep.status === 'disconnected');

  if (hasCriticalFailure) return 'unhealthy';
  if (hasAnyFailure) return 'degraded';
  return 'healthy';
}

export async function withLatency<T>(
  fn: () => Promise<T>,
  timeoutMs: number,
): Promise<{ ok: true; latencyMs: number; value: T } | { ok: false; latencyMs: number; error: unknown }> {
  const start = performance.now();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  try {
    const value = await Promise.race([
      fn(),
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error('Health check timed out')), timeoutMs);
      }),
    ]);
    return { ok: true, latencyMs: Math.round(performance.now() - start), value };
  } catch (error) {
    return { ok: false, latencyMs: Math.round(performance.now() - start), error };
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

function extractPostgresqlServerVersion(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = Array.isArray(raw) ? raw[0] : raw;
  if (!row || typeof row !== 'object') return null;

  const versionValue = (row as Record<string, unknown>)['serverVersion'];
  if (versionValue instanceof Date) {
    return versionValue.toISOString();
  }
  if (typeof versionValue === 'string') {
    return versionValue;
  }

  return null;
}

export async function checkPostgresql(
  queryFn: () => Promise<unknown>,
  timeoutMs = HEALTH_CHECK_TIMEOUT_MS,
): Promise<DependencyHealth & { healthy: boolean; serverVersion: string | null }> {
  const result = await withLatency(queryFn, timeoutMs);
  const serverVersion = result.ok ? extractPostgresqlServerVersion(result.value) : null;

  if (result.ok) {
    return {
      name: 'postgresql',
      status: 'connected',
      latencyMs: result.latencyMs,
      healthy: true,
      serverVersion,
      details: serverVersion ? { serverVersion } : undefined,
    };
  }

  return {
    name: 'postgresql',
    status: 'disconnected',
    latencyMs: result.latencyMs,
    healthy: false,
    serverVersion: null,
    details: {
      error: result.error instanceof Error ? result.error.message : String(result.error),
    },
  };
}

export async function checkRedisPing(
  pingFn: () => Promise<string>,
  timeoutMs = HEALTH_CHECK_TIMEOUT_MS,
): Promise<DependencyHealth> {
  const result = await withLatency(pingFn, timeoutMs);
  if (result.ok && result.value === 'PONG') {
    return { name: 'redis', status: 'connected', latencyMs: result.latencyMs };
  }
  return { name: 'redis', status: 'disconnected', latencyMs: result.latencyMs };
}

export const BULLMQ_WAITING_DEGRADED_THRESHOLD = 1000;

export async function checkBullMQ(
  getJobCounts: () => Promise<Record<string, number>>,
  queueName: string,
  timeoutMs = HEALTH_CHECK_TIMEOUT_MS,
  getIsPaused?: () => Promise<boolean>,
): Promise<DependencyHealth> {
  const result = await withLatency(
    async () => ({
      counts: await getJobCounts(),
      isPaused: getIsPaused ? await getIsPaused() : false,
    }),
    timeoutMs,
  );

  if (!result.ok) {
    return { name: queueName, status: 'disconnected', latencyMs: result.latencyMs };
  }

  const { counts, isPaused } = result.value;
  const details = {
    queueName,
    isPaused,
    waiting: counts.waiting ?? 0,
    active: counts.active ?? 0,
    failed: counts.failed ?? 0,
    delayed: counts.delayed ?? 0,
  };

  // A paused queue processes no jobs, so treat it as down regardless of job counts.
  if (isPaused) {
    return { name: queueName, status: 'disconnected', latencyMs: result.latencyMs, details };
  }

  return { name: queueName, status: 'connected', latencyMs: result.latencyMs, details };
}

export async function checkHttpEndpoint(
  url: string,
  options: {
    name: string;
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
    method?: 'GET' | 'HEAD';
  },
): Promise<DependencyHealth> {
  const { name, timeoutMs = HEALTH_CHECK_TIMEOUT_MS, fetchImpl = fetch, method = 'GET' } = options;
  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(url, { method, signal: controller.signal });
    const latencyMs = Date.now() - start;
    if (!response.ok) {
      return { name, status: 'disconnected', latencyMs, details: { httpStatus: response.status } };
    }
    return { name, status: 'connected', latencyMs };
  } catch (error) {
    return {
      name,
      status: 'disconnected',
      latencyMs: Date.now() - start,
      details: { error: error instanceof Error ? error.message : String(error) },
    };
  } finally {
    clearTimeout(timer);
  }
}

export interface UpstreamHealthResult extends DependencyHealth {
  body?: HealthResponse;
}

export async function checkUpstreamServiceHealth(
  baseUrl: string,
  serviceName: string,
  options: {
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<UpstreamHealthResult> {
  const { timeoutMs = UPSTREAM_HEALTH_TIMEOUT_MS, fetchImpl = fetch } = options;
  const url = `${baseUrl.replace(/\/+$/, '')}/api/health`;
  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    const latencyMs = Date.now() - start;

    if (!response.ok) {
      return {
        name: serviceName,
        status: 'disconnected',
        latencyMs,
        details: { httpStatus: response.status },
      };
    }

    const body = (await response.json()) as HealthResponse;
    return {
      name: serviceName,
      status: body.status === 'unhealthy' ? 'disconnected' : 'connected',
      latencyMs,
      details: {
        status: body.status,
        version: body.version,
        service: body.service,
      },
      body,
    };
  } catch (error) {
    return {
      name: serviceName,
      status: 'disconnected',
      latencyMs: Date.now() - start,
      details: { error: error instanceof Error ? error.message : String(error) },
    };
  } finally {
    clearTimeout(timer);
  }
}

export function buildHealthResponse(params: {
  service: string;
  version: string;
  startTime: number;
  dependencies: DependencyHealth[];
  upstream?: DependencyHealth[];
  criticalDependencyNames?: string[];
}): HealthResponse {
  const combined = [...params.dependencies, ...(params.upstream ?? [])];
  let status = computeOverallStatus(combined, {
    criticalNames: params.criticalDependencyNames ?? params.dependencies.map((dep) => dep.name),
  });

  const postgresLatencyExceeded = combined.some((dep) =>
    dep.name === 'postgresql' &&
    dep.status === 'connected' &&
    typeof dep.latencyMs === 'number' &&
    dep.latencyMs > POSTGRESQL_DEGRADED_LATENCY_MS,
  );

  if (status === 'healthy' && postgresLatencyExceeded) {
    status = 'degraded';
  }

  return {
    status,
    service: params.service,
    version: params.version,
    uptime: Math.floor((Date.now() - params.startTime) / 1000),
    lastDependencyCheck: new Date().toISOString(),
    dependencies: params.dependencies,
    ...(params.upstream?.length ? { upstream: params.upstream } : {}),
  };
}

export interface ServiceHealthTarget {
  name: string;
  baseUrl: string;
}

export interface AggregateHealthOptions {
  gatewayHealth: HealthResponse;
  targets: ServiceHealthTarget[];
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export async function aggregateAllHealth(options: AggregateHealthOptions): Promise<AggregatedHealthResponse> {
  const { gatewayHealth, targets, timeoutMs = UPSTREAM_HEALTH_TIMEOUT_MS, fetchImpl = fetch } = options;
  const checkedAt = new Date().toISOString();

  const downstreamResults = await Promise.allSettled(
    targets.map(async (target) => {
      const result = await checkUpstreamServiceHealth(target.baseUrl, target.name, {
        timeoutMs,
        fetchImpl,
      });
      return { target, result };
    }),
  );

  const services: AggregatedHealthResponse['services'] = {
    'api-gateway': gatewayHealth,
  };

  const serviceStatuses: HealthStatus[] = [gatewayHealth.status];

  for (let i = 0; i < downstreamResults.length; i++) {
    const settled = downstreamResults[i];
    const target = targets[i];

    if (settled.status === 'fulfilled') {
      const { result } = settled.value;
      if (result.body) {
        services[target.name] = result.body;
        serviceStatuses.push(result.body.status);
      } else {
        services[target.name] = {
          status: 'unhealthy',
          error: result.details?.error ? String(result.details.error) : 'Service unreachable',
        };
        serviceStatuses.push('unhealthy');
      }
    } else {
      services[target.name] = {
        status: 'unhealthy',
        error: settled.reason instanceof Error ? settled.reason.message : 'Health check failed',
      };
      serviceStatuses.push('unhealthy');
    }
  }

  let status: HealthStatus = 'healthy';
  if (serviceStatuses.some((s) => s === 'unhealthy')) {
    status = 'unhealthy';
  } else if (serviceStatuses.some((s) => s === 'degraded')) {
    status = 'degraded';
  }

  return {
    status,
    service: 'api-gateway',
    version: gatewayHealth.version,
    uptime: gatewayHealth.uptime,
    lastDependencyCheck: checkedAt,
    dependencies: gatewayHealth.dependencies,
    upstream: gatewayHealth.upstream,
    services,
  };
}

async function checkStellarRpc(
  getLatestLedger: () => Promise<{ sequence: number }>,
): Promise<DependencyHealth> {
  const result = await withLatency(getLatestLedger, HEALTH_CHECK_TIMEOUT_MS);
  if (result.ok) {
    return {
      name: 'stellar-rpc',
      status: 'connected',
      latencyMs: result.latencyMs,
      details: { reachable: true, latestLedgerSequence: result.value.sequence },
    };
  }
  return {
    name: 'stellar-rpc',
    status: 'disconnected',
    latencyMs: result.latencyMs,
    details: { reachable: false },
  };
}

export async function buildFxEngineHealthResponse(options: {
  pingRedis: () => Promise<string>;
  ratesApiUrl: string;
  startTime: number;
  service: string;
  version: string;
  fetchImpl?: typeof fetch;
}): Promise<HealthResponse> {
  const { pingRedis, ratesApiUrl, startTime, service, version, fetchImpl = fetch } = options;

  const [redisDep, ratesApi] = await Promise.all([
    checkRedisPing(pingRedis),
    checkHttpEndpoint(ratesApiUrl, {
      name: 'rates-api',
      fetchImpl,
      method: 'GET',
    }),
  ]);

  return buildHealthResponse({
    service,
    version,
    startTime,
    dependencies: [redisDep],
    upstream: [ratesApi],
    criticalDependencyNames: ['redis'],
  });
}

export async function buildSettlementEngineHealthResponse(options: {
  queryDatabase: () => Promise<unknown>;
  pingRedis: () => Promise<string>;
  getQueueJobCounts: () => Promise<Record<string, number>>;
  getQueueIsPaused?: () => Promise<boolean>;
  startTime: number;
  service: string;
  version: string;
}): Promise<HealthResponse> {
  const { queryDatabase, pingRedis, getQueueJobCounts, getQueueIsPaused, startTime, service, version } = options;

  const [postgresql, redisDep, bullmq] = await Promise.all([
    checkPostgresql(queryDatabase),
    checkRedisPing(pingRedis),
    checkBullMQ(getQueueJobCounts, 'bullmq-settlement', HEALTH_CHECK_TIMEOUT_MS, getQueueIsPaused),
  ]);

  const health = buildHealthResponse({
    service,
    version,
    startTime,
    dependencies: [postgresql, redisDep, bullmq],
    criticalDependencyNames: ['postgresql', 'redis', 'bullmq-settlement'],
  });

  const waiting = bullmq.details?.waiting;
  if (typeof waiting === 'number' && waiting > BULLMQ_WAITING_DEGRADED_THRESHOLD && health.status === 'healthy') {
    health.status = 'degraded';
  }

  return health;
}

export async function buildIndexerHealthResponse(options: {
  queryDatabase: () => Promise<unknown>;
  pingRedis: () => Promise<string>;
  getQueueJobCounts: () => Promise<Record<string, number>>;
  getQueueIsPaused?: () => Promise<boolean>;
  getLatestLedger: () => Promise<{ sequence: number }>;
  latestLedgerCursor?: number;
  latestLedgerSequence?: number;
  lagWarnThreshold: number;
  startTime: number;
  service: string;
  version: string;
}): Promise<HealthResponse> {
  const {
    queryDatabase,
    pingRedis,
    getQueueJobCounts,
    getQueueIsPaused,
    getLatestLedger,
    latestLedgerCursor,
    latestLedgerSequence,
    lagWarnThreshold,
    startTime,
    service,
    version,
  } = options;

  const [postgresql, redisDep, bullmq, stellarRpc] = await Promise.all([
    checkPostgresql(queryDatabase),
    checkRedisPing(pingRedis),
    checkBullMQ(getQueueJobCounts, 'bullmq-webhooks', HEALTH_CHECK_TIMEOUT_MS, getQueueIsPaused),
    checkStellarRpc(getLatestLedger),
  ]);

  const lag =
    latestLedgerSequence !== undefined && latestLedgerCursor !== undefined
      ? latestLedgerSequence - latestLedgerCursor
      : undefined;

  const health = buildHealthResponse({
    service,
    version,
    startTime,
    dependencies: [postgresql, redisDep, bullmq, stellarRpc],
    criticalDependencyNames: ['postgresql', 'redis', 'bullmq-webhooks', 'stellar-rpc'],
  });

  if (lag !== undefined) {
    health.dependencies = health.dependencies.map((dep) =>
      dep.name === 'stellar-rpc'
        ? {
            ...dep,
            details: {
              ...(dep.details ?? {}),
              latestLedgerCursor,
              latestLedgerSequence,
              lag,
              lagWarnThreshold,
            },
          }
        : dep,
    );

    if (lag > lagWarnThreshold && health.status === 'healthy') {
      health.status = 'degraded';
    }
  }

  const waiting = bullmq.details?.waiting;
  if (typeof waiting === 'number' && waiting > BULLMQ_WAITING_DEGRADED_THRESHOLD && health.status === 'healthy') {
    health.status = 'degraded';
  }

  return health;
}
