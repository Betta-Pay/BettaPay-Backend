import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAggregatedHealthResponse } from './health.js';

const env = {
  FX_ENGINE_URL: 'http://fx:3002',
  SETTLEMENT_ENGINE_URL: 'http://settlement:3001',
  INDEXER_URL: 'http://indexer:3003',
};

function fakePrisma() {
  return {
    $queryRaw: async () => [{ '?column?': 1, serverVersion: new Date().toISOString() }],
    payment: { count: async () => 0 },
  } as any;
}

function serviceBody(service: string, status: string) {
  return {
    status,
    service,
    version: '0.1.0',
    uptime: 1,
    lastDependencyCheck: new Date().toISOString(),
    dependencies: [],
  };
}

test('aggregated health probes each upstream service exactly once (#990)', async () => {
  const calls: string[] = [];
  const fetchImpl = (async (url: string) => {
    calls.push(url);
    const service = new URL(url).hostname;
    return new Response(JSON.stringify(serviceBody(service, 'healthy')), { status: 200 });
  }) as unknown as typeof fetch;

  const health = await buildAggregatedHealthResponse({
    prisma: fakePrisma(),
    env,
    startTime: Date.now(),
    serviceVersion: '0.0.0',
    fetchImpl,
  });

  assert.equal(calls.length, 3);
  for (const url of [env.FX_ENGINE_URL, env.SETTLEMENT_ENGINE_URL, env.INDEXER_URL]) {
    assert.equal(calls.filter((c) => c.startsWith(url)).length, 1, `one probe for ${url}`);
  }
  assert.equal(health.services['fx-engine'].status, 'healthy');
  assert.equal(health.services['settlement-engine'].status, 'healthy');
  assert.equal(health.services['indexer'].status, 'healthy');
});

test('aggregated status reflects the single probe result of a failing upstream (#990)', async () => {
  const calls: string[] = [];
  const fetchImpl = (async (url: string) => {
    calls.push(url);
    if (url.startsWith(env.INDEXER_URL)) {
      return new Response('boom', { status: 500 });
    }
    return new Response(JSON.stringify(serviceBody('svc', 'healthy')), { status: 200 });
  }) as unknown as typeof fetch;

  const health = await buildAggregatedHealthResponse({
    prisma: fakePrisma(),
    env,
    startTime: Date.now(),
    serviceVersion: '0.0.0',
    fetchImpl,
  });

  assert.equal(calls.filter((c) => c.startsWith(env.INDEXER_URL)).length, 1);
  assert.equal(health.services['indexer'].status, 'unhealthy');
  assert.equal(health.status, 'unhealthy');
});
