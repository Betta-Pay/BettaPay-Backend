import test from 'tape';
import {
  RECORD_FAILURE_SCRIPT,
  WalletChallengeStore,
  walletAuthFailKey,
} from './wallet-challenge-store.js';

// Follow-up coverage for #982: the failure counter is one script, with the TTL set on the first increment.

const A = 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H';
const B = 'GDQP2KPQGKIHYJGXNUIYOMHARUARCA7DJT5FO2FFOOKY3B2WSQHG4W37';

function recordingRedis(counter = 0) {
  const calls: { script: string; numKeys: number; args: string[] }[] = [];
  return {
    calls,
    async set() {},
    async del() {},
    async eval(script: string, numKeys: number, ...args: string[]) {
      calls.push({ script, numKeys, args });
      counter += 1;
      return counter;
    },
  };
}

test('the failure script increments and expires inside one script, only on the first increment (#982)', (t) => {
  const script = RECORD_FAILURE_SCRIPT.replace(/\s+/g, ' ');
  t.ok(script.includes("redis.call('INCR', KEYS[1])"), 'increments the counter');
  t.ok(
    /if count == 1 then redis\.call\('EXPIRE', KEYS\[1\], tonumber\(ARGV\[1\]\)\) end/.test(script),
    'sets the TTL only when the counter was just created',
  );
  t.end();
});

test('recordFailure makes exactly one atomic call with the key and TTL (#982)', async (t) => {
  const redis = recordingRedis();
  const store = new WalletChallengeStore(redis as any);

  const count = await store.recordFailure(A, 90);

  t.equal(count, 1, 'returns the new count as a number');
  t.equal(redis.calls.length, 1, 'one round trip');
  t.deepEqual(redis.calls[0], {
    script: RECORD_FAILURE_SCRIPT,
    numKeys: 1,
    args: [walletAuthFailKey(A), '90'],
  }, 'the key and the TTL in seconds are passed to the script');
  t.end();
});

test('recordFailure has no non-atomic fallback when the script fails (#982)', async (t) => {
  const touched: string[] = [];
  const redis = {
    async set() { touched.push('set'); },
    async del() {},
    async get() { touched.push('get'); return null; },
    async incr() { touched.push('incr'); return 1; },
    async expire() { touched.push('expire'); },
    async eval() { throw new Error('redis down'); },
  };
  const store = new WalletChallengeStore(redis as any);

  try {
    await store.recordFailure(A);
    t.fail('expected the failure to propagate');
  } catch (error) {
    t.equal((error as Error).message, 'redis down', 'the error is not swallowed');
  }
  t.deepEqual(touched, [], 'no get/set or incr/expire fallback was attempted');
  t.end();
});

test('failure counters are kept per address (#982)', async (t) => {
  const counters = new Map<string, number>();
  const redis = {
    async set() {},
    async del() {},
    async get(key: string) { return counters.has(key) ? String(counters.get(key)) : null; },
    async eval(_script: string, _n: number, key: string) {
      const next = (counters.get(key) ?? 0) + 1;
      counters.set(key, next);
      return next;
    },
  };
  const store = new WalletChallengeStore(redis as any);

  await Promise.all([store.recordFailure(A), store.recordFailure(A), store.recordFailure(B)]);

  t.equal(await store.getFailureCount(A), 2, 'A has two failures');
  t.equal(await store.getFailureCount(B), 1, 'B has one failure');
  t.equal(await store.isLockedOut(A, 2), true, 'A reaches a threshold of 2');
  t.equal(await store.isLockedOut(B, 2), false, 'B does not');
  t.end();
});
