import test from 'node:test';
import assert from 'node:assert/strict';
import {
  aggregateAllHealth,
  buildHealthResponse,
  buildIndexerHealthResponse,
  buildSettlementEngineHealthResponse,
  checkBullMQ,
  checkPostgresql,
  checkPostgresqlReplica,
  checkRedisPing,
  computeOverallStatus,
  getBullmqWaitingThreshold,
} from './health.js';

import { HealthResponse as HealthResponseSchema, type DependencyHealth, type HealthResponse } from './schemas.js';

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

test('buildSettlementEngineHealthResponse forwards redisHealthState into the redis dependency details', async () => {
  const health = await buildSettlementEngineHealthResponse({
    queryDatabase: async () => [{ '?column?': 1 }],
    pingRedis: async () => 'PONG',
    getQueueJobCounts: async () => ({ waiting: 0, active: 0, failed: 0, delayed: 0 }),
    getQueueIsPaused: async () => false,
    redisHealthState: { connected: true, errors: 3, lastError: 'ECONNRESET', reconnects: 1 },
    startTime: Date.now(),
    service: 'settlement-engine',
    version: '0.1.0',
  });

  const redisDep = health.dependencies.find((d) => d.name === 'redis');
  assert.ok(redisDep?.details);
  assert.equal(redisDep!.details!.errors, 3);
  assert.equal(redisDep!.details!.reconnects, 1);
  assert.equal(redisDep!.details!.lastError, 'ECONNRESET');
});

test('buildIndexerHealthResponse forwards redisHealthState into the redis dependency details', async () => {
  const health = await buildIndexerHealthResponse({
    queryDatabase: async () => [{ '?column?': 1 }],
    pingRedis: async () => 'PONG',
    getQueueJobCounts: async () => ({ waiting: 0, active: 0, failed: 0, delayed: 0 }),
    getQueueIsPaused: async () => false,
    redisHealthState: { connected: false, errors: 7, lastError: 'ETIMEDOUT', reconnects: 2 },
    getLatestLedger: async () => ({ sequence: 100 }),
    lagWarnThreshold: 50,
    startTime: Date.now(),
    service: 'indexer',
    version: '0.1.0',
  });

  const redisDep = health.dependencies.find((d) => d.name === 'redis');
  assert.ok(redisDep?.details);
  assert.equal(redisDep!.details!.errors, 7);
  assert.equal(redisDep!.details!.reconnects, 2);
  assert.equal(redisDep!.details!.lastError, 'ETIMEDOUT');
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
  assert.ok((dependency.latencyMs ?? 0) < 1000);
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
  assert.ok((dependency.latencyMs ?? 0) > 1000);

  const response = buildHealthResponse({
    service: 'db-service',
    version: '0.1.0',
    startTime: Date.now() - 5000,
    dependencies: [dependency as any],
  });

  assert.equal(response.status, 'degraded');
});

test('checkRedisPing includes health state details when provided', async () => {
  const healthState = {
    connected: true,
    errors: 2,
    lastError: 'Connection timeout',
    reconnects: 1,
  };

  const dep = await checkRedisPing(async () => 'PONG', undefined, healthState);

  assert.equal(dep.status, 'connected');
  assert.ok(dep.details);
  assert.equal(dep.details.connected, true);
  assert.equal(dep.details.errors, 2);
  assert.equal(dep.details.reconnects, 1);
  assert.equal(dep.details.lastError, 'Connection timeout');
});

test('checkRedisPing reports disconnected with health state when ping fails', async () => {
  const healthState = {
    connected: false,
    errors: 5,
    lastError: 'ECONNREFUSED',
    reconnects: 3,
  };

  const dep = await checkRedisPing(
    async () => {
      throw new Error('Connection refused');
    },
    undefined,
    healthState,
  );

  assert.equal(dep.status, 'disconnected');
  assert.ok(dep.details);
  assert.equal(dep.details.connected, false);
  assert.equal(dep.details.errors, 5);
  assert.equal(dep.details.reconnects, 3);
  assert.equal(dep.details.lastError, 'ECONNREFUSED');
});

test('checkRedisPing omits details when healthState is not provided (backward compatible)', async () => {
  const dep = await checkRedisPing(async () => 'PONG');

  assert.equal(dep.status, 'connected');
  assert.equal(dep.details, undefined);
});

// ── Issue #895: Read-replica health detail ─────────────────────────────────────

test('checkPostgresqlReplica probes read-replica independently and reports status and serverVersion', async () => {
  const connectedReplica = await checkPostgresqlReplica(async () => [
    { serverVersion: '15.4' },
  ]);
  assert.equal(connectedReplica.name, 'postgresql-replica');
  assert.equal(connectedReplica.status, 'connected');
  assert.equal(connectedReplica.healthy, true);
  assert.equal(connectedReplica.serverVersion, '15.4');

  const disconnectedReplica = await checkPostgresqlReplica(async () => {
    throw new Error('connection to replica failed: timeout');
  });
  assert.equal(disconnectedReplica.name, 'postgresql-replica');
  assert.equal(disconnectedReplica.status, 'disconnected');
  assert.equal(disconnectedReplica.healthy, false);
  assert.match(String(disconnectedReplica.details?.error), /connection to replica failed/);
});

test('buildHealthResponse: with primary healthy and replica down, overall status is degraded, not down (#895)', () => {
  const primaryDep = dep('postgresql', 'connected');
  const replicaDep: DependencyHealth = {
    name: 'postgresql-replica',
    status: 'disconnected',
    latencyMs: 12,
    details: { error: 'replica unreachable' },
  };

  const response = buildHealthResponse({
    service: 'api-gateway',
    version: '0.1.0',
    startTime: Date.now() - 5000,
    dependencies: [primaryDep],
    replica: replicaDep,
  });

  assert.equal(response.status, 'degraded', 'degraded when replica is down and primary is healthy');
  assert.deepEqual(response.replica, replicaDep, 'replica detail is exposed in payload');

  // Verify existing schema parses payload cleanly
  const parsed = HealthResponseSchema.parse(response);
  assert.equal(parsed.status, 'degraded');
  assert.equal(parsed.replica?.status, 'disconnected');
});

test('buildHealthResponse: with primary down, overall status is unhealthy (down) regardless of replica (#895)', () => {
  const primaryDown = dep('postgresql', 'disconnected');
  const replicaUp: DependencyHealth = {
    name: 'postgresql-replica',
    status: 'connected',
    latencyMs: 5,
  };

  const response = buildHealthResponse({
    service: 'api-gateway',
    version: '0.1.0',
    startTime: Date.now() - 5000,
    dependencies: [primaryDown],
    criticalDependencyNames: ['postgresql'],
    replica: replicaUp,
  });

  assert.equal(response.status, 'unhealthy', 'overall status must be down (unhealthy) when primary is down');
  assert.equal(response.replica?.status, 'connected');
});

// ── Issue #896: BullMQ waiting jobs degradation threshold ──────────────────────

test('buildHealthResponse: boundary test just below, at, and above BULLMQ_WAITING_DEGRADED_THRESHOLD (#896)', () => {
  const threshold = 1000;
  const primaryDep = dep('postgresql', 'connected');
  const redisDep = dep('redis', 'connected');

  // 1. Just below threshold (999) -> healthy
  const belowResp = buildHealthResponse({
    service: 'settlement-engine',
    version: '0.1.0',
    startTime: Date.now() - 5000,
    dependencies: [primaryDep, redisDep],
    waitingJobs: 999,
    waitingThreshold: threshold,
  });
  assert.equal(belowResp.status, 'healthy');
  assert.equal(belowResp.waitingJobs, 999);

  // 2. Exactly at threshold (1000) -> healthy
  const atResp = buildHealthResponse({
    service: 'settlement-engine',
    version: '0.1.0',
    startTime: Date.now() - 5000,
    dependencies: [primaryDep, redisDep],
    waitingJobs: 1000,
    waitingThreshold: threshold,
  });
  assert.equal(atResp.status, 'healthy');
  assert.equal(atResp.waitingJobs, 1000);

  // 3. Just above threshold (1001) -> degraded
  const aboveResp = buildHealthResponse({
    service: 'settlement-engine',
    version: '0.1.0',
    startTime: Date.now() - 5000,
    dependencies: [primaryDep, redisDep],
    waitingJobs: 1001,
    waitingThreshold: threshold,
  });
  assert.equal(aboveResp.status, 'degraded');
  assert.equal(aboveResp.waitingJobs, 1001);

  // Assert consumers parse payload with waitingJobs
  const parsed = HealthResponseSchema.parse(aboveResp);
  assert.equal(parsed.status, 'degraded');
  assert.equal(parsed.waitingJobs, 1001);
});

test('getBullmqWaitingThreshold: reads env variable or defaults to 1000 (#896)', () => {
  const originalEnv = process.env.BULLMQ_WAITING_DEGRADED_THRESHOLD;
  try {
    delete process.env.BULLMQ_WAITING_DEGRADED_THRESHOLD;
    assert.equal(getBullmqWaitingThreshold(), 1000);

    process.env.BULLMQ_WAITING_DEGRADED_THRESHOLD = '2500';
    assert.equal(getBullmqWaitingThreshold(), 2500);

    process.env.BULLMQ_WAITING_DEGRADED_THRESHOLD = 'invalid';
    assert.equal(getBullmqWaitingThreshold(), 1000);
  } finally {
    if (originalEnv !== undefined) {
      process.env.BULLMQ_WAITING_DEGRADED_THRESHOLD = originalEnv;
    } else {
      delete process.env.BULLMQ_WAITING_DEGRADED_THRESHOLD;
    }
  }
});