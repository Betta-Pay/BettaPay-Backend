import test from 'tape';
import {
  WalletChallengeStore,
  WALLET_AUTH_LOCKOUT_KEY_PREFIX,
  DEFAULT_WALLET_AUTH_MAX_FAILURES,
  DEFAULT_WALLET_AUTH_LOCKOUT_TTL_SEC,
  walletAuthFailKey,
  type WalletChallengeRedis,
} from './wallet-challenge-store.js';
import { createMockPrisma, createTestApp } from './test-utils.js';
import { ErrorCodes } from '@bettapay/validation';

const TEST_WALLET_ADDRESS = 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H';

function createMockRedis(startTime = 1_700_000_000_000) {
  const store = new Map<string, { value: string; expiresAt: number }>();
  let now = startTime;

  function isLive(key: string) {
    const entry = store.get(key);
    if (!entry) return null;
    if (now >= entry.expiresAt) {
      store.delete(key);
      return null;
    }
    return entry;
  }

  const redis: WalletChallengeRedis & {
    raw: typeof store;
    advanceTime: (ms: number) => void;
    expireCalls: Array<{ key: string; seconds: number }>;
  } = {
    raw: store,
    expireCalls: [],
    advanceTime: (ms: number) => {
      now += ms;
    },
    async get(key: string) {
      const entry = isLive(key);
      return entry ? entry.value : null;
    },
    async set(key: string, value: string, mode?: string, ttl?: number) {
      const ttlMs = mode === 'PX' && ttl ? ttl : (mode === 'EX' && ttl ? ttl * 1000 : 3600_000);
      store.set(key, { value: String(value), expiresAt: now + ttlMs });
      return 'OK';
    },
    async incr(key: string) {
      const entry = isLive(key);
      const current = entry ? parseInt(entry.value, 10) : 0;
      const next = current + 1;
      const ttlMs = entry ? (entry.expiresAt - now) : DEFAULT_WALLET_AUTH_LOCKOUT_TTL_SEC * 1000;
      store.set(key, { value: String(next), expiresAt: now + ttlMs });
      return next;
    },
    async expire(key: string, seconds: number) {
      redis.expireCalls.push({ key, seconds });
      const entry = isLive(key);
      if (entry) {
        entry.expiresAt = now + seconds * 1000;
        return 1;
      }
      return 0;
    },
    async del(key: string) {
      store.delete(key);
      return 1;
    },
    async eval(_script: string, _numKeys: number, ...args: any[]) {
      const key = args[0];
      const entry = isLive(key);
      store.delete(key);
      return entry ? entry.value : null;
    },
    async quit() {
      return 'OK';
    },
    async disconnect() {
      return 'OK';
    },
  };

  return { redis, getClock: () => now };
}

test('WalletChallengeStore lockout: tracks failures and triggers lockout at threshold (#902)', async (t) => {
  const { redis, getClock } = createMockRedis();
  const store = new WalletChallengeStore(redis, { now: getClock });

  // 1. Initially 0 failures and not locked out
  t.equal(await store.getFailureCount(TEST_WALLET_ADDRESS), 0, 'initial failure count is 0');
  t.equal(await store.isLockedOut(TEST_WALLET_ADDRESS), false, 'not locked out initially');

  // 2. Incremental failures up to threshold - 1
  for (let i = 1; i < DEFAULT_WALLET_AUTH_MAX_FAILURES; i++) {
    const count = await store.recordFailure(TEST_WALLET_ADDRESS);
    t.equal(count, i, `failure count increments to ${i}`);
    t.equal(await store.isLockedOut(TEST_WALLET_ADDRESS), false, `not locked out at ${i} failures`);
  }

  // 3. Hitting the 5th failure triggers lockout
  const finalCount = await store.recordFailure(TEST_WALLET_ADDRESS);
  t.equal(finalCount, DEFAULT_WALLET_AUTH_MAX_FAILURES, `failure count hits ${DEFAULT_WALLET_AUTH_MAX_FAILURES}`);
  t.equal(await store.isLockedOut(TEST_WALLET_ADDRESS), true, 'locked out when threshold is reached');

  // 4. Verifying TTL is set on the failure key
  const key = walletAuthFailKey(TEST_WALLET_ADDRESS);
  t.ok(key.startsWith(WALLET_AUTH_LOCKOUT_KEY_PREFIX), 'key carries proper prefix');
  t.ok(redis.expireCalls.some((c) => c.key === key && c.seconds === DEFAULT_WALLET_AUTH_LOCKOUT_TTL_SEC), 'expire TTL set');

  // 5. Success resets failures and lifts lockout
  await store.resetFailures(TEST_WALLET_ADDRESS);
  t.equal(await store.getFailureCount(TEST_WALLET_ADDRESS), 0, 'failure count reset to 0');
  t.equal(await store.isLockedOut(TEST_WALLET_ADDRESS), false, 'lockout lifted after reset');

  t.end();
});

test('WalletChallengeStore lockout: lockout expires after TTL window passes (#902)', async (t) => {
  const { redis, getClock } = createMockRedis();
  const store = new WalletChallengeStore(redis, { now: getClock });

  // Record 5 failures to trigger lockout
  for (let i = 0; i < DEFAULT_WALLET_AUTH_MAX_FAILURES; i++) {
    await store.recordFailure(TEST_WALLET_ADDRESS);
  }
  t.equal(await store.isLockedOut(TEST_WALLET_ADDRESS), true, 'locked out initially');

  // Advance time past the 15-minute (900 second) TTL window
  redis.advanceTime((DEFAULT_WALLET_AUTH_LOCKOUT_TTL_SEC + 1) * 1000);

  // Failure key has expired
  t.equal(await store.getFailureCount(TEST_WALLET_ADDRESS), 0, 'failure count expired to 0');
  t.equal(await store.isLockedOut(TEST_WALLET_ADDRESS), false, 'lockout expired after TTL window');

  t.end();
});

test('WalletChallengeStore lockout: respects custom threshold (#902)', async (t) => {
  const { redis, getClock } = createMockRedis();
  const store = new WalletChallengeStore(redis, { now: getClock });

  await store.recordFailure(TEST_WALLET_ADDRESS);
  await store.recordFailure(TEST_WALLET_ADDRESS);

  // Count is 2: not locked out at default threshold (5), but locked out at custom threshold (2)
  t.equal(await store.isLockedOut(TEST_WALLET_ADDRESS, 5), false, 'not locked out with threshold 5');
  t.equal(await store.isLockedOut(TEST_WALLET_ADDRESS, 2), true, 'locked out with custom threshold 2');

  t.end();
});

test('POST /api/auth/wallet/verify returns 429 WALLET_AUTH_LOCKOUT when locked out (#902)', async (t) => {
  const { redis, getClock } = createMockRedis();
  const mockPrisma = createMockPrisma();

  // Create test app with Redis providing lockout state
  const { app } = await createTestApp({
    prisma: mockPrisma as any,
    redis: redis as any,
  });

  const store = new WalletChallengeStore(redis, { now: getClock });

  // Record failures to exceed threshold
  for (let i = 0; i < DEFAULT_WALLET_AUTH_MAX_FAILURES; i++) {
    await store.recordFailure(TEST_WALLET_ADDRESS);
  }

  // Attempt verification on locked-out address
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/wallet/verify',
    headers: { 'x-csrf-check': '1' },
    payload: {
      address: TEST_WALLET_ADDRESS,
      nonce: 'test-challenge-nonce-12345',
      signature: 'dummy-signature',
      challenge: 'dummy-challenge',
    },
  });

  t.equal(res.statusCode, 429, 'returns 429 Too Many Requests when locked out');
  const body = JSON.parse(res.body);
  t.equal(body.error?.code, ErrorCodes.WALLET_AUTH_LOCKOUT, 'error code is WALLET_AUTH_LOCKOUT');
  t.ok(body.error?.message?.toLowerCase().includes('locked out'), 'error message explains lockout');

  await app.close();
  t.end();
});
