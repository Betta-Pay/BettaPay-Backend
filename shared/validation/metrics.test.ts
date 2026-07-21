/**
 * Tests for the Prometheus metrics module (Issue #255)
 *
 * Verifies:
 *  - /metrics endpoint returns Prometheus text format with valid content type
 *  - /metrics endpoint is protected by serviceAuth (401 without valid token)
 *  - /metrics endpoint accepts valid service token and returns 200
 *  - Response body contains expected Prometheus metric lines
 */

import test from 'node:test';
import assert from 'node:assert';
import Fastify from 'fastify';
import { Registry, Counter, Gauge } from 'prom-client';
import { createMetricsRegistry, registerMetricsEndpoint } from './metrics.js';

const SECRET = 'test-inter-service-secret-value-16chars';

function buildMetricsApp(registry: Registry) {
  const app = Fastify({ logger: false });
  registerMetricsEndpoint(app, registry, SECRET);
  return app;
}

test('createMetricsRegistry creates a registry with default metrics', () => {
  const registry = createMetricsRegistry();
  assert.ok(registry instanceof Registry, 'registry should be a prom-client Registry instance');
  assert.ok(typeof registry.metrics === 'function', 'registry should have a metrics() method');
  assert.ok(typeof registry.contentType === 'string', 'registry should have a contentType property');
});

test('registerMetricsEndpoint requires serviceAuth - rejects without token', async () => {
  const registry = new Registry();
  const app = buildMetricsApp(registry);
  await app.ready();

  const res = await app.inject({ method: 'GET', url: '/metrics' });
  assert.strictEqual(res.statusCode, 401, 'should return 401 without x-service-token');
  const body = JSON.parse(res.body);
  assert.strictEqual(body.error.code, 'UNAUTHORIZED', 'error code should be UNAUTHORIZED');

  await app.close();
});

test('registerMetricsEndpoint requires serviceAuth - rejects invalid token', async () => {
  const registry = new Registry();
  const app = buildMetricsApp(registry);
  await app.ready();

  const res = await app.inject({
    method: 'GET',
    url: '/metrics',
    headers: { 'x-service-token': 'wrong-token' },
  });
  assert.strictEqual(res.statusCode, 401, 'should return 401 with wrong token');

  await app.close();
});

test('registerMetricsEndpoint returns valid Prometheus output with correct token', async () => {
  const registry = new Registry();
  // Add a test counter so we have something to verify
  const testCounter = new Counter({
    name: 'test_requests_total',
    help: 'Test counter',
    registers: [registry],
    labelNames: ['status'],
  });
  testCounter.inc({ status: 'ok' });

  const app = buildMetricsApp(registry);
  await app.ready();

  const res = await app.inject({
    method: 'GET',
    url: '/metrics',
    headers: { 'x-service-token': SECRET },
  });

  assert.strictEqual(res.statusCode, 200, 'should return 200 with valid token');
  assert.ok(
    String(res.headers['content-type'] ?? '').includes('text/plain'),
    'content-type should be text/plain (Prometheus format)'
  );

  const body = res.body;
  assert.ok(typeof body === 'string' && body.length > 0, 'response body should be non-empty');

  // Prometheus exposition format: lines starting with # HELP and # TYPE, then metric lines
  assert.ok(
    body.includes('# HELP test_requests_total'),
    'should contain HELP line for custom metric'
  );
  assert.ok(
    body.includes('# TYPE test_requests_total counter'),
    'should contain TYPE line for custom metric'
  );
  assert.ok(
    body.includes('test_requests_total{status="ok"} 1'),
    'should contain the counter value with label'
  );

  await app.close();
});

test('registerMetricsEndpoint includes default metrics (process/event loop)', async () => {
  const registry = createMetricsRegistry();
  const app = buildMetricsApp(registry);
  await app.ready();

  const res = await app.inject({
    method: 'GET',
    url: '/metrics',
    headers: { 'x-service-token': SECRET },
  });

  assert.strictEqual(res.statusCode, 200);

  const body = res.body;

  // Default metrics from collectDefaultMetrics should include process and nodejs stats
  assert.ok(body.includes('process_cpu_seconds_total'), 'should include process CPU metrics');
  assert.ok(body.includes('nodejs_eventloop_lag_seconds'), 'should include event loop lag metric');
  assert.ok(body.includes('nodejs_heap_size_total_bytes'), 'should include heap size metric');

  await app.close();
});

test('createMetricsRegistry accepts prefix and labels options', () => {
  const registry = createMetricsRegistry({
    prefix: 'bettapay_',
    labels: { service: 'test-service' },
  });
  assert.ok(registry instanceof Registry, 'should create registry with options');
});

test('custom Gauge metric is exposed in /metrics output', async () => {
  const registry = new Registry();
  const depthGauge = new Gauge({
    name: 'bullmq_queue_depth',
    help: 'Queue depth gauge',
    registers: [registry],
    labelNames: ['queue'],
  });
  depthGauge.set({ queue: 'test-queue' }, 42);

  const app = buildMetricsApp(registry);
  await app.ready();

  const res = await app.inject({
    method: 'GET',
    url: '/metrics',
    headers: { 'x-service-token': SECRET },
  });

  assert.strictEqual(res.statusCode, 200);
  assert.ok(
    res.body.includes('bullmq_queue_depth{queue="test-queue"} 42'),
    'should include gauge value with label'
  );

  await app.close();
});
