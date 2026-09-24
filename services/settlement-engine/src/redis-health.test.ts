import test from 'tape';
import { buildSettlementEngineHealthResponse } from '@bettapay/validation';

test('buildSettlementEngineHealthResponse exposes Redis degraded state with error count', async (t) => {
  // Simulate a Redis client that has experienced connection issues
  const redisHealthState = {
    connected: false,
    errors: 3,
    lastError: 'ECONNREFUSED',
    reconnects: 2,
  };

  const health = await buildSettlementEngineHealthResponse({
    queryDatabase: async () => [{ '?column?': 1 }],
    pingRedis: async () => {
      throw new Error('Connection refused');
    },
    redisHealthState,
    getQueueJobCounts: async () => ({ waiting: 0, active: 0, failed: 0, delayed: 0 }),
    getQueueIsPaused: async () => false,
    startTime: Date.now() - 5000,
    service: 'settlement-engine',
    version: '0.1.0',
  });

  // Overall status should be unhealthy because Redis is critical
  t.equal(health.status, 'unhealthy', 'service status is unhealthy when Redis is down');

  // Find the Redis dependency in the health response
  const redisDep = health.dependencies.find((dep) => dep.name === 'redis');
  t.ok(redisDep, 'redis dependency exists in health response');
  t.equal(redisDep?.status, 'disconnected', 'redis status is disconnected');

  // Verify health state details are exposed
  t.ok(redisDep?.details, 'redis dependency has details');
  t.equal(redisDep?.details?.connected, false, 'details show connected=false');
  t.equal(redisDep?.details?.errors, 3, 'details show error count');
  t.equal(redisDep?.details?.reconnects, 2, 'details show reconnect count');
  t.equal(redisDep?.details?.lastError, 'ECONNREFUSED', 'details show last error message');

  // Verify other critical services remain unaffected
  const postgresDep = health.dependencies.find((dep) => dep.name === 'postgresql');
  t.equal(postgresDep?.status, 'connected', 'postgresql is still connected');

  const bullmqDep = health.dependencies.find((dep) => dep.name === 'bullmq-settlement');
  t.equal(bullmqDep?.status, 'connected', 'bullmq is still connected');

  t.end();
});

test('buildSettlementEngineHealthResponse shows Redis connected with accumulated errors', async (t) => {
  // Simulate a Redis client that recovered after some errors
  const redisHealthState = {
    connected: true,
    errors: 5,
    lastError: 'Timeout connecting to Redis',
    reconnects: 3,
  };

  const health = await buildSettlementEngineHealthResponse({
    queryDatabase: async () => [{ '?column?': 1 }],
    pingRedis: async () => 'PONG',
    redisHealthState,
    getQueueJobCounts: async () => ({ waiting: 0, active: 0, failed: 0, delayed: 0 }),
    getQueueIsPaused: async () => false,
    startTime: Date.now() - 5000,
    service: 'settlement-engine',
    version: '0.1.0',
  });

  // Overall status should be healthy since all critical services are connected
  t.equal(health.status, 'healthy', 'service status is healthy when Redis is connected');

  const redisDep = health.dependencies.find((dep) => dep.name === 'redis');
  t.equal(redisDep?.status, 'connected', 'redis status is connected');

  // Health state should still show the error history
  t.ok(redisDep?.details, 'redis dependency has details');
  t.equal(redisDep?.details?.connected, true, 'details show connected=true');
  t.equal(redisDep?.details?.errors, 5, 'details show accumulated error count');
  t.equal(redisDep?.details?.reconnects, 3, 'details show reconnect count');
  t.equal(redisDep?.details?.lastError, 'Timeout connecting to Redis', 'details show last error message');

  t.end();
});

test('buildSettlementEngineHealthResponse works without healthState (backward compatible)', async (t) => {
  // Verify backward compatibility when healthState is not provided
  const health = await buildSettlementEngineHealthResponse({
    queryDatabase: async () => [{ '?column?': 1 }],
    pingRedis: async () => 'PONG',
    // no redisHealthState provided
    getQueueJobCounts: async () => ({ waiting: 0, active: 0, failed: 0, delayed: 0 }),
    getQueueIsPaused: async () => false,
    startTime: Date.now() - 5000,
    service: 'settlement-engine',
    version: '0.1.0',
  });

  t.equal(health.status, 'healthy', 'service status is healthy');

  const redisDep = health.dependencies.find((dep) => dep.name === 'redis');
  t.equal(redisDep?.status, 'connected', 'redis status is connected');
  t.notOk(redisDep?.details, 'redis dependency has no details when healthState not provided');

  t.end();
});
