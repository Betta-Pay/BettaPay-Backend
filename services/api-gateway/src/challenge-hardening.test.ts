import test from 'tape';
import { createTestApp } from './test-utils.js';
import { MOCK_STELLAR_KEY_1, MOCK_STELLAR_KEY_2 } from './test-fixtures.js';

// Issue #992 — POST /api/auth/challenge must reject malformed addresses and
// stop one address from generating unbounded challenges.

function createFakeRedis() {
  const store = new Map<string, string>();
  const counters = new Map<string, number>();
  return {
    store,
    async get(key: string) {
      return store.get(key) ?? null;
    },
    async set(key: string, value: string) {
      store.set(key, value);
      return 'OK';
    },
    async del(key: string) {
      return store.delete(key) ? 1 : 0;
    },
    async getdel(key: string) {
      const value = store.get(key) ?? null;
      store.delete(key);
      return value;
    },
    async incr(key: string) {
      const next = (counters.get(key) ?? 0) + 1;
      counters.set(key, next);
      return next;
    },
    async incrby(key: string, by: number) {
      const next = (counters.get(key) ?? 0) + by;
      counters.set(key, next);
      return next;
    },
    async expire() {
      return 1;
    },
    async eval() {
      return null;
    },
    async quit() {},
    disconnect() {},
  };
}

async function setup() {
  const { app } = await createTestApp({
    redis: createFakeRedis() as any,
    domainEventsQueue: { add: async () => ({}) } as any,
  });
  const challenge = (address: unknown) =>
    app.inject({
      method: 'POST',
      url: '/api/auth/challenge',
      headers: { 'x-csrf-check': '1' },
      payload: { address },
    });
  return { app, challenge };
}

test('invalid Stellar addresses get 400 on /api/auth/challenge (#992)', async (t) => {
  const { app, challenge } = await setup();
  try {
    for (const bad of ['GTESTADDRESS', 'not-an-address', MOCK_STELLAR_KEY_1.slice(0, -1) + 'A', '']) {
      const res = await challenge(bad);
      t.equal(res.statusCode, 400, `rejects ${JSON.stringify(bad)}`);
    }
  } finally {
    await app.close();
    t.end();
  }
});

test('valid Stellar addresses still receive a challenge (#992)', async (t) => {
  const { app, challenge } = await setup();
  try {
    const res = await challenge(MOCK_STELLAR_KEY_1);
    t.equal(res.statusCode, 200, 'a challenge is issued');
    t.ok(JSON.parse(res.body).challenge, 'the challenge is returned');
  } finally {
    await app.close();
    t.end();
  }
});

test('excessive challenge requests for one address return 429 (#992)', async (t) => {
  const { app, challenge } = await setup();
  try {
    for (let i = 0; i < 10; i++) {
      const res = await challenge(MOCK_STELLAR_KEY_1);
      t.equal(res.statusCode, 200, `request ${i + 1} is allowed`);
    }
    const limited = await challenge(MOCK_STELLAR_KEY_1);
    t.equal(limited.statusCode, 429, 'the 11th request is rate-limited');
    t.ok(limited.headers['retry-after'], 'Retry-After is set');

    const other = await challenge(MOCK_STELLAR_KEY_2);
    t.equal(other.statusCode, 200, 'a different address is not rate-limited');
  } finally {
    await app.close();
    t.end();
  }
});
