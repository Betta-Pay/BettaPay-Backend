/**
 * Route tests for replay queue failure handling and :jobId format validation (#1062).
 */

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'a'.repeat(32);
process.env.DATABASE_URL = 'postgresql://localhost:5432/db';
process.env.SETTLEMENT_CONTRACT_ID = 'CDLZFC3SYXDT4MMSTXTU4Z4VABMFR6SPLPNCZF656SIHPXT6LPWEEXGO';
process.env.GOVERNANCE_CONTRACT_ID = 'CBJDHFU7XYDT4MMSTXTU4Z4VABMFR6SPLPNCZF656SIHPXT6LPWEEXGO';
process.env.ADMIN_ADDRESS = 'GBJDHFU7XYDT4MMSTXTU4Z4VABMFR6SPLPNCZF656SIHPXT6LPWEEXGO';
process.env.INTER_SERVICE_SECRET = 'test-service-secret-value';
process.env.GOOGLE_CLIENT_ID = 'test-google-client-id';
process.env.ADMIN_SECRET = 'test-admin-secret';
process.env.FIELD_ENCRYPTION_KEY = 'b'.repeat(32);

import test from 'tape';

const { fastify, replayQueue, replayProgressRedis } = await import('./index.js');

const AUTH = { 'x-service-token': 'test-service-secret-value' };
const MONITORED_CONTRACT = 'CDLZFC3SYXDT4MMSTXTU4Z4VABMFR6SPLPNCZF656SIHPXT6LPWEEXGO';

test('POST /api/events/replay returns structured 503 when replayQueue.add throws (#1062)', async (t) => {
  await fastify.ready();
  const origAdd = replayQueue.add.bind(replayQueue);
  replayQueue.add = (async () => {
    throw new Error('Redis connection refused');
  }) as any;

  try {
    const res = await fastify.inject({
      method: 'POST',
      url: '/api/events/replay',
      headers: AUTH,
      payload: { startLedger: 100, endLedger: 200 },
    });

    t.equal(res.statusCode, 503, 'returns HTTP 503 on queue failure');
    const body = JSON.parse(res.body);
    t.equal(body.error?.code, 'SERVICE_UNAVAILABLE', 'returns SERVICE_UNAVAILABLE error code');
    t.ok(typeof body.error?.message === 'string', 'includes structured error message');
  } finally {
    replayQueue.add = origAdd;
  }
  t.end();
});

test('POST /api/events/replay returns 202 when replayQueue.add succeeds (#1062)', async (t) => {
  await fastify.ready();
  const origAdd = replayQueue.add.bind(replayQueue);
  replayQueue.add = (async () => ({ id: '42' })) as any;

  try {
    const res = await fastify.inject({
      method: 'POST',
      url: '/api/events/replay',
      headers: AUTH,
      payload: { startLedger: 100, endLedger: 150 },
    });

    t.equal(res.statusCode, 202, 'returns HTTP 202 on success');
    const body = JSON.parse(res.body);
    t.equal(body.jobId, '42', 'returns queued jobId');
    t.equal(body.status, 'queued', 'returns queued status');
  } finally {
    replayQueue.add = origAdd;
  }
  t.end();
});

test('POST /api/events/replay/contract/:contractId returns structured 503 when replayQueue.add throws (#1062)', async (t) => {
  await fastify.ready();
  const origAdd = replayQueue.add.bind(replayQueue);
  replayQueue.add = (async () => {
    throw new Error('BullMQ Redis down');
  }) as any;

  try {
    const res = await fastify.inject({
      method: 'POST',
      url: `/api/events/replay/contract/${MONITORED_CONTRACT}`,
      headers: AUTH,
      payload: { startLedger: 10, endLedger: 20 },
    });

    t.equal(res.statusCode, 503, 'returns HTTP 503 on per-contract queue failure');
    const body = JSON.parse(res.body);
    t.equal(body.error?.code, 'SERVICE_UNAVAILABLE', 'returns SERVICE_UNAVAILABLE error code');
  } finally {
    replayQueue.add = origAdd;
  }
  t.end();
});

test('GET /api/events/replay/:jobId/status rejects malformed :jobId with 400 and skips Redis lookup (#1062)', async (t) => {
  await fastify.ready();
  const origGet = replayProgressRedis.get.bind(replayProgressRedis);
  let redisLookups = 0;
  replayProgressRedis.get = (async () => {
    redisLookups += 1;
    return null;
  }) as any;

  const invalidJobIds = [
    'other:redis:key',
    'job*wildcard',
    'job.with.dots',
    'job%20space',
    'a'.repeat(129),
  ];

  try {
    for (const badId of invalidJobIds) {
      const res = await fastify.inject({
        method: 'GET',
        url: `/api/events/replay/${badId}/status`,
        headers: AUTH,
      });

      t.equal(res.statusCode, 400, `rejects malformed jobId "${badId}" with 400`);
      const body = JSON.parse(res.body);
      t.equal(body.error?.code, 'VALIDATION_ERROR', 'returns VALIDATION_ERROR code');
    }
    t.equal(redisLookups, 0, 'never queries Redis for malformed jobIds');
  } finally {
    replayProgressRedis.get = origGet;
  }
  t.end();
});

test('GET /api/events/replay/:jobId/status accepts valid jobId and returns progress (#1062)', async (t) => {
  await fastify.ready();
  const origGet = replayProgressRedis.get.bind(replayProgressRedis);
  replayProgressRedis.get = (async (key: string) => {
    if (key === 'replay:progress:job_42-abc') {
      return JSON.stringify({
        totalLedgers: 100,
        processedLedgers: 40,
        status: 'running',
      });
    }
    return null;
  }) as any;

  try {
    const res = await fastify.inject({
      method: 'GET',
      url: '/api/events/replay/job_42-abc/status',
      headers: AUTH,
    });

    t.equal(res.statusCode, 200, 'returns 200 for existing valid jobId');
    const body = JSON.parse(res.body);
    t.equal(body.jobId, 'job_42-abc', 'returns jobId');
    t.equal(body.status, 'running', 'returns progress status');

    const missing = await fastify.inject({
      method: 'GET',
      url: '/api/events/replay/999/status',
      headers: AUTH,
    });
    t.equal(missing.statusCode, 404, 'returns 404 for unknown valid jobId');
  } finally {
    replayProgressRedis.get = origGet;
  }
  t.end();
});

test.onFinish(() => {
  process.exit(process.exitCode ?? 0);
});
