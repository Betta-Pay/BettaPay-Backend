import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import {
  aggregateAllHealth,
  buildHealthResponse,
  checkPostgresql,
  checkRedisPing,
  checkUpstreamServiceHealth,
  readServiceVersion,
  UPSTREAM_HEALTH_TIMEOUT_MS,
  type UpstreamHealthResult,
} from '@bettapay/validation';
import type { AggregatedHealthResponse, HealthResponse } from '@bettapay/shared-types';

export interface GatewayHealthEnv {
  FX_ENGINE_URL: string;
  SETTLEMENT_ENGINE_URL: string;
  INDEXER_URL: string;
}

export interface RegisterGatewayHealthRoutesOptions {
  fastify: FastifyInstance;
  prisma: PrismaClient;
  env: GatewayHealthEnv;
  startTime: number;
  serviceVersion?: string;
  fetchImpl?: typeof fetch;
  redisPing?: () => Promise<string>;
}

const DEFAULT_ABANDONMENT_THRESHOLD_MINUTES = 1440;
const ABANDONED_COUNT_CACHE_TTL_MS = 30_000;
const abandonedCountCache = new WeakMap<object, { count: number; expiresAt: number }>();

export function parseAbandonmentThresholdMinutes(raw: string | undefined): number {
  const parsed = parseInt(raw ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_ABANDONMENT_THRESHOLD_MINUTES;
}

type GatewayHealthOptions = Omit<RegisterGatewayHealthRoutesOptions, 'fastify'>;

interface UpstreamProbes {
  fxEngine: UpstreamHealthResult;
  settlementEngine: UpstreamHealthResult;
  indexer: UpstreamHealthResult;
}

/** Probes each upstream service exactly once. */
async function probeUpstreams(options: GatewayHealthOptions): Promise<UpstreamProbes> {
  const { env, fetchImpl = fetch } = options;
  const [fxEngine, settlementEngine, indexer] = await Promise.all([
    checkUpstreamServiceHealth(env.FX_ENGINE_URL, 'fx-engine', { fetchImpl }),
    checkUpstreamServiceHealth(env.SETTLEMENT_ENGINE_URL, 'settlement-engine', { fetchImpl }),
    checkUpstreamServiceHealth(env.INDEXER_URL, 'indexer', { fetchImpl }),
  ]);
  return { fxEngine, settlementEngine, indexer };
}

export async function buildGatewayHealthResponse(
  options: GatewayHealthOptions,
  probes?: UpstreamProbes,
): Promise<HealthResponse> {
  const {
    prisma,
    startTime,
    serviceVersion = readServiceVersion(import.meta.url),
    redisPing,
  } = options;

  const [postgresql, { fxEngine, settlementEngine, indexer }, redis] = await Promise.all([
    checkPostgresql(() => prisma.$queryRaw`SELECT version() AS "serverVersion"`),
    probes ?? probeUpstreams(options),
    redisPing ? checkRedisPing(redisPing) : Promise.resolve(null),
  ]);

  const base = buildHealthResponse({
    service: 'api-gateway',
    version: serviceVersion,
    startTime,
    dependencies: redis ? [postgresql, redis] : [postgresql],
    upstream: [fxEngine, settlementEngine, indexer],
    // Only postgresql is truly critical — a dead downstream should degrade
    // the gateway (200 + degraded) rather than 503 the entire payment path.
    // Upstream services are probed and reported in the `upstream` block but
    // gate `degraded` status instead of `unhealthy`/503.
    criticalDependencyNames: ['postgresql'],
  });

  // Include abandoned payments count in non-test environments
  if (process.env.NODE_ENV !== 'test') {
    const abandonmentMinutes = parseAbandonmentThresholdMinutes(
      process.env.ABANDONMENT_THRESHOLD_MINUTES,
    );
    const cutoff = new Date(Date.now() - abandonmentMinutes * 60 * 1000);
    try {
      const cached = abandonedCountCache.get(prisma);
      let count: number;
      if (cached && cached.expiresAt > Date.now()) {
        count = cached.count;
      } else {
        count = await prisma.payment.count({
          where: { status: 'initiated', createdAt: { lt: cutoff } },
        });
        abandonedCountCache.set(prisma, {
          count,
          expiresAt: Date.now() + ABANDONED_COUNT_CACHE_TTL_MS,
        });
      }
      (base as any).business = { abandonedPayments: count };
    } catch {
      (base as any).business = { abandonedPayments: -1 };
    }
  }

  return base;
}

export async function buildAggregatedHealthResponse(
  options: GatewayHealthOptions,
): Promise<AggregatedHealthResponse> {
  // Probe each upstream once and reuse the result for both the gateway's own
  // `upstream` block and the aggregated `services` block.
  const probes = await probeUpstreams(options);
  const gatewayHealth = await buildGatewayHealthResponse(options, probes);

  return aggregateAllHealth({
    gatewayHealth,
    targets: [
      { name: 'fx-engine', baseUrl: options.env.FX_ENGINE_URL },
      { name: 'settlement-engine', baseUrl: options.env.SETTLEMENT_ENGINE_URL },
      { name: 'indexer', baseUrl: options.env.INDEXER_URL },
    ],
    timeoutMs: UPSTREAM_HEALTH_TIMEOUT_MS,
    fetchImpl: options.fetchImpl,
    probeResults: {
      'fx-engine': probes.fxEngine,
      'settlement-engine': probes.settlementEngine,
      indexer: probes.indexer,
    },
  });
}

export function registerGatewayHealthRoutes(options: RegisterGatewayHealthRoutesOptions): void {
  const { fastify } = options;

  // Liveness: always 200 when the process is up — load balancers use this
  // to decide whether to keep routing traffic to this instance.
  fastify.get('/api/health/live', { config: { rateLimit: false } }, async (_request, reply) => {
    return reply.code(200).send({ status: 'alive', service: 'api-gateway' });
  });

  // Readiness: returns 503 when critical dependents (DB, upstream engines) are
  // down so the load balancer stops sending traffic to a degraded gateway.
  fastify.get('/api/health', { config: { rateLimit: false } }, async (_request, reply) => {
    const health = await buildGatewayHealthResponse(options);
    const statusCode = health.status === 'unhealthy' ? 503 : 200;
    return reply.code(statusCode).send(health);
  });

  fastify.get('/api/health/all', { config: { rateLimit: false } }, async (_request, reply) => {
    const health = await buildAggregatedHealthResponse(options);
    const statusCode = health.status === 'unhealthy' ? 503 : 200;
    return reply.code(statusCode).send(health);
  });
}
