import test from 'tape';
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
