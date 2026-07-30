import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import {
  aggregateAllHealth,
  buildHealthResponse,
  checkPostgresql,
  checkUpstreamServiceHealth,
  readServiceVersion,
  UPSTREAM_HEALTH_TIMEOUT_MS,
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
}

export async function buildGatewayHealthResponse(
  options: Omit<RegisterGatewayHealthRoutesOptions, 'fastify'>,
): Promise<HealthResponse> {
  const {
    prisma,
    env,
    startTime,
    serviceVersion = readServiceVersion(import.meta.url),
    fetchImpl = fetch,
  } = options;

  const [postgresql, fxEngine, settlementEngine, indexer] = await Promise.all([
    checkPostgresql(() => prisma.$queryRaw`SELECT 1, NOW() AS "serverVersion"`),
    checkUpstreamServiceHealth(env.FX_ENGINE_URL, 'fx-engine', { fetchImpl }),
    checkUpstreamServiceHealth(env.SETTLEMENT_ENGINE_URL, 'settlement-engine', { fetchImpl }),
    checkUpstreamServiceHealth(env.INDEXER_URL, 'indexer', { fetchImpl }),
  ]);

  const base = buildHealthResponse({
    service: 'api-gateway',
    version: serviceVersion,
    startTime,
    dependencies: [postgresql],
    upstream: [fxEngine, settlementEngine, indexer],
    criticalDependencyNames: ['postgresql'],
  });

  // Include abandoned payments count in non-test environments
  if (process.env.NODE_ENV !== 'test') {
    const abandonmentMinutes = parseInt(process.env.ABANDONMENT_THRESHOLD_MINUTES ?? '1440', 10);
    const cutoff = new Date(Date.now() - abandonmentMinutes * 60 * 1000);
    try {
      const count = await prisma.payment.count({
        where: { status: 'initiated', createdAt: { lt: cutoff } },
      });
      (base as any).business = { abandonedPayments: count };
    } catch {
      (base as any).business = { abandonedPayments: -1 };
    }
  }

  return base;
}

export async function buildAggregatedHealthResponse(
  options: Omit<RegisterGatewayHealthRoutesOptions, 'fastify'>,
): Promise<AggregatedHealthResponse> {
  const gatewayHealth = await buildGatewayHealthResponse(options);

  return aggregateAllHealth({
    gatewayHealth,
    targets: [
      { name: 'fx-engine', baseUrl: options.env.FX_ENGINE_URL },
      { name: 'settlement-engine', baseUrl: options.env.SETTLEMENT_ENGINE_URL },
      { name: 'indexer', baseUrl: options.env.INDEXER_URL },
    ],
    timeoutMs: UPSTREAM_HEALTH_TIMEOUT_MS,
    fetchImpl: options.fetchImpl,
  });
}

export function registerGatewayHealthRoutes(options: RegisterGatewayHealthRoutesOptions): void {
  const { fastify } = options;

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
