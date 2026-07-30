import test from 'node:test';
import assert from 'node:assert/strict';
import {
  aggregateAllHealth,
  buildHealthResponse,
  buildSettlementEngineHealthResponse,
  checkBullMQ,
  checkPostgresql,
  computeOverallStatus,
} from './health.js';
import type { DependencyHealth, HealthResponse } from './schemas.js';

function dep(name: string, status: 'connected' | 'disconnected'): DependencyHealth {
  return { name, status, latencyMs: 1 };
}

test('computeOverallStatus marks critical dependency failures as unhealthy', () => {
  assert.equal(
    computeOverallStatus([dep('postgresql', 'disconnected')], { criticalNames: ['postgresql'] }),
    'unhealthy',
  );
});

test('computeOverallStatus marks optional dependency failures as degraded', () => {
  assert.equal(
    computeOverallStatus(
      [dep('postgresql', 'connected'), dep('rates-api', 'disconnected')],
      { criticalNames: ['postgresql'] },
    ),
    'degraded',
  );
});

test('computeOverallStatus returns healthy when all dependencies are connected', () => {
  assert.equal(
    computeOverallStatus([dep('postgresql', 'connected'), dep('redis', 'connected')]),
    'healthy',
  );
});

test('buildHealthResponse includes service metadata and timestamps', () => {
  const startTime = Date.now() - 5000;
  const response = buildHealthResponse({
    service: 'fx-engine',
    version: '0.1.0',
    startTime,
    dependencies: [dep('redis', 'connected')],
  });

  assert.equal(response.service, 'fx-engine');
  assert.equal(response.version, '0.1.0');
  assert.equal(response.status, 'healthy');
  assert.ok(response.uptime >= 4);
  assert.ok(response.lastDependencyCheck);
});

function mockHealthResponse(service: string, status: HealthResponse['status']): HealthResponse {
  return {
    status,
    service,
    version: '0.1.0',
    uptime: 10,
    lastDependencyCheck: new Date().toISOString(),
    dependencies: [dep('redis', status === 'unhealthy' ? 'disconnected' : 'connected')],
  };
}

test('aggregateAllHealth uses Promise.allSettled and degrades when a downstream service fails', async () => {
  const gatewayHealth = buildHealthResponse({
    service: 'api-gateway',
    version: '0.1.0',
    startTime: Date.now(),
    dependencies: [dep('postgresql', 'connected')],
  });

  const fetchImpl = async (url: string | URL | Request) => {
    const target = String(url);
    if (target.includes('fx-engine')) {
      return {
        ok: true,
        json: async () => mockHealthResponse('fx-engine', 'healthy'),
      } as Response;
    }
    if (target.includes('settlement-engine')) {
      throw new Error('connection refused');
    }
    return {
      ok: true,
      json: async () => mockHealthResponse('indexer', 'degraded'),
    } as Response;
  };

  const aggregated = await aggregateAllHealth({
    gatewayHealth,
    targets: [
      { name: 'fx-engine', baseUrl: 'http://fx-engine.test:3002' },
      { name: 'settlement-engine', baseUrl: 'http://settlement-engine.test:3001' },
      { name: 'indexer', baseUrl: 'http://indexer.test:3003' },
    ],
    fetchImpl,
  });

  assert.equal(aggregated.status, 'unhealthy');
  assert.equal(aggregated.services['api-gateway'].status, 'healthy');
  assert.equal(aggregated.services['fx-engine'].status, 'healthy');
  assert.equal(aggregated.services['indexer'].status, 'degraded');
  assert.equal(aggregated.services['settlement-engine'].status, 'unhealthy');
  assert.ok(aggregated.services['settlement-engine'].error);
});

test('checkBullMQ reports queue metrics and connected status under the waiting threshold', async () => {
  const dep = await checkBullMQ(
    async () => ({ waiting: 5, active: 1, failed: 0, delayed: 0 }),
    'bullmq-settlement',
    undefined,
    async () => false,
  );

  assert.equal(dep.status, 'connected');
  assert.deepEqual(dep.details, {
    queueName: 'bullmq-settlement',
    isPaused: false,
    waiting: 5,
    active: 1,
    failed: 0,
    delayed: 0,
  });
});

test('checkBullMQ marks a paused queue as disconnected regardless of job counts', async () => {
  const dep = await checkBullMQ(
    async () => ({ waiting: 0, active: 0, failed: 0, delayed: 0 }),
    'bullmq-webhooks',
    undefined,
    async () => true,
  );

  assert.equal(dep.status, 'disconnected');
  assert.equal(dep.details?.isPaused, true);
});

test('buildSettlementEngineHealthResponse degrades when waiting jobs exceed the threshold', async () => {
  const health = await buildSettlementEngineHealthResponse({
    queryDatabase: async () => [{ '?column?': 1 }],
    pingRedis: async () => 'PONG',
    getQueueJobCounts: async () => ({ waiting: 1001, active: 2, failed: 0, delayed: 0 }),
    getQueueIsPaused: async () => false,
    startTime: Date.now(),
    service: 'settlement-engine',
    version: '0.1.0',
  });

  assert.equal(health.status, 'degraded');
});

test('buildSettlementEngineHealthResponse marks unhealthy when the queue is paused', async () => {
  const health = await buildSettlementEngineHealthResponse({
    queryDatabase: async () => [{ '?column?': 1 }],
    pingRedis: async () => 'PONG',
    getQueueJobCounts: async () => ({ waiting: 0, active: 0, failed: 0, delayed: 0 }),
    getQueueIsPaused: async () => true,
    startTime: Date.now(),
    service: 'settlement-engine',
    version: '0.1.0',
  });

  assert.equal(health.status, 'unhealthy');
});

test('aggregateAllHealth returns healthy when gateway and downstream services are healthy', async () => {
  const gatewayHealth = buildHealthResponse({
    service: 'api-gateway',
    version: '0.1.0',
    startTime: Date.now(),
    dependencies: [dep('postgresql', 'connected')],
  });

  const fetchImpl = async () =>
    ({
      ok: true,
      json: async () => mockHealthResponse('service', 'healthy'),
    }) as Response;

  const aggregated = await aggregateAllHealth({
    gatewayHealth,
    targets: [{ name: 'fx-engine', baseUrl: 'http://fx-engine.test:3002' }],
    fetchImpl,
  });

  assert.equal(aggregated.status, 'healthy');
  assert.equal(Object.keys(aggregated.services).length, 2);
});

test('checkPostgresql returns healthy with latency and optional serverVersion', async () => {
  const dependency = await checkPostgresql(async () => [
    { '?column?': 1, serverVersion: new Date().toISOString() },
  ]);

  assert.equal(dependency.status, 'connected');
  assert.equal(dependency.healthy, true);
  assert.equal(typeof dependency.latencyMs, 'number');
  assert.ok(dependency.latencyMs < 1000);
  assert.equal(typeof dependency.serverVersion, 'string');
});

test('buildHealthResponse marks degraded when database latency exceeds threshold', () => {
  const response = buildHealthResponse({
    service: 'db-service',
    version: '0.1.0',
    startTime: Date.now() - 5000,
    dependencies: [
      {
        name: 'postgresql',
        status: 'connected',
        latencyMs: 1500,
        healthy: true,
        serverVersion: null,
      } as any,
    ],
  });

  assert.equal(response.status, 'degraded');
});

test('checkPostgresql measures slow latency as degraded in buildHealthResponse', async () => {
  const dependency = await checkPostgresql(async () => {
    await new Promise((resolve) => setTimeout(resolve, 1105));
    return [{ '?column?': 1, serverVersion: new Date().toISOString() }];
  });

  assert.equal(dependency.status, 'connected');
  assert.equal(dependency.healthy, true);
  assert.ok(dependency.latencyMs > 1000);

  const response = buildHealthResponse({
    service: 'db-service',
    version: '0.1.0',
    startTime: Date.now() - 5000,
    dependencies: [dependency as any],
  });

  assert.equal(response.status, 'degraded');
});
