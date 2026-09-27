import test from 'tape';
import sinon from 'sinon';
import Redis from 'ioredis';
import { buildApp } from './index.js';
import { createMockPrisma } from './test-utils.js';
import {
  WalletChallengeStore,
  WALLET_CHALLENGE_TTL_MS,
  walletChallengeKey,
  type WalletChallengeRedis,
} from './wallet-challenge-store.js';

// Issue #554 — wallet auth challenges had no server-side expiry store: they
// sat in a per-process Map that nothing evicted, no other instance could see,
// and that survived every failed verification attempt. They now live in Redis
// under a TTL and are consumed by the first verification attempt.

const ADDRESS = 'GABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890';

/**
 * An in-memory Redis with a clock we control, so TTL expiry can be observed
 * without waiting five minutes.
 */
function fakeRedis(startAt = 1_700_000_000_000) {
  const entries = new Map<string, { value: string; expiresAt: number }>();
  let clock = startAt;

  function live(key: string) {
    const entry = entries.get(key);
    if (!entry) return null;
    if (clock >= entry.expiresAt) {
      entries.delete(key);
      return null;
    }
    return entry;
  }

  const redis: WalletChallengeRedis & {
    raw: typeof entries;
    now: () => number;
    advance: (ms: number) => void;
    ttlOf: (key: string) => number | null;
  } = {
    async set(key, value, mode, ttlMs) {
      if (mode !== 'PX') throw new Error(`unexpected mode ${mode}`);
      entries.set(key, { value, expiresAt: clock + ttlMs });
      return 'OK';
    },
    // Emulates the Lua GET+DEL script used by consume(): the key is read and
    // deleted atomically, honouring TTL exactly like Redis would — a key past
    // its TTL behaves as missing. Extra script/numKeys args are accepted for
    // signature compatibility and validated loosely.
    async eval(script, numKeys, ...args) {
      if (typeof script !== 'string' || numKeys !== 1 || args.length < 1) {
        throw new Error('unexpected eval call shape');
      }
      const key = args[0];
      const entry = live(key);
      entries.delete(key);
      return entry ? entry.value : null;
    },
    async getdel(key) {
      const entry = live(key);
      entries.delete(key);
      return entry ? entry.value : null;
    },
    async del(key) {
      entries.delete(key);
      return 1;
    },
    raw: entries,
    now: () => clock,
    advance: (ms: number) => {
      clock += ms;
    },
    ttlOf: (key: string) => {
      const entry = entries.get(key);
      return entry ? entry.expiresAt - clock : null;
    },
  };

  return redis;
}

// ── Storage with a TTL ─────────────────────────────────────────────────────

test('issuing a challenge stores it under a TTL', async (t) => {
  const redis = fakeRedis();
  const store = new WalletChallengeStore(redis, { now: redis.now });

  const issued = await store.issue(ADDRESS);

  t.equal(
    issued.challenge.length,
    65,
    'a challenge is generated (32-byte nonce + 32-byte secret, colon-joined)',
  );
  t.equal(
    issued.expiresAt,
    redis.now() + WALLET_CHALLENGE_TTL_MS,
    'the deadline is recorded on the challenge',
  );
  t.equal(
    redis.ttlOf(walletChallengeKey(ADDRESS)),
    WALLET_CHALLENGE_TTL_MS,
    'the Redis key carries a matching TTL',
  );

  const stored = JSON.parse(redis.raw.get(walletChallengeKey(ADDRESS))!.value);
  t.equal(stored.expiresAt, issued.expiresAt, 'the deadline is persisted, not just returned');
  t.end();
});

test('two challenges for the same address are different, and only the latest stands', async (t) => {
  const redis = fakeRedis();
  const store = new WalletChallengeStore(redis, { now: redis.now });

  const first = await store.issue(ADDRESS);
  const second = await store.issue(ADDRESS);

  t.notEqual(first.challenge, second.challenge, 'each issue mints a fresh challenge');

  const consumed = await store.consume(ADDRESS);
  t.equal(consumed.status, 'valid', 'a challenge is outstanding');
  if (consumed.status === 'valid') {
    t.equal(consumed.challenge.challenge, second.challenge, 'the reissued challenge replaced the first');
  }
  t.end();
});

// ── Expiry ─────────────────────────────────────────────────────────────────

test('a challenge reaped by its Redis TTL is not found', async (t) => {
  const redis = fakeRedis();
  const store = new WalletChallengeStore(redis, { now: redis.now });

  await store.issue(ADDRESS);
  redis.advance(WALLET_CHALLENGE_TTL_MS);

  const consumed = await store.consume(ADDRESS);
  t.equal(consumed.status, 'not_found', 'the key is gone once its TTL elapses');
  t.end();
});

test('a challenge that outlives its TTL is still rejected as expired', async (t) => {
  // The record is deliberately left in place while the clock moves past its
  // deadline — clock skew, a TTL not yet reaped, a restored snapshot. The
  // server-side deadline check must reject it regardless of Redis.
  const redis = fakeRedis();
  let clock = redis.now();
  const store = new WalletChallengeStore(redis, { now: () => clock });

  const issued = await store.issue(ADDRESS);
  clock = issued.expiresAt + 1;

  const consumed = await store.consume(ADDRESS);
  t.equal(consumed.status, 'expired', 'the recorded deadline is enforced by the server');
  t.equal(
    redis.raw.has(walletChallengeKey(ADDRESS)),
    false,
    'the expired challenge is removed rather than left to be retried',
  );
  t.end();
});

test('a challenge one millisecond inside its deadline is still valid', async (t) => {
  const redis = fakeRedis();
  let clock = redis.now();
  const store = new WalletChallengeStore(redis, { now: () => clock });

  const issued = await store.issue(ADDRESS);
  clock = issued.expiresAt;

  const consumed = await store.consume(ADDRESS);
  t.equal(consumed.status, 'valid', 'the deadline itself is inclusive');
  t.end();
});

// ── Single use ─────────────────────────────────────────────────────────────

test('a challenge can be consumed exactly once', async (t) => {
  const redis = fakeRedis();
  const store = new WalletChallengeStore(redis, { now: redis.now });

  await store.issue(ADDRESS);

  const first = await store.consume(ADDRESS);
  const second = await store.consume(ADDRESS);

  t.equal(first.status, 'valid', 'the first attempt gets the challenge');
  t.equal(second.status, 'not_found', 'the second attempt finds nothing');
  t.end();
});

test('consuming is atomic, so concurrent attempts cannot both win', async (t) => {
  const redis = fakeRedis();
  const store = new WalletChallengeStore(redis, { now: redis.now });

  await store.issue(ADDRESS);
  const results = await Promise.all([store.consume(ADDRESS), store.consume(ADDRESS)]);
  const valid = results.filter((r) => r.status === 'valid');

  t.equal(valid.length, 1, 'exactly one of two concurrent verifications gets the challenge');
  t.end();
});

test('consuming is atomic under 10 concurrent verify calls (#611)', async (t) => {
  // This is the real, currently-wired consume path (the Lua GET+DEL script
  // in wallet-challenge-store.ts's `consume()`), exercised at the
  // concurrency level #611 calls for — not the separate hand-rolled
  // get-then-del reimplementation in wallet-auth-challenge.test.ts, which
  // duplicates route logic that isn't actually what index.ts wires up (see
  // that file's own removal in this change).
  const redis = fakeRedis();
  const store = new WalletChallengeStore(redis, { now: redis.now });

  await store.issue(ADDRESS);
  const results = await Promise.all(
    Array.from({ length: 10 }, () => store.consume(ADDRESS)),
  );
  const valid = results.filter((r) => r.status === 'valid');
  const notFound = results.filter((r) => r.status === 'not_found');

  t.equal(valid.length, 1, 'exactly one of ten concurrent verifications gets the challenge');
  t.equal(notFound.length, 9, 'the other nine find nothing outstanding');
  t.end();
});

test('a corrupt record is discarded rather than trusted', async (t) => {
  const redis = fakeRedis();
  const store = new WalletChallengeStore(redis, { now: redis.now });

  await redis.set(walletChallengeKey(ADDRESS), 'not json', 'PX', 60_000);
  t.equal((await store.consume(ADDRESS)).status, 'not_found', 'unparseable record');

  await redis.set(walletChallengeKey(ADDRESS), JSON.stringify({ challenge: 1 }), 'PX', 60_000);
  t.equal((await store.consume(ADDRESS)).status, 'not_found', 'record without a usable deadline');
  t.end();
});

test('Redis failures surface to the caller', async (t) => {
  const failing: WalletChallengeRedis = {
    async set() { throw new Error('Redis connection failed'); },
    async eval() { throw new Error('Redis connection failed'); },
    async del() { throw new Error('Redis connection failed'); },
  };
  const store = new WalletChallengeStore(failing);

  await store.issue(ADDRESS).then(
    () => t.fail('issue should reject'),
    (err) => t.equal(err.message, 'Redis connection failed', 'issue propagates the failure'),
  );
  await store.consume(ADDRESS).then(
    () => t.fail('consume should reject'),
    (err) => t.equal(err.message, 'Redis connection failed', 'consume propagates the failure'),
  );
  t.end();
});

// ── The routes ─────────────────────────────────────────────────────────────

/** Stubs ioredis so the real gateway routes talk to the fake store above. */
function stubRedis(redis: ReturnType<typeof fakeRedis>) {
  const stubs = [
    sinon.stub(Redis.prototype, 'set').callsFake((...args: any[]) =>
      redis.set(args[0], args[1], args[2], args[3]) as any,
    ),
    sinon.stub(Redis.prototype, 'eval').callsFake((...args: any[]) =>
      (redis.eval as any)(args[0], args[1], ...args.slice(2)) as any,
    ),
    sinon.stub(Redis.prototype, 'getdel').callsFake((key: any) => redis.getdel(key) as any),
    sinon.stub(Redis.prototype, 'del').callsFake((key: any) => redis.del(key) as any),
  ];
  return () => stubs.forEach((s) => s.restore());
}

async function withApp(
  redis: ReturnType<typeof fakeRedis>,
  fn: (app: ReturnType<typeof buildApp>) => Promise<void>,
) {
  const restore = stubRedis(redis);
  const app = buildApp({ prisma: createMockPrisma() as any, logger: false });
  try {
    await app.ready();
    await fn(app);
  } finally {
    await app.close();
    restore();
  }
}

const challengeRequest = (app: any) =>
  app.inject({
    method: 'POST',
    url: '/api/auth/challenge',
    headers: { 'x-csrf-check': '1' },
    payload: { address: ADDRESS },
  });

const verifyRequest = (app: any, signature = 'aa'.repeat(64)) =>
  app.inject({
    method: 'POST',
    url: '/api/auth/verify',
    headers: { 'x-csrf-check': '1' },
    payload: { address: ADDRESS, signature },
  });

test('POST /api/auth/challenge persists the challenge with a TTL', async (t) => {
  const redis = fakeRedis();
  await withApp(redis, async (app) => {
    const res = await challengeRequest(app);
    const body = JSON.parse(res.body);

    t.equal(res.statusCode, 200, 'a challenge is issued');
    t.ok(body.challenge, 'the challenge is returned to the caller');
    t.ok(Date.parse(body.expiresAt) > Date.now(), 'the caller is told when it expires');

    const ttl = redis.ttlOf(walletChallengeKey(ADDRESS));
    t.equal(ttl, WALLET_CHALLENGE_TTL_MS, 'the stored key expires on its own');
  });
  t.end();
});

test('POST /api/auth/verify rejects an expired challenge', async (t) => {
  const redis = fakeRedis();
  await withApp(redis, async (app) => {
    await challengeRequest(app);

    // Age the stored record past its deadline, leaving the key in place.
    const key = walletChallengeKey(ADDRESS);
    const record = JSON.parse(redis.raw.get(key)!.value);
    record.expiresAt = Date.now() - 1;
    redis.raw.set(key, { value: JSON.stringify(record), expiresAt: redis.now() + 60_000 });

    const res = await verifyRequest(app);
    t.equal(res.statusCode, 400, 'an expired challenge is refused');
    t.equal(
      JSON.parse(res.body).error.message,
      'Challenge expired',
      'the caller is told the challenge expired',
    );
    t.equal(redis.raw.has(key), false, 'the expired challenge is cleared');
  });
  t.end();
});

test('POST /api/auth/verify rejects a challenge Redis has already reaped', async (t) => {
  const redis = fakeRedis();
  await withApp(redis, async (app) => {
    await challengeRequest(app);
    redis.advance(WALLET_CHALLENGE_TTL_MS);

    const res = await verifyRequest(app);
    t.equal(res.statusCode, 400, 'a reaped challenge is refused');
    t.equal(
      JSON.parse(res.body).error.message,
      'Challenge not found or expired',
      'the caller is told no challenge is outstanding',
    );
  });
  t.end();
});

test('POST /api/auth/verify consumes the challenge even when the signature is wrong', async (t) => {
  const redis = fakeRedis();
  await withApp(redis, async (app) => {
    await challengeRequest(app);

    const first = await verifyRequest(app);
    t.equal(first.statusCode, 401, 'an invalid signature is rejected');
    t.equal(
      redis.raw.has(walletChallengeKey(ADDRESS)),
      false,
      'the challenge is consumed by the attempt',
    );

    const second = await verifyRequest(app);
    t.equal(second.statusCode, 400, 'the challenge cannot be retried');
    t.equal(
      JSON.parse(second.body).error.message,
      'Challenge not found or expired',
      'a second signature guess has nothing to guess against',
    );
  });
  t.end();
});

test('POST /api/auth/verify without an outstanding challenge is refused', async (t) => {
  const redis = fakeRedis();
  await withApp(redis, async (app) => {
    const res = await verifyRequest(app);
    t.equal(res.statusCode, 400, 'nothing to verify against');
  });
  t.end();
});

test('the challenge routes report 503 when Redis is unreachable', async (t) => {
  const stubs = [
    sinon.stub(Redis.prototype, 'set').rejects(new Error('Redis connection failed')),
    sinon.stub(Redis.prototype, 'getdel').rejects(new Error('Redis connection failed')),
  ];
  const app = buildApp({ prisma: createMockPrisma() as any, logger: false });

  try {
    await app.ready();

    const issued = await challengeRequest(app);
    t.equal(issued.statusCode, 503, 'issuing reports the store as unavailable');

    const verified = await verifyRequest(app);
    t.equal(verified.statusCode, 503, 'verifying reports the store as unavailable');
    t.equal(
      JSON.parse(verified.body).error.message,
      'Authentication service unavailable',
      'the failure is not mistaken for an invalid challenge',
    );
  } finally {
    await app.close();
    stubs.forEach((s) => s.restore());
  }
  t.end();
});
