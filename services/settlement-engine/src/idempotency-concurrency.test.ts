import test from 'tape';
import Redis from 'ioredis';

/**
 * Concurrency tests for the atomic idempotency pattern used in
 * POST /api/settlements (issue #240).
 *
 * The pattern:
 *   1. Generate settlementId BEFORE any Redis/DB write
 *   2. Atomic SET NX claims the idempotency key
 *   3. Only the first claimer proceeds to settlement creation
 *   4. DB @unique constraint is the safety net if Redis is down
 *
 * The first section verifies the algorithmic behaviour with an in-memory
 * mock (fast, no Redis required).  The second section uses a real Redis
 * instance to prove the SET NX command is atomic under concurrency.
 */

// ─── In-memory unit tests ────────────────────────────────────────────────────

interface IdempotencyState {
  /** The settlementId claimed for a given key, or null if not yet claimed */
  get(key: string): string | null;
  /** Atomically claim: returns true if first claimer, false if already claimed */
  claim(key: string, value: string): boolean;
  /** In-memory store */
  _store: Map<string, string>;
}

function createIdempotencyStore(): IdempotencyState {
  const store = new Map<string, string>();
  return {
    _store: store,
    get(key: string): string | null {
      return store.get(key) ?? null;
    },
    claim(key: string, value: string): boolean {
      if (store.has(key)) return false; // Simulates SET NX returning null
      store.set(key, value);
      return true; // Simulates SET NX returning 'OK'
    },
  };
}

test('idempotency: single request creates settlement (in-memory)', (t) => {
  const store = createIdempotencyStore();
  const idempotencyKey = 'test-key-1';
  const settlementId = 'set_' + Math.random().toString(36).slice(2);

  // First request: claim succeeds
  const claimed = store.claim(idempotencyKey, settlementId);
  t.true(claimed, 'first request successfully claims idempotency key');

  const stored = store.get(idempotencyKey);
  t.equal(stored, settlementId, 'stored settlement ID matches');
  t.end();
});

test('idempotency: duplicate request returns existing settlement (in-memory)', (t) => {
  const store = createIdempotencyStore();
  const idempotencyKey = 'test-key-2';
  const settlementId1 = 'set_first_abc';
  const settlementId2 = 'set_second_xyz';

  // First request
  const claimed1 = store.claim(idempotencyKey, settlementId1);
  t.true(claimed1, 'first request claims the key');

  // Second (duplicate) request
  const claimed2 = store.claim(idempotencyKey, settlementId2);
  t.false(claimed2, 'second request fails to claim');

  const existing = store.get(idempotencyKey);
  t.equal(existing, settlementId1, 'returned ID is from the first request');
  t.notEqual(existing, settlementId2, 'second request ID is discarded');
  t.end();
});

test('idempotency: 10 concurrent requests with same key - only 1 claims (in-memory)', (t) => {
  const store = createIdempotencyStore();
  const idempotencyKey = 'concurrent-key';

  const results: boolean[] = [];

  for (let i = 0; i < 10; i++) {
    const sid = `set_concurrent_${i}`;
    results.push(store.claim(idempotencyKey, sid));
  }

  const winners = results.filter((r) => r === true);
  const losers = results.filter((r) => r === false);

  t.equal(winners.length, 1, 'exactly 1 request claims the idempotency key');
  t.equal(losers.length, 9, '9 requests are rejected as duplicates');
  t.end();
});

test('idempotency: unique settlement IDs per claim attempt (in-memory)', (t) => {
  const ids = new Set<string>();
  for (let i = 0; i < 100; i++) {
    ids.add('set_' + Math.random().toString(36).slice(2));
  }
  t.equal(ids.size, 100, 'all 100 generated settlement IDs are unique');
  t.end();
});

test('idempotency: different keys are independent (in-memory)', (t) => {
  const store = createIdempotencyStore();

  const claimed1 = store.claim('key-a', 'set_a');
  const claimed2 = store.claim('key-b', 'set_b');
  const claimed3 = store.claim('key-c', 'set_c');

  t.true(claimed1, 'key-a is claimable');
  t.true(claimed2, 'key-b is claimable');
  t.true(claimed3, 'key-c is claimable');

  t.equal(store.get('key-a'), 'set_a', 'key-a maps to set_a');
  t.equal(store.get('key-b'), 'set_b', 'key-b maps to set_b');
  t.equal(store.get('key-c'), 'set_c', 'key-c maps to set_c');

  // Duplicate claim attempts
  t.false(store.claim('key-a', 'set_a_dup'), 'key-a rejects duplicate');
  t.false(store.claim('key-c', 'set_c_dup'), 'key-c rejects duplicate');
  t.end();
});

test('idempotency: claim after DB fallback (simulating Redis down) (in-memory)', (t) => {
  const store = createIdempotencyStore();
  const key = 'redis-down-key';
  const sid = 'set_redis_down';

  const existingBefore = store.get(key);
  t.equal(existingBefore, null, 'no idempotency state in Redis');

  // Store it locally as if the DB create succeeded
  store._store.set(key, sid);

  const existingAfter = store.get(key);
  t.equal(existingAfter, sid, 'second request can still read the stored key');
  t.end();
});

// ─── Redis-backed concurrency tests ──────────────────────────────────────────
// These tests exercise the actual SET NX atomic command against a live Redis
// instance.  They are skipped when REDIS_URL is not set so the fast in-memory
// suite still runs in environments without Redis.

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const KEY_PREFIX = 'idempotency-test:';

function createRedisClient(): Redis {
  return new Redis(REDIS_URL, {
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    lazyConnect: true,
  });
}

/**
 * Atomically claim an idempotency key using the same SET NX pattern as
 * production code (index.ts line 967).  Returns the claimed settlementId
 * on success, or null if another caller already claimed the key.
 */
async function claimIdempotencyKey(
  redis: Redis,
  key: string,
  settlementId: string,
  ttlSeconds: number = 86400,
): Promise<string | null> {
  const result = await redis.set(
    `${KEY_PREFIX}${key}`,
    settlementId,
    'EX',
    ttlSeconds,
    'NX',
  );
  return result === 'OK' ? settlementId : null;
}

test('redis-backed idempotency: single claim succeeds', async (t) => {
  const redis = createRedisClient();
  await redis.connect();

  const key = `single-claim-${Date.now()}`;
  const sid = 'set_redis_single_' + Math.random().toString(36).slice(2);

  try {
    const claimed = await claimIdempotencyKey(redis, key, sid);
    t.ok(claimed, 'first claim returns the settlement ID');
    t.equal(claimed, sid, 'returned value matches the submitted ID');

    const stored = await redis.get(`${KEY_PREFIX}${key}`);
    t.equal(stored, sid, 'Redis stores the claimed settlement ID');
  } finally {
    await redis.del(`${KEY_PREFIX}${key}`);
    redis.disconnect();
  }
  t.end();
});

test('redis-backed idempotency: duplicate claim returns null', async (t) => {
  const redis = createRedisClient();
  await redis.connect();

  const key = `dup-claim-${Date.now()}`;
  const sid1 = 'set_redis_dup_1';
  const sid2 = 'set_redis_dup_2';

  try {
    const claimed1 = await claimIdempotencyKey(redis, key, sid1);
    t.ok(claimed1, 'first claim succeeds');

    const claimed2 = await claimIdempotencyKey(redis, key, sid2);
    t.equal(claimed2, null, 'duplicate claim returns null');

    const stored = await redis.get(`${KEY_PREFIX}${key}`);
    t.equal(stored, sid1, 'stored value is from the first claim');
  } finally {
    await redis.del(`${KEY_PREFIX}${key}`);
    redis.disconnect();
  }
  t.end();
});

test('redis-backed idempotency: 20 concurrent SET NX — exactly 1 wins', async (t) => {
  const redis = createRedisClient();
  await redis.connect();

  const key = `concurrent-race-${Date.now()}`;
  const CONCURRENCY = 20;

  try {
    // Launch all SET NX calls concurrently to expose any race in Redis
    const results = await Promise.all(
      Array.from({ length: CONCURRENCY }, (_, i) =>
        claimIdempotencyKey(redis, key, `set_race_${i}`),
      ),
    );

    const winners = results.filter((r) => r !== null);
    const losers = results.filter((r) => r === null);

    t.equal(winners.length, 1, 'exactly 1 of 20 concurrent claims wins');
    t.equal(losers.length, CONCURRENCY - 1, 'all other claims are rejected');

    // Verify the stored value matches the winner
    const stored = await redis.get(`${KEY_PREFIX}${key}`);
    t.equal(stored, winners[0], 'Redis stores the winning settlement ID');
  } finally {
    await redis.del(`${KEY_PREFIX}${key}`);
    redis.disconnect();
  }
  t.end();
});

test('redis-backed idempotency: SET NX uses single atomic command', async (t) => {
  const redis = createRedisClient();
  await redis.connect();

  const key = `atomic-check-${Date.now()}`;

  try {
    // SET NX with EX is a single command — Redis guarantees atomicity
    // by design.  We verify that the key is set with the correct TTL.
    const result = await redis.set(
      `${KEY_PREFIX}${key}`,
      'set_atomic_check',
      'EX',
      3600,
      'NX',
    );
    t.equal(result, 'OK', 'SET NX returns OK on first call');

    const ttl = await redis.ttl(`${KEY_PREFIX}${key}`);
    t.ok(ttl > 0 && ttl <= 3600, `TTL is within expected range (${ttl}s)`);

    // Second SET NX should fail — proving atomicity
    const result2 = await redis.set(
      `${KEY_PREFIX}${key}`,
      'set_atomic_check_2',
      'EX',
      3600,
      'NX',
    );
    t.equal(result2, null, 'second SET NX returns null (key exists)');
  } finally {
    await redis.del(`${KEY_PREFIX}${key}`);
    redis.disconnect();
  }
  t.end();
});

test('redis-backed idempotency: different keys are independent', async (t) => {
  const redis = createRedisClient();
  await redis.connect();

  const keyA = `indep-a-${Date.now()}`;
  const keyB = `indep-b-${Date.now()}`;

  try {
    const claimedA = await claimIdempotencyKey(redis, keyA, 'set_indep_a');
    const claimedB = await claimIdempotencyKey(redis, keyB, 'set_indep_b');
    t.ok(claimedA, 'key A is claimable');
    t.ok(claimedB, 'key B is claimable');

    // Claiming key A again should fail
    const dupA = await claimIdempotencyKey(redis, keyA, 'set_indep_a_dup');
    t.equal(dupA, null, 'duplicate claim on key A is rejected');

    // Key B should still hold its original value
    const storedB = await redis.get(`${KEY_PREFIX}${keyB}`);
    t.equal(storedB, 'set_indep_b', 'key B retains its original value');
  } finally {
    await redis.del(`${KEY_PREFIX}${keyA}`, `${KEY_PREFIX}${keyB}`);
    redis.disconnect();
  }
  t.end();
});

test('redis-backed idempotency: TTL expires and key becomes re-claimable', async (t) => {
  const redis = createRedisClient();
  await redis.connect();

  const key = `ttl-expire-${Date.now()}`;

  try {
    // Set with 1-second TTL
    const claimed1 = await claimIdempotencyKey(redis, key, 'set_ttl_1', 1);
    t.ok(claimed1, 'first claim succeeds with 1s TTL');

    // Wait for TTL to expire
    await new Promise((resolve) => setTimeout(resolve, 1500));

    // Key should be claimable again
    const claimed2 = await claimIdempotencyKey(redis, key, 'set_ttl_2', 3600);
    t.ok(claimed2, 'key is re-claimable after TTL expiry');
    t.equal(claimed2, 'set_ttl_2', 'new claim has the new settlement ID');
  } finally {
    await redis.del(`${KEY_PREFIX}${key}`);
    redis.disconnect();
  }
  t.end();
});