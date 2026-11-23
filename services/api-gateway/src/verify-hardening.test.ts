import test from 'tape';
import { Keypair } from '@stellar/stellar-sdk';
import { createMockPrisma, createTestApp } from './test-utils.js';

// Issue #993 — POST /api/auth/verify must apply IP reputation and rate limits,
// issue tokens with a jti, and create merchants with a collision-resistant ownerId.

function createFakeRedis() {
  const store = new Map<string, string>();
  const counters = new Map<string, number>();
  const zsets = new Map<string, Array<{ score: number; member: string }>>();
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
    async eval(_script: string, _numKeys: number, key: string) {
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
    async zadd(key: string, score: number, member: string) {
      const set = zsets.get(key) ?? [];
      set.push({ score, member });
      zsets.set(key, set);
      return 1;
    },
    async zcard(key: string) {
      return (zsets.get(key) ?? []).length;
    },
    async zrange() {
      return [] as string[];
    },
    async zrem() {
      return 0;
    },
    async quit() {},
    disconnect() {},
  };
}

async function setup(redis = createFakeRedis()) {
  const prisma = createMockPrisma() as any;
  const created: Array<Record<string, any>> = [];
  prisma.merchant.upsert = async ({ where, create }: { where: { id: string }; create: any }) => {
    const merchant = { ...create, id: where.id, deletedAt: null, status: 'active' };
    created.push(merchant);
    return merchant;
  };
  const { app } = await createTestApp({
    prisma,
    redis: redis as any,
    domainEventsQueue: { add: async () => ({}) } as any,
  });
  return { app, redis, created };
}

const csrf = { 'x-csrf-check': '1' };

test('verify issues a jti and a long collision-resistant ownerId (#993)', async (t) => {
  const { app, created } = await setup();
  try {
    const keypair = Keypair.random();
    const address = keypair.publicKey();
    const challengeRes = await app.inject({
      method: 'POST',
      url: '/api/auth/challenge',
      headers: csrf,
      payload: { address },
    });
    const { challenge } = JSON.parse(challengeRes.body);

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/verify',
      headers: csrf,
      payload: { address, signature: keypair.sign(Buffer.from(challenge)).toString('hex') },
    });
    t.equal(res.statusCode, 200, 'a correctly signed challenge is accepted');

    const claims = app.jwt.decode(JSON.parse(res.body).token) as Record<string, any>;
    t.equal(typeof claims.jti, 'string', 'the token carries a jti claim');
    t.ok(claims.jti.length >= 32, 'the jti is a 128-bit identifier');
    t.equal(created.length, 1, 'a merchant was created');
    t.ok(created[0].ownerId.length > 'owner-abcdef'.length, 'ownerId is longer than 6 chars');
    t.match(created[0].ownerId, /^owner-[0-9a-f-]{36}$/, 'ownerId embeds a full UUID');
  } finally {
    await app.close();
    t.end();
  }
});

test('verify refuses IPs with a bad reputation (#993)', async (t) => {
  const redis = createFakeRedis();
  redis.store.set('auth_ip_score:127.0.0.1', '1000');
  const { app } = await setup(redis);
  try {
    const keypair = Keypair.random();
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/verify',
      headers: csrf,
      payload: { address: keypair.publicKey(), signature: 'aa'.repeat(64) },
    });
    t.equal(res.statusCode, 429, 'blocked by IP reputation');
  } finally {
    await app.close();
    t.end();
  }
});

test('verify is rate-limited per client (#993)', async (t) => {
  const { app } = await setup();
  try {
    const keypair = Keypair.random();
    const call = () =>
      app.inject({
        method: 'POST',
        url: '/api/auth/verify',
        headers: csrf,
        payload: { address: keypair.publicKey(), signature: 'aa'.repeat(64) },
      });
    const codes: number[] = [];
    for (let i = 0; i < 40; i++) codes.push((await call()).statusCode);
    t.ok(codes.includes(429), 'excessive attempts are limited with 429');
  } finally {
    await app.close();
    t.end();
  }
});
