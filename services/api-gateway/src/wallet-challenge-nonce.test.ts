/**
 * wallet-challenge-nonce.test.ts (issue #875)
 *
 * Wallet nonce tracking rejects replay, accepts fresh nonces, and allows
 * reuse only after the TTL window. Drives a fake Redis client so the exact
 * used-nonce key and expiry are asserted.
 */
import test from 'tape';
import { createAuthHardening } from './auth-hardening.js';
import { WalletChallengeStore } from './wallet-challenge-store.js';

const USED_NONCE_TTL_SECONDS = 5 * 60;

interface FakeEntry {
  v: string;
  exp: number | null;
}

interface FakeRedis {
  data: Map<string, FakeEntry>;
  setCalls: Array<{ key: string; value: string; args: unknown[] }>;
  evalCalls: Array<{ script: string; numKeys: number; args: string[] }>;
  set: (key: string, value: string, ...rest: unknown[]) => Promise<unknown>;
  exists: (key: string) => Promise<number>;
  eval: (script: string, numKeys: number, ...args: string[]) => Promise<unknown>;
}

function createFakeRedis(): FakeRedis {
  const data = new Map<string, FakeEntry>();
  const setCalls: FakeRedis['setCalls'] = [];
  const evalCalls: FakeRedis['evalCalls'] = [];
  const now = () => Date.now();

  function getLive(key: string): FakeEntry | null {
    const entry = data.get(key);
    if (!entry) return null;
    if (entry.exp !== null && now() >= entry.exp) {
      data.delete(key);
      return null;
    }
    return entry;
  }

  const redis: FakeRedis = {
    data,
    setCalls,
    evalCalls,
    async set(key, value, ...rest) {
      setCalls.push({ key, value, args: rest });
      let exp: number | null = null;
      const modeIdx = rest.findIndex((a) => a === 'EX' || a === 'PX');
      if (modeIdx !== -1) {
        const ttl = Number(rest[modeIdx + 1]);
        exp = now() + (rest[modeIdx] === 'EX' ? ttl * 1000 : ttl);
      }
      const nx = rest.includes('NX');
      if (nx && getLive(key)) return null;
      data.set(key, { v: value, exp });
      return 'OK';
    },
    async exists(key) {
      return getLive(key) ? 1 : 0;
    },
    async eval(script, _numKeys, ...args) {
      evalCalls.push({ script, numKeys: _numKeys, args });
      const key = args[0];
      // Wallet-challenge consume script (exists + get + del).
      if (script.includes('exists')) {
        const entry = getLive(key);
        if (!entry) return null;
        data.delete(key);
        return entry.v;
      }
      // Compare-and-delete release script.
      const member = args[1];
      const entry = getLive(key);
      if (!entry) return 0;
      if (entry.v === member) {
        data.delete(key);
        return 1;
      }
      return 0;
    },
  };
  return redis;
}

function createLogger() {
  return { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} };
}

function createHelpers(redis: FakeRedis) {
  return createAuthHardening(redis as any, () => 'test-jwt');
}

test('#875: a nonce consumed once is rejected on a second use within the TTL window', async (t) => {
  const redis = createFakeRedis();
  const helpers = createHelpers(redis);

  t.equal(await helpers.isNonceUsed('nonce-1'), false, 'fresh nonce is not yet used');
  t.equal(await helpers.markNonceUsed('nonce-1'), true, 'first consumption succeeds');
  t.equal(await helpers.isNonceUsed('nonce-1'), true, 'nonce is now marked used');
  t.equal(await helpers.markNonceUsed('nonce-1'), false, 'second consumption within the window is rejected');
  t.end();
});

test('#875: a previously unseen nonce is accepted', async (t) => {
  const redis = createFakeRedis();
  const helpers = createHelpers(redis);

  t.equal(await helpers.isNonceUsed('never-seen'), false, 'unseen nonce is not used');
  t.equal(await helpers.markNonceUsed('never-seen'), true, 'unseen nonce is accepted');
  t.end();
});

test('#875: the used-nonce marker is stored under the documented key with the configured TTL', async (t) => {
  const redis = createFakeRedis();
  const helpers = createHelpers(redis);

  await helpers.markNonceUsed('ttl-nonce');

  t.equal(redis.setCalls.length, 1, 'one SET call');
  t.equal(redis.setCalls[0].key, 'used_nonce:ttl-nonce', 'key is used_nonce:<nonce>');
  t.deepEqual(
    redis.setCalls[0].args,
    ['1', 'EX', USED_NONCE_TTL_SECONDS, 'NX'],
    'value 1 written with EX <5 min> NX',
  );
  t.end();
});

test('#875: reuse is permitted after the TTL window has elapsed', async (t) => {
  const redis = createFakeRedis();
  const helpers = createHelpers(redis);

  await helpers.markNonceUsed('expiring-nonce');
  t.equal(await helpers.isNonceUsed('expiring-nonce'), true, 'used within the window');

  // Simulate the TTL elapsing.
  const entry = redis.data.get('used_nonce:expiring-nonce');
  if (entry) entry.exp = Date.now() - 1;

  t.equal(await helpers.isNonceUsed('expiring-nonce'), false, 'marker reaped after TTL');
  t.equal(await helpers.markNonceUsed('expiring-nonce'), true, 'same nonce accepted again after TTL');
  t.end();
});

test('#875: the challenge store consumes a challenge so it cannot be replayed', async (t) => {
  const redis = createFakeRedis();
  const store = new WalletChallengeStore(redis as any);

  const issued = await store.issue('GCRADDRESS');
  const first = await store.consume('GCRADDRESS');
  t.equal(first.status, 'valid', 'first consume returns the challenge');
  if (first.status === 'valid') {
    t.equal(first.challenge.challenge, issued.challenge, 'returns the exact issued challenge');
  }

  const second = await store.consume('GCRADDRESS');
  t.equal(second.status, 'not_found', 'replayed consume fails — challenge was deleted');
  t.end();
});

test('#875: the challenge store writes under the documented key with the TTL in PX mode', async (t) => {
  const redis = createFakeRedis();
  const store = new WalletChallengeStore(redis as any);

  await store.issue('GADDRESS2');

  t.equal(redis.setCalls.length, 1, 'one SET call');
  t.equal(redis.setCalls[0].key, 'wallet_challenge:GADDRESS2', 'key is wallet_challenge:<address>');
  const [, , mode, ttlMs] = redis.setCalls[0].args as [string, string, string, number];
  t.equal(mode, 'PX', 'expiry mode is PX');
  t.equal(ttlMs, 2 * 60 * 1000, 'TTL is the documented 2-minute challenge window');
  t.end();
});
