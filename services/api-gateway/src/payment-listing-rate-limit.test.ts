/**
 * Issue #906 — Rate limit the payments listing endpoint.
 *
 * GET /api/payments is configured with { max: 100, timeWindow: '1 minute' }.
 * Exhausting the bucket should return 429 with standard X-RateLimit-* and
 * Retry-After headers, using the same merchant-scoped key derivation as every
 * other protected route.
 */
import test from 'tape';
import { buildApp } from './index.js';
import { createMockPrisma, generateTestJwt } from './test-utils.js';

// Suppress IP-reputation blocking that would 429 the test's own socket address
// before the per-merchant bucket is exhausted.
process.env.AUTH_IP_THRESHOLD = '1000000';

async function withApp(fn: (app: ReturnType<typeof buildApp>, token: string) => Promise<void>) {
  const app = buildApp({ prisma: createMockPrisma() as any, logger: false });
  await app.ready();
  const token = generateTestJwt(app, { merchantId: 'merchant-rate-test', ownerId: 'u-rate' });
  try {
    await fn(app, token);
  } finally {
    await app.close();
  }
}

test('GET /api/payments: returns X-RateLimit-* headers on a normal request (#906)', async (t) => {
  await withApp(async (app, token) => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/payments',
      headers: { authorization: `Bearer ${token}` },
    });

    t.ok(
      res.headers['x-ratelimit-limit'] !== undefined,
      'X-RateLimit-Limit header is present',
    );
    t.ok(
      res.headers['x-ratelimit-remaining'] !== undefined,
      'X-RateLimit-Remaining header is present',
    );
    t.ok(
      res.headers['x-ratelimit-reset'] !== undefined,
      'X-RateLimit-Reset header is present',
    );
    t.notEqual(res.statusCode, 429, 'a single request within the limit is not rejected');
  });
  t.end();
});

test('GET /api/payments: returns 429 with standard headers once the limit is exceeded (#906)', async (t) => {
  await withApp(async (app, token) => {
    const MAX = 100;
    let last: Awaited<ReturnType<typeof app.inject>> | undefined;

    // Exhaust the per-merchant bucket.
    for (let i = 0; i <= MAX; i++) {
      last = await app.inject({
        method: 'GET',
        url: '/api/payments',
        headers: { authorization: `Bearer ${token}` },
      });
    }

    t.equal(last!.statusCode, 429, 'returns 429 once the merchant bucket is exhausted');
    t.ok(
      last!.headers['x-ratelimit-limit'] !== undefined,
      'X-RateLimit-Limit header still present on 429',
    );
    t.ok(
      last!.headers['x-ratelimit-remaining'] !== undefined,
      'X-RateLimit-Remaining header still present on 429',
    );
    t.ok(
      last!.headers['retry-after'] !== undefined,
      'Retry-After header is present on 429',
    );

    const body = JSON.parse(last!.body);
    t.ok(body?.error?.code, 'response body includes an error code');
  });
  t.end();
});

test('GET /api/payments: limit is merchant-scoped, separate merchants have independent buckets (#906)', async (t) => {
  await withApp(async (app, tokenA) => {
    const tokenB = generateTestJwt(app, { merchantId: 'merchant-B', ownerId: 'u-B' });

    // Exhaust merchant-A's bucket.
    const MAX = 100;
    for (let i = 0; i <= MAX; i++) {
      await app.inject({
        method: 'GET',
        url: '/api/payments',
        headers: { authorization: `Bearer ${tokenA}` },
      });
    }

    // Merchant-B should not be affected.
    const resB = await app.inject({
      method: 'GET',
      url: '/api/payments',
      headers: { authorization: `Bearer ${tokenB}` },
    });

    t.notEqual(resB.statusCode, 429, 'merchant-B is not affected by merchant-A exhausting its bucket');
  });
  t.end();
});
