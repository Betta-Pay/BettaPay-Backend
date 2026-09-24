import test from 'node:test';
import assert from 'node:assert/strict';
import type { HealthResponse } from '../../../shared/validation/schemas.js';
import { buildApp } from './index.js';
import { createMockPrisma } from './test-utils.js';

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

test('GET /api/health/live always returns 200 (liveness probe)', async () => {
  const prisma = createMockPrisma() as any;

  const app = buildApp({
    prisma,
    logger: false,
    fetchImpl: (async () => { throw new Error('all downstream down'); }) as any
  });

  const res = await app.inject({ method: 'GET', url: '/api/health/live' });
  assert.equal(res.statusCode, 200);

  const body = JSON.parse(res.body);
  assert.equal(body.status, 'alive');
  assert.equal(body.service, 'api-gateway');

  await app.close();
});

test('GET /api/health returns 503 when critical dependents fail (readiness probe)', async () => {
  const prisma = createMockPrisma() as any;

  const fetchImpl = async (url: string | URL | Request) => {
    throw new Error('upstream unreachable');
  };

  const app = buildApp({
    prisma,
    logger: false,
    fetchImpl: fetchImpl as any
  });

  const res = await app.inject({ method: 'GET', url: '/api/health' });
  assert.equal(res.statusCode, 503);

  const body = JSON.parse(res.body);
  assert.equal(body.status, 'unhealthy');
  assert.equal(body.service, 'api-gateway');

  await app.close();
});

test('GET /api/health/all aggregates downstream health with graceful degradation', async () => {
  const prisma = createMockPrisma() as any;

  const fetchImpl = async (url: string | URL | Request) => {
    const target = String(url);
    if (target.includes('3002')) return jsonResponse(mockHealth('fx-engine', 'healthy'));
    if (target.includes('3001')) return jsonResponse(mockHealth('settlement-engine', 'degraded'));
    if (target.includes('3003')) throw new Error('indexer unavailable');
    return jsonResponse(mockHealth('unknown', 'healthy'));
  };

  const app = buildApp({
    prisma,
    logger: false,
    fetchImpl: fetchImpl as any
  });

  const res = await app.inject({ method: 'GET', url: '/api/health/all' });
  assert.equal(res.statusCode, 503);

  const body = JSON.parse(res.body);
  assert.equal(body.status, 'unhealthy');
  assert.equal(body.service, 'api-gateway');
  assert.ok(body.services['api-gateway']);
  assert.equal(body.services['fx-engine'].status, 'healthy');
  assert.equal(body.services['settlement-engine'].status, 'degraded');
  assert.equal(body.services.indexer.status, 'unhealthy');
  assert.ok(body.services.indexer.error);

  await app.close();
});

test('HEAD /api/health includes security hardening headers', async () => {
  const prisma = createMockPrisma() as any;

  const app = buildApp({
    prisma,
    logger: false,
    fetchImpl: (async () => jsonResponse(mockHealth('service', 'healthy'))) as any
  });

  const res = await app.inject({ method: 'HEAD', url: '/api/health' });

  assert.equal(res.statusCode, 200);

  assert.ok(res.headers['strict-transport-security']);
  assert.ok(res.headers['x-content-type-options']);
  assert.ok(res.headers['x-download-options']);
  assert.ok(res.headers['x-frame-options']);
  assert.ok(res.headers['x-permitted-cross-domain-policies']);
  assert.ok(res.headers['x-xss-protection']);
  assert.ok(res.headers['cross-origin-embedder-policy']);
  assert.ok(res.headers['cross-origin-opener-policy']);
  assert.ok(res.headers['cross-origin-resource-policy']);
  assert.ok(res.headers['referrer-policy']);
  assert.ok(res.headers['permissions-policy']);

  assert.equal(res.headers['cross-origin-embedder-policy'], 'require-corp');
  assert.equal(res.headers['cross-origin-opener-policy'], 'same-origin');
  assert.equal(res.headers['cross-origin-resource-policy'], 'same-origin');
  assert.equal(res.headers['referrer-policy'], 'strict-origin-when-cross-origin');
  assert.equal(res.headers['permissions-policy'], 'geolocation=(), microphone=(), camera=()');
  assert.ok((res.headers['strict-transport-security'] as string).includes('max-age=31536000'));

  await app.close();
});

test('GET /api/health returns gateway dependency and upstream probes', async () => {
  const prisma = createMockPrisma() as any;

  const app = buildApp({
    prisma,
    logger: false,
    fetchImpl: (async () => jsonResponse(mockHealth('service', 'healthy'))) as any
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
