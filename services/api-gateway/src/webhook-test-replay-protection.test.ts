/**
 * Issue #909 — Replay protection for the webhook test endpoint.
 *
 * POST /api/webhooks/:id/test is throttled to one call per 30 seconds per
 * (merchantId, webhookId) pair. A second call within the window must receive
 * 429 with a Retry-After header so the endpoint cannot be used to flood a
 * merchant's destination URL.
 */
import test from 'tape';
import { buildApp } from './index.js';
import { createMockPrisma, generateTestJwt } from './test-utils.js';

process.env.AUTH_IP_THRESHOLD = '1000000';

const WEBHOOK_ID = '11111111-1111-4111-a111-111111111111';
const OTHER_WEBHOOK_ID = '22222222-2222-4222-a222-222222222222';
const MERCHANT_ID = 'merch_replay_001';

function makeMockPrisma() {
  const prisma = createMockPrisma() as any;
  prisma.webhookSubscription = {
    findUnique: async ({ where }: any) => {
      if (where.id === WEBHOOK_ID || where.id === OTHER_WEBHOOK_ID) {
        return { id: where.id, merchantId: MERCHANT_ID, url: 'https://example.com/hook' };
      }
      return null;
    },
  };
  return prisma;
}

// Minimal Redis stub with NX-aware SET
function makeFakeRedis() {
  const store = new Map<string, string>();
  return {
    get: async (key: string) => store.get(key) ?? null,
    set: async (key: string, value: string, ...args: any[]) => {
      const hasNX = args.some((a) => a === 'NX');
      if (hasNX && store.has(key)) return null;
      store.set(key, value);
      return 'OK';
    },
    del: async (key: string) => {
      store.delete(key);
      return 1;
    },
    quit: async () => {},
    disconnect: () => {},
    store,
  };
}

async function withApp(fn: (app: ReturnType<typeof buildApp>, token: string, redis: ReturnType<typeof makeFakeRedis>) => Promise<void>) {
  const prisma = makeMockPrisma();
  const redis = makeFakeRedis();
  const app = buildApp({ prisma, redis: redis as any, logger: false });
  await app.ready();
  const token = generateTestJwt(app, { merchantId: MERCHANT_ID, ownerId: 'u-replay' });
  try {
    await fn(app, token, redis);
  } finally {
    await app.close();
  }
}

test('#909: first POST /api/webhooks/:id/test call within the window is not 429', async (t) => {
  await withApp(async (app, token) => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/webhooks/${WEBHOOK_ID}/test`,
      headers: { authorization: `Bearer ${token}`, 'x-csrf-check': '1' },
    });
    t.notEqual(res.statusCode, 429, 'first call is not throttled');
  });
  t.end();
});

test('#909: second POST /api/webhooks/:id/test call within the window returns 429', async (t) => {
  await withApp(async (app, token) => {
    // First call — should pass through
    await app.inject({
      method: 'POST',
      url: `/api/webhooks/${WEBHOOK_ID}/test`,
      headers: { authorization: `Bearer ${token}`, 'x-csrf-check': '1' },
    });

    // Second call within the 30s window — must be throttled
    const res = await app.inject({
      method: 'POST',
      url: `/api/webhooks/${WEBHOOK_ID}/test`,
      headers: { authorization: `Bearer ${token}`, 'x-csrf-check': '1' },
    });
    t.equal(res.statusCode, 429, 'second call within the window returns 429');
    t.ok(
      res.headers['retry-after'] !== undefined,
      'Retry-After header is present on 429',
    );
  });
  t.end();
});

test('#909: throttle is per-webhook — a different webhook ID has its own window', async (t) => {
  await withApp(async (app, token, redis) => {
    (app as any).prisma = {
      ...makeMockPrisma(),
      webhookSubscription: {
        findUnique: async ({ where }: any) => {
          if (where.id === WEBHOOK_ID || where.id === OTHER_WEBHOOK_ID) {
            return { id: where.id, merchantId: MERCHANT_ID, url: 'https://example.com/hook' };
          }
          return null;
        },
      },
    };

    // Exhaust the first webhook's window
    await app.inject({
      method: 'POST',
      url: `/api/webhooks/${WEBHOOK_ID}/test`,
      headers: { authorization: `Bearer ${token}`, 'x-csrf-check': '1' },
    });

    // Second webhook should still be allowed
    const resOther = await app.inject({
      method: 'POST',
      url: `/api/webhooks/${OTHER_WEBHOOK_ID}/test`,
      headers: { authorization: `Bearer ${token}`, 'x-csrf-check': '1' },
    });
    t.notEqual(resOther.statusCode, 429, 'a different webhook ID has an independent window');
  });
  t.end();
});

test('#909: unauthenticated request is rejected with 401 before replay check', async (t) => {
  await withApp(async (app) => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/webhooks/${WEBHOOK_ID}/test`,
      headers: { 'x-csrf-check': '1' },
    });
    t.equal(res.statusCode, 401, 'unauthenticated caller gets 401');
  });
  t.end();
});

test('POST /api/webhooks/:id/test: rejects invalid :id values with HTTP 400 without calling indexer', async (t) => {
  let indexerCalled = false;
  const prisma = makeMockPrisma();
  const redis = makeFakeRedis();
  const mockIndexer = {
    getPaymentEvents: async () => [],
    testWebhook: async () => {
      indexerCalled = true;
      return { success: true, statusCode: 200 };
    },
  };
  const app = buildApp({
    prisma,
    redis: redis as any,
    indexerClient: mockIndexer as any,
    logger: false,
  });
  await app.ready();
  const token = generateTestJwt(app, { merchantId: MERCHANT_ID, ownerId: 'u-replay' });

  try {
    const invalidIds = ['not-a-uuid', '123', 'invalid-uuid-format', 'wh_test_123', 'undefined'];
    for (const invalidId of invalidIds) {
      const res = await app.inject({
        method: 'POST',
        url: `/api/webhooks/${invalidId}/test`,
        headers: { authorization: `Bearer ${token}`, 'x-csrf-check': '1' },
      });
      t.equal(res.statusCode, 400, `returns 400 for invalid id: ${invalidId}`);
      const body = JSON.parse(res.body);
      t.ok(body.error, 'error envelope returned');
    }
    t.equal(indexerCalled, false, 'indexer service was never called for invalid ids');
  } finally {
    await app.close();
  }
  t.end();
});

test('POST /api/webhooks/:id/test: valid UUID proxies normally to indexer service', async (t) => {
  let indexerCalledWith: { id: string; merchantId: string } | null = null;
  const prisma = makeMockPrisma();
  const redis = makeFakeRedis();
  const mockIndexer = {
    getPaymentEvents: async () => [],
    testWebhook: async (id: string, merchantId: string) => {
      indexerCalledWith = { id, merchantId };
      return { success: true, statusCode: 200 };
    },
  };
  const app = buildApp({
    prisma,
    redis: redis as any,
    indexerClient: mockIndexer as any,
    logger: false,
  });
  await app.ready();
  const token = generateTestJwt(app, { merchantId: MERCHANT_ID, ownerId: 'u-replay' });

  try {
    const res = await app.inject({
      method: 'POST',
      url: `/api/webhooks/${WEBHOOK_ID}/test`,
      headers: { authorization: `Bearer ${token}`, 'x-csrf-check': '1' },
    });
    t.equal(res.statusCode, 200, 'returns 200 for valid UUID id');
    t.ok(indexerCalledWith !== null, 'indexer service was called');
    t.equal(indexerCalledWith?.id, WEBHOOK_ID, 'indexer was called with correct webhook id');
    t.equal(indexerCalledWith?.merchantId, MERCHANT_ID, 'indexer was called with correct merchant id');
  } finally {
    await app.close();
  }
  t.end();
});
