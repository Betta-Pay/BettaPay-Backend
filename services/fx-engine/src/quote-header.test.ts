process.env.NODE_ENV = 'test';
process.env.RATES_API_URL = 'http://localhost:1234';
process.env.REDIS_URL = 'redis://localhost:6379';
process.env.INTER_SERVICE_SECRET = 'test-secret-that-is-at-least-16-chars';
process.env.MAX_STALE_SECONDS = '300';
process.env.LOG_LEVEL = 'silent';

import test from 'tape';

const {
  fastify,
  fxQuoteCacheWriteFailuresTotal,
  setRateCacheTimestampsForTesting,
  setRedisClientForTesting,
} = await import('./index.js');

test('#1049: GET /api/quote aligns X-FX-Stale header with body stale flag when pair rate is stale', async (t) => {
  await fastify.ready();
  const now = Date.now();
  const prevCache = setRateCacheTimestampsForTesting(now, {
    USDC: now - 600_000, // stale (> 300s), even though cache.cachedAt is fresh
    NGN: now,
  });
  const prevRedis = setRedisClientForTesting({
    set: async () => 'OK',
  });

  try {
    const res = await fastify.inject({
      method: 'GET',
      url: '/api/quote?from=USDC&to=NGN&amount=100',
    });

    t.equal(res.statusCode, 200, 'returns 200 OK');
    const body = res.json();
    t.equal(body.stale, true, 'body stale flag is true');
    t.equal(res.headers['x-fx-stale'], 'true', 'X-FX-Stale header matches body stale=true');
  } finally {
    setRateCacheTimestampsForTesting(prevCache.cachedAt, prevCache.rateCachedAt);
    setRedisClientForTesting(prevRedis);
  }
  t.end();
});

test('#1049: GET /api/quote omits X-FX-Stale header when body stale flag is false', async (t) => {
  await fastify.ready();
  const now = Date.now();
  const prevCache = setRateCacheTimestampsForTesting(now, {
    USDC: now,
    NGN: now,
  });
  const prevRedis = setRedisClientForTesting({
    set: async () => 'OK',
  });

  try {
    const res = await fastify.inject({
      method: 'GET',
      url: '/api/quote?from=USDC&to=NGN&amount=100',
    });

    t.equal(res.statusCode, 200, 'returns 200 OK');
    const body = res.json();
    t.equal(body.stale, false, 'body stale flag is false');
    t.equal(res.headers['x-fx-stale'], undefined, 'X-FX-Stale header omitted when stale=false');
  } finally {
    setRateCacheTimestampsForTesting(prevCache.cachedAt, prevCache.rateCachedAt);
    setRedisClientForTesting(prevRedis);
  }
  t.end();
});

test('#1049: GET /api/quote increments fx_quote_cache_write_failures_total when Redis set fails', async (t) => {
  await fastify.ready();
  const prevRedis = setRedisClientForTesting({
    set: async () => {
      throw new Error('Redis write failed');
    },
  });

  const beforeMetric = await fxQuoteCacheWriteFailuresTotal.get();
  const beforeValue = beforeMetric.values[0]?.value ?? 0;

  try {
    const res = await fastify.inject({
      method: 'GET',
      url: '/api/quote?from=USDC&to=NGN&amount=100',
    });

    t.equal(res.statusCode, 200, 'still returns 200 OK when Redis set fails');
    const body = res.json();
    t.equal(body.quoteId, null, 'quoteId is null when Redis set fails');

    const afterMetric = await fxQuoteCacheWriteFailuresTotal.get();
    const afterValue = afterMetric.values[0]?.value ?? 0;
    t.equal(afterValue, beforeValue + 1, 'fx_quote_cache_write_failures_total incremented by 1');
  } finally {
    setRedisClientForTesting(prevRedis);
  }
  t.end();
  process.exit(0);
});
