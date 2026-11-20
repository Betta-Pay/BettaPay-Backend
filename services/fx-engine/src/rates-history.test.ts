/**
 * Issue #1050 — Guard Redis and JSON.parse errors in GET /api/rates/history.
 */

process.env.NODE_ENV = 'test';
process.env.RATES_API_URL = 'http://localhost:1234';
process.env.REDIS_URL = 'redis://localhost:6379';
process.env.INTER_SERVICE_SECRET = 'test-secret-that-is-at-least-16-chars';
process.env.LOG_LEVEL = 'silent';

import test from 'tape';

const { fastify, setRedisClientForTesting } = await import('./index.js');

test('#1050: GET /api/rates/history returns 503 when Redis fails', async (t) => {
  await fastify.ready();
  const prevRedis = setRedisClientForTesting({
    zrevrangebyscore: async () => {
      throw new Error('ECONNREFUSED');
    },
  });

  try {
    const res = await fastify.inject({
      method: 'GET',
      url: '/api/rates/history?from=USDC&to=NGN',
    });

    t.equal(res.statusCode, 503, 'returns HTTP 503 on Redis failure');
    const body = res.json();
    t.equal(body.error?.code, 'SERVICE_UNAVAILABLE', 'returns structured SERVICE_UNAVAILABLE error');
  } finally {
    setRedisClientForTesting(prevRedis);
  }
  t.end();
});

test('#1050: GET /api/rates/history returns 500 when cached snapshot is corrupt JSON', async (t) => {
  await fastify.ready();
  const prevRedis = setRedisClientForTesting({
    zrevrangebyscore: async () => ['{not-valid-json'],
  });

  try {
    const res = await fastify.inject({
      method: 'GET',
      url: '/api/rates/history?from=USDC&to=NGN',
    });

    t.equal(res.statusCode, 500, 'returns HTTP 500 on corrupt JSON');
    const body = res.json();
    t.equal(body.error?.code, 'INTERNAL_ERROR', 'returns structured INTERNAL_ERROR');
  } finally {
    setRedisClientForTesting(prevRedis);
  }
  t.end();
});

test('#1050: GET /api/rates/history returns 500 when snapshot shape is invalid', async (t) => {
  await fastify.ready();
  const prevRedis = setRedisClientForTesting({
    zrevrangebyscore: async () => [JSON.stringify({ ts: 'bad', rates: null })],
  });

  try {
    const res = await fastify.inject({
      method: 'GET',
      url: '/api/rates/history?from=USDC&to=NGN',
    });

    t.equal(res.statusCode, 500, 'returns HTTP 500 on invalid snapshot shape');
    const body = res.json();
    t.equal(body.error?.code, 'INTERNAL_ERROR', 'returns structured INTERNAL_ERROR');
  } finally {
    setRedisClientForTesting(prevRedis);
  }
  t.end();
});

test('#1050: GET /api/rates/history returns 200 on valid snapshot', async (t) => {
  await fastify.ready();
  const ts = 1_700_000_000_000;
  const prevRedis = setRedisClientForTesting({
    zrevrangebyscore: async () => [
      JSON.stringify({ ts, rates: { USDC: 1550, NGN: 1 } }),
    ],
  });

  try {
    const res = await fastify.inject({
      method: 'GET',
      url: '/api/rates/history?from=USDC&to=NGN',
    });

    t.equal(res.statusCode, 200, 'returns HTTP 200 on valid snapshot');
    const body = res.json();
    t.equal(body.from, 'USDC');
    t.equal(body.to, 'NGN');
    t.equal(body.rate, '1550.00000000');
    t.equal(body.at, new Date(ts).toISOString());
  } finally {
    setRedisClientForTesting(prevRedis);
  }
  t.end();
  process.exit(0);
});
