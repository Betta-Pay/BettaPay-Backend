/**
 * Issue #903 — Expire wallet challenges on logout.
 *
 * discard() is called on the WalletChallengeStore during logout so a stale
 * challenge cannot be replayed after session termination.
 */
import test from 'tape';
import {
  WalletChallengeStore,
  walletChallengeKey,
  type WalletChallengeRedis,
} from './wallet-challenge-store.js';

const ADDRESS = 'GABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890TESTADDR';

function fakeRedis() {
  const store = new Map<string, string>();
  const redis: WalletChallengeRedis = {
    async set(key, value, _mode, _ttlMs) {
      store.set(key, value);
      return 'OK';
    },
    async eval(_script, _numKeys, ...args) {
      const key = args[0];
      const v = store.get(key) ?? null;
      store.delete(key);
      return v;
    },
    async del(key) {
      store.delete(key);
      return 1;
    },
  };
  return { redis, store };
}

test('#903: discard() removes an outstanding challenge (simulating logout)', async (t) => {
  const { redis, store } = fakeRedis();
  const challengeStore = new WalletChallengeStore(redis);

  await challengeStore.issue(ADDRESS);
  t.ok(store.has(walletChallengeKey(ADDRESS)), 'challenge is stored before logout');

  // Simulate what the logout route does.
  await challengeStore.discard(ADDRESS);

  t.notOk(store.has(walletChallengeKey(ADDRESS)), 'challenge key is gone after discard');
  t.end();
});

test('#903: a challenge verified after discard fails with not_found', async (t) => {
  const { redis } = fakeRedis();
  const challengeStore = new WalletChallengeStore(redis);

  await challengeStore.issue(ADDRESS);
  await challengeStore.discard(ADDRESS);

  const result = await challengeStore.consume(ADDRESS);
  t.equal(result.status, 'not_found', 'post-logout consume returns not_found');
  t.end();
});

test('#903: discard() is idempotent when no challenge exists (logout with no outstanding challenge)', async (t) => {
  const { redis } = fakeRedis();
  const challengeStore = new WalletChallengeStore(redis);

  // No challenge was ever issued.
  await challengeStore.discard(ADDRESS).then(
    () => t.pass('discard resolves when no challenge is outstanding'),
    (err) => t.fail(`unexpected rejection: ${err}`),
  );
  t.end();
});

test('#903: issuing a new challenge after discard works normally', async (t) => {
  const { redis } = fakeRedis();
  const challengeStore = new WalletChallengeStore(redis);

  await challengeStore.issue(ADDRESS);
  await challengeStore.discard(ADDRESS);

  const reissued = await challengeStore.issue(ADDRESS);
  t.ok(reissued.challenge, 'a fresh challenge can be issued after logout');

  const consumed = await challengeStore.consume(ADDRESS);
  t.equal(consumed.status, 'valid', 'the reissued challenge is valid');
  t.end();
});
