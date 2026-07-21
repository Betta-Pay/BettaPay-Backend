import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import type { PrismaClient } from '@prisma/client';
import {
  aggregateAllHealth,
  buildHealthResponse,
  checkPostgresql,
  checkUpstreamServiceHealth,
} from '../../../shared/validation/health.js';
import type { HealthResponse } from '../../../shared/validation/schemas.js';

function mockHealth(service: string, status: HealthResponse['status']): HealthResponse {
  return {
    status,
    service,
    version: '0.1.0',
    uptime: 42,
    lastDependencyCheck: new Date().toISOString(),
    dependencies: [{
      name: 'redis',
      status: status === 'unhealthy' ? 'disconnected' : 'connected',
      latencyMs: 2,
    }],
  };
}

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as unknown as Response;
}

async function buildGatewayHealthResponse(options: {
  prisma: PrismaClient;
  env: {
    FX_ENGINE_URL: string;
    SETTLEMENT_ENGINE_URL: string;
    INDEXER_URL: string;
  };
  startTime: number;
  serviceVersion: string;
  fetchImpl?: typeof fetch;
}): Promise<HealthResponse> {
  const { prisma, env, startTime, serviceVersion, fetchImpl = fetch } = options;

  const [postgresql, fxEngine, settlementEngine, indexer] = await Promise.all([
    checkPostgresql(() => prisma.$queryRaw`SELECT 1`),
    checkUpstreamServiceHealth(env.FX_ENGINE_URL, 'fx-engine', { fetchImpl }),
    checkUpstreamServiceHealth(env.SETTLEMENT_ENGINE_URL, 'settlement-engine', { fetchImpl }),
    checkUpstreamServiceHealth(env.INDEXER_URL, 'indexer', { fetchImpl }),
  ]);

  return buildHealthResponse({
    service: 'api-gateway',
    version: serviceVersion,
    startTime,
    dependencies: [postgresql],
    upstream: [fxEngine, settlementEngine, indexer],
    criticalDependencyNames: ['postgresql'],
  });
}

async function buildAggregatedHealthResponse(options: {
  prisma: PrismaClient;
  env: {
    FX_ENGINE_URL: string;
    SETTLEMENT_ENGINE_URL: string;
    INDEXER_URL: string;
  };
  startTime: number;
  serviceVersion: string;
  fetchImpl?: typeof fetch;
}) {
  const gatewayHealth = await buildGatewayHealthResponse(options);

  return aggregateAllHealth({
    gatewayHealth,
    targets: [
      { name: 'fx-engine', baseUrl: options.env.FX_ENGINE_URL },
      { name: 'settlement-engine', baseUrl: options.env.SETTLEMENT_ENGINE_URL },
      { name: 'indexer', baseUrl: options.env.INDEXER_URL },
    ],
    fetchImpl: options.fetchImpl,
  });
}

function registerGatewayHealthRoutes(options: {
  fastify: ReturnType<typeof Fastify>;
  prisma: PrismaClient;
  env: {
    FX_ENGINE_URL: string;
    SETTLEMENT_ENGINE_URL: string;
    INDEXER_URL: string;
  };
  startTime: number;
  serviceVersion: string;
  fetchImpl?: typeof fetch;
}) {
  options.fastify.get('/api/health', async (_request, reply) => {
    const health = await buildGatewayHealthResponse(options);
    const statusCode = health.status === 'unhealthy' ? 503 : 200;
    return reply.code(statusCode).send(health);
  });

  options.fastify.get('/api/health/all', async (_request, reply) => {
    const health = await buildAggregatedHealthResponse(options);
    const statusCode = health.status === 'unhealthy' ? 503 : 200;
    return reply.code(statusCode).send(health);
  });
}

test('GET /api/health/all aggregates downstream health with graceful degradation', async () => {
  const app = Fastify({ logger: false });
  const prisma = {
    $queryRaw: async () => [{ '?column?': 1 }],
  } as unknown as PrismaClient;

  const fetchImpl = async (url: string | URL | Request) => {
    const target = String(url);
    if (target.includes('3002')) return jsonResponse(mockHealth('fx-engine', 'healthy'));
    if (target.includes('3001')) return jsonResponse(mockHealth('settlement-engine', 'degraded'));
    if (target.includes('3003')) throw new Error('indexer unavailable');
    return jsonResponse(mockHealth('unknown', 'healthy'));
  };

  registerGatewayHealthRoutes({
    fastify: app,
    prisma,
    env: {
      FX_ENGINE_URL: 'http://localhost:3002',
      SETTLEMENT_ENGINE_URL: 'http://localhost:3001',
      INDEXER_URL: 'http://localhost:3003',
    },
    startTime: Date.now() - 10_000,
    serviceVersion: '0.1.0',
    fetchImpl,
  });

  const res = await app.inject({ method: 'GET', url: '/api/health/all' });
  assert.equal(res.statusCode, 503);

  const body = JSON.parse(res.body);
  assert.equal(body.status, 'unhealthy');
  assert.equal(body.service, 'api-gateway');
  assert.equal(body.version, '0.1.0');
  assert.ok(body.services['api-gateway']);
  assert.equal(body.services['fx-engine'].status, 'healthy');
  assert.equal(body.services['settlement-engine'].status, 'degraded');
  assert.equal(body.services.indexer.status, 'unhealthy');
  assert.ok(body.services.indexer.error);

  await app.close();
});

test('buildAggregatedHealthResponse marks overall status healthy when all services respond healthy', async () => {
  const fetchImpl = async () => jsonResponse(mockHealth('service', 'healthy'));

  const aggregated = await buildAggregatedHealthResponse({
    prisma: {
      $queryRaw: async () => [{ '?column?': 1 }],
    } as unknown as PrismaClient,
    env: {
      FX_ENGINE_URL: 'http://localhost:3002',
      SETTLEMENT_ENGINE_URL: 'http://localhost:3001',
      INDEXER_URL: 'http://localhost:3003',
    },
    startTime: Date.now() - 5_000,
    serviceVersion: '0.1.0',
    fetchImpl,
  });

  assert.equal(aggregated.status, 'healthy');
  assert.equal(aggregated.services['fx-engine'].status, 'healthy');
  assert.equal(aggregated.services['settlement-engine'].status, 'healthy');
  assert.equal(aggregated.services.indexer.status, 'healthy');
});

test('GET /api/health returns gateway dependency and upstream probes', async () => {
  const app = Fastify({ logger: false });
  const prisma = {
    $queryRaw: async () => [{ '?column?': 1 }],
  } as unknown as PrismaClient;

  registerGatewayHealthRoutes({
    fastify: app,
    prisma,
    env: {
      FX_ENGINE_URL: 'http://localhost:3002',
      SETTLEMENT_ENGINE_URL: 'http://localhost:3001',
      INDEXER_URL: 'http://localhost:3003',
    },
    startTime: Date.now() - 2_000,
    serviceVersion: '0.1.0',
    fetchImpl: async () => jsonResponse(mockHealth('service', 'healthy')),
  });

  const res = await app.inject({ method: 'GET', url: '/api/health' });
  assert.equal(res.statusCode, 200);

  const body = JSON.parse(res.body);
  assert.equal(body.service, 'api-gateway');
  assert.ok(Array.isArray(body.dependencies));
  assert.ok(Array.isArray(body.upstream));
  assert.equal(body.dependencies[0].name, 'postgresql');
  assert.equal(body.upstream.length, 3);

  await app.close();
});
