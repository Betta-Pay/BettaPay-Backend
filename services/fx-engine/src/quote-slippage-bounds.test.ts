process.env.NODE_ENV = 'test';
process.env.RATES_API_URL = 'http://localhost:1234';
process.env.REDIS_URL = 'redis://localhost:6379';
process.env.INTER_SERVICE_SECRET = 'test-secret-that-is-at-least-16-chars';
process.env.MAX_STALE_SECONDS = '300';
process.env.LOG_LEVEL = 'silent';

import test from 'tape';

const { fastify } = await import('./index.js');

// Issue #620 — a merchant submitting an out-of-range slippageBps used to be
// silently clamped to env.MAX_SLIPPAGE_BPS with no error signal. It must now
// be rejected with 400 instead.

test('GET /api/quote rejects slippageBps=10000 (100%) with 400', async (t) => {
  await fastify.ready();

  const res = await fastify.inject({
    method: 'GET',
    url: '/api/quote?from=USDC&to=NGN&amount=100&slippageBps=10000',
  });

  t.equal(res.statusCode, 400, 'rejects slippageBps above the allowed 0-1000 range');
  t.end();
});

test('GET /api/quote accepts slippageBps within the allowed range and echoes slippageLimit', async (t) => {
  const res = await fastify.inject({
    method: 'GET',
    url: '/api/quote?from=USDC&to=NGN&amount=100&slippageBps=250',
  });

  t.equal(res.statusCode, 200, 'accepts an in-range slippageBps');
  const body = JSON.parse(res.body);
  t.equal(body.slippageBps, 250, 'echoes the validated slippageBps');
  t.equal(body.slippageLimit, (250 / 10_000).toFixed(4), 'slippageLimit matches slippageBps/10000');

  t.end();
  process.exit(0);
});
