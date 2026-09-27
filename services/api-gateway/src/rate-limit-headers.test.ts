import test from 'tape';
import { buildApp } from './index.js';
import { createMockPrisma } from './test-utils.js';

test('rate-limited route: first request includes X-RateLimit-* headers with Remaining = Limit - 1', async (t) => {
  const app = buildApp({ prisma: createMockPrisma() as any, logger: false });

  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/challenge',
    payload: { address: 'GTESTADDRESS' },
  });

  const limit = Number(res.headers['x-ratelimit-limit']);
  const remaining = Number(res.headers['x-ratelimit-remaining']);

  t.ok(res.headers['x-ratelimit-limit'] !== undefined, 'X-RateLimit-Limit header is present');
  t.ok(res.headers['x-ratelimit-remaining'] !== undefined, 'X-RateLimit-Remaining header is present');
  t.ok(res.headers['x-ratelimit-reset'] !== undefined, 'X-RateLimit-Reset header is present');
  t.ok(res.headers['x-ratelimit-policy'] !== undefined, 'X-RateLimit-Policy header is present');
  t.equal(remaining, limit - 1, 'Remaining is Limit - 1 on the first request');

  await app.close();
  t.end();
});

test('rate-limited route: exhausting the limit yields Remaining = 0 with a future Reset', async (t) => {
  const app = buildApp({ prisma: createMockPrisma() as any, logger: false });

  // /api/settlements is configured with { max: 100, timeWindow: '1 minute' }.
  let last;
  for (let i = 0; i < 100; i++) {
    last = await app.inject({ method: 'GET', url: '/api/settlements' });
  }
  t.equal(Number(last!.headers['x-ratelimit-remaining']), 0, 'Remaining is 0 after exhausting the limit');
  const nowSeconds = Math.floor(Date.now() / 1000);
  t.ok(Number(last!.headers['x-ratelimit-reset']) > nowSeconds, 'Reset is a future Unix timestamp');
  t.equal(last!.headers['x-ratelimit-policy'], '1000;w=60', 'X-RateLimit-Policy emits max and window seconds');

  await app.close();
  t.end();
});

test('rate-limited route when rate limiting disabled: emits headers and does not block requests', async (t) => {
  const originalEnv = process.env.RATE_LIMIT_ENABLED;
  process.env.RATE_LIMIT_ENABLED = 'false';

  try {
    const app = buildApp({ prisma: createMockPrisma() as any, logger: false });

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/challenge',
      payload: { address: 'GTESTADDRESS' },
    });

    t.ok(res.headers['x-ratelimit-limit'] !== undefined, 'X-RateLimit-Limit header is present when disabled');
    t.ok(res.headers['x-ratelimit-remaining'] !== undefined, 'X-RateLimit-Remaining header is present when disabled');
    t.ok(res.headers['x-ratelimit-reset'] !== undefined, 'X-RateLimit-Reset header is present when disabled');
    t.ok(res.headers['x-ratelimit-policy'] !== undefined, 'X-RateLimit-Policy header is present when disabled');

    await app.close();
  } finally {
    process.env.RATE_LIMIT_ENABLED = originalEnv;
  }
  t.end();
});

test('non-rate-limited route: health endpoint omits X-RateLimit-* headers', async (t) => {
  const app = buildApp({ prisma: createMockPrisma() as any, logger: false });

  const res = await app.inject({ method: 'GET', url: '/api/health' });

  t.equal(res.headers['x-ratelimit-limit'], undefined, 'X-RateLimit-Limit is absent');
  t.equal(res.headers['x-ratelimit-remaining'], undefined, 'X-RateLimit-Remaining is absent');
  t.equal(res.headers['x-ratelimit-reset'], undefined, 'X-RateLimit-Reset is absent');
  t.equal(res.headers['x-ratelimit-policy'], undefined, 'X-RateLimit-Policy is absent');

  await app.close();
  t.end();
});
