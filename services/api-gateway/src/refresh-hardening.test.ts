import test from 'tape';
import { createTestApp } from './test-utils.js';
import { MOCK_MERCHANT_ACTIVE, MOCK_MERCHANT_DELETED, MOCK_MERCHANT_SUSPENDED } from './test-fixtures.js';

// Issue #991 — refresh must claim the jti atomically and refuse merchants that
// were suspended or soft-deleted after the token was issued.

function createFakeRedis() {
  const store = new Map<string, string>();
  const counters = new Map<string, number>();
  return {
    store,
    async get(key: string) {
      return store.get(key) ?? null;
    },
    async exists(key: string) {
      return store.has(key) ? 1 : 0;
    },
    async set(key: string, value: string, ...args: unknown[]) {
      // Yield first so concurrent callers interleave around the read-then-write.
      await Promise.resolve();
      if (args.includes('NX') && store.has(key)) return null;
      store.set(key, value);
      return 'OK';
    },
    async del(key: string) {
      return store.delete(key) ? 1 : 0;
    },
    async incr(key: string) {
      const next = (counters.get(key) ?? 0) + 1;
      counters.set(key, next);
      return next;
    },
    async decr(key: string) {
      const next = (counters.get(key) ?? 0) - 1;
      counters.set(key, next);
      return next;
    },
    async expire() {
      return 1;
    },
    async eval() {
      return 0;
    },
    async quit() {},
    disconnect() {},
  };
}

async function setup(merchant: Record<string, unknown>) {
  const redis = createFakeRedis();
  const { app } = await createTestApp(
    { redis: redis as any, domainEventsQueue: { add: async () => ({}) } as any },
    { merchants: [{ ...merchant }] },
  );
  const token = app.jwt.sign(
    { merchantId: merchant.id, ownerId: merchant.ownerId, jti: 'jti-refresh-1' },
    { expiresIn: '1h' },
  );
  const refresh = () =>
    app.inject({
      method: 'POST',
      url: '/api/auth/refresh',
      headers: { authorization: `Bearer ${token}` },
    });
  return { app, refresh };
}

test('concurrent refreshes with the same jti succeed at most once (#991)', async (t) => {
  const { app, refresh } = await setup(MOCK_MERCHANT_ACTIVE);
  try {
    const results = await Promise.all([refresh(), refresh(), refresh(), refresh()]);
    const codes = results.map((r) => r.statusCode);
    t.equal(codes.filter((c) => c === 200).length, 1, 'exactly one refresh succeeds');
    t.ok(
      codes.filter((c) => c !== 200).every((c) => c === 401),
      'the replays are rejected with 401',
    );
  } finally {
    await app.close();
    t.end();
  }
});

test('suspended merchants get 403 on /api/auth/refresh (#991)', async (t) => {
  const { app, refresh } = await setup(MOCK_MERCHANT_SUSPENDED);
  try {
    const res = await refresh();
    t.equal(res.statusCode, 403, 'suspended merchant is forbidden');
  } finally {
    await app.close();
    t.end();
  }
});

test('soft-deleted merchants get 403 on /api/auth/refresh (#991)', async (t) => {
  const { app, refresh } = await setup(MOCK_MERCHANT_DELETED);
  try {
    const res = await refresh();
    t.equal(res.statusCode, 403, 'soft-deleted merchant is forbidden');
  } finally {
    await app.close();
    t.end();
  }
});
