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

const WEBHOOK_ID = 'wh_replay_test_001';
const MERCHANT_ID = 'merch_replay_001';

function makeMockPrisma() {
  const prisma = createMockPrisma() as any;
  prisma.webhookSubscription = {
    findUnique: async ({ where }: any) => {
      if (where.id === WEBHOOK_ID) {
        return { id: WEBHOOK_ID, merchantId: MERCHANT_ID, url: 'https://example.com/hook' };
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
      headers: { authorization: `Bearer ${token}` },
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
      headers: { authorization: `Bearer ${token}` },
    });

    // Second call within the 30s window — must be throttled
    const res = await app.inject({
      method: 'POST',
      url: `/api/webhooks/${WEBHOOK_ID}/test`,
      headers: { authorization: `Bearer ${token}` },
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
    const OTHER_WEBHOOK_ID = 'wh_replay_test_002';
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
      headers: { authorization: `Bearer ${token}` },
    });

    // Second webhook should still be allowed
    const resOther = await app.inject({
      method: 'POST',
      url: `/api/webhooks/${OTHER_WEBHOOK_ID}/test`,
      headers: { authorization: `Bearer ${token}` },
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
    });
    t.equal(res.statusCode, 401, 'unauthenticated caller gets 401');
  });
  t.end();
});
