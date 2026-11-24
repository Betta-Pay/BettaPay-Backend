import test from 'tape';
import Fastify from 'fastify';
import { createAuthHardening } from './auth-hardening.js';
import {
  DEFAULT_WALLET_AUTH_MAX_FAILURES,
  DEFAULT_WALLET_AUTH_LOCKOUT_TTL_SEC,
  RECORD_FAILURE_SCRIPT,
  WalletChallengeStore,
} from './wallet-challenge-store.js';

// Issues #982, #983, #984, #985: atomic counters, a handled 429 and a header
// that is no longer trusted.

interface Entry {
  value: string;
  ttl: number | null;
}

/**
 * A Redis stand-in whose `eval` runs each script as one uninterrupted step,
 * like Redis does, after yielding so concurrent callers interleave around it.
 */
function createFakeRedis() {
  const data = new Map<string, Entry>();
  const evalCalls: string[] = [];
  return {
    data,
    evalCalls,
    async get(key: string) {
      return data.get(key)?.value ?? null;
    },
    async eval(script: string, _numKeys: number, key: string, ...args: string[]) {
      evalCalls.push(script);
      await Promise.resolve();
      if (script === RECORD_FAILURE_SCRIPT) {
        const entry = data.get(key);
        const count = (entry ? Number(entry.value) : 0) + 1;
        data.set(key, { value: String(count), ttl: entry ? entry.ttl : Number(args[0]) });
        return count;
      }
      if (script.includes('nextScore')) {
        const current = Number(data.get(key)?.value ?? '0');
        const next = Math.max(0, current + Number(args[0]));
        if (next === 0) data.delete(key);
        else data.set(key, { value: String(next), ttl: Number(args[1]) });
        return next;
      }
      throw new Error('unexpected script');
    },
  };
}

const ADDRESS = 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H';

test('concurrent recordFailure calls never lose an increment and the key has a TTL (#982)', async (t) => {
  const redis = createFakeRedis();
  const store = new WalletChallengeStore(redis as any);

  const counts = await Promise.all(Array.from({ length: 20 }, () => store.recordFailure(ADDRESS)));

  t.deepEqual([...counts].sort((a, b) => a - b), Array.from({ length: 20 }, (_, i) => i + 1), 'every increment is seen once');
  t.equal(await store.getFailureCount(ADDRESS), 20, 'the final count is 20');
  const entry = [...redis.data.values()][0];
  t.equal(entry.ttl, DEFAULT_WALLET_AUTH_LOCKOUT_TTL_SEC, 'the counter carries the lockout TTL from its first increment');
  t.end();
});

test('lockout triggers at exactly the configured threshold (#982)', async (t) => {
  const redis = createFakeRedis();
  const store = new WalletChallengeStore(redis as any);

  for (let i = 1; i < DEFAULT_WALLET_AUTH_MAX_FAILURES; i++) {
    await store.recordFailure(ADDRESS);
    t.equal(await store.isLockedOut(ADDRESS), false, `not locked out after ${i} failures`);
  }
  await store.recordFailure(ADDRESS);
  t.equal(await store.isLockedOut(ADDRESS), true, `locked out after ${DEFAULT_WALLET_AUTH_MAX_FAILURES} failures`);
  t.end();
});

test('recordWalletAuthFailure uses the same atomic script (#982)', async (t) => {
  const redis = createFakeRedis();
  const helpers = createAuthHardening(redis as any, () => 'jwt');

  const counts = await Promise.all(Array.from({ length: 5 }, () => helpers.recordWalletAuthFailure(ADDRESS)));
  t.deepEqual([...counts].sort(), [1, 2, 3, 4, 5], 'no increment is lost');
  t.ok(redis.evalCalls.every((s) => s === RECORD_FAILURE_SCRIPT), 'only the atomic script ran');
  t.end();
});

test('concurrent IP score updates never go negative or lose updates (#984)', async (t) => {
  const redis = createFakeRedis();
  const helpers = createAuthHardening(redis as any, () => 'jwt');
  const request = { ip: '203.0.113.9' } as any;

  for (let i = 0; i < 5; i++) await helpers.recordAuthIpFailure(request);
  t.equal(await helpers.getAuthIpScore('203.0.113.9'), 5, 'score starts at 5');

  await Promise.all([
    ...Array.from({ length: 5 }, () => helpers.recordAuthIpSuccess(request)),
    ...Array.from({ length: 5 }, () => helpers.recordAuthIpFailure(request)),
  ]);
  t.equal(await helpers.getAuthIpScore('203.0.113.9'), 5, 'five up and five down leave the score at 5');
  t.equal([...redis.data.values()][0].ttl, 15 * 60, 'the TTL is refreshed with the score');
  t.end();
});

test('IP score is clamped at zero and the key is removed (#984)', async (t) => {
  const redis = createFakeRedis();
  const helpers = createAuthHardening(redis as any, () => 'jwt');
  const request = { ip: '203.0.113.10' } as any;

  await helpers.recordAuthIpFailure(request);
  await Promise.all(Array.from({ length: 4 }, () => helpers.recordAuthIpSuccess(request)));
  t.equal(await helpers.getAuthIpScore('203.0.113.10'), 0, 'the score never drops below zero');
  t.equal(redis.data.size, 0, 'a zero score leaves no key behind');
  t.end();
});

async function ipReputationApp(score: number) {
  const redis = createFakeRedis();
  redis.data.set('auth_ip_score:127.0.0.1', { value: String(score), ttl: 900 });
  const helpers = createAuthHardening(redis as any, () => 'jwt');
  const app = Fastify();
  let handlerCalls = 0;
  app.post('/auth', { preHandler: [helpers.enforceAuthIpReputation] }, async () => {
    handlerCalls += 1;
    return { ok: true };
  });
  await app.ready();
  return { app, calls: () => handlerCalls };
}

test('a blocked IP gets 429 and the route handler never runs (#983)', async (t) => {
  const { app, calls } = await ipReputationApp(20);
  try {
    const res = await app.inject({ method: 'POST', url: '/auth' });
    t.equal(res.statusCode, 429, 'blocked with 429');
    t.equal(res.headers['retry-after'], '300', 'Retry-After is set');
    t.equal(calls(), 0, 'the handler was short-circuited');
  } finally {
    await app.close();
    t.end();
  }
});

test('an IP below the threshold still reaches the handler (#983)', async (t) => {
  const { app, calls } = await ipReputationApp(3);
  try {
    const res = await app.inject({ method: 'POST', url: '/auth' });
    t.equal(res.statusCode, 200, 'allowed');
    t.equal(calls(), 1, 'the handler ran once');
  } finally {
    await app.close();
    t.end();
  }
});
