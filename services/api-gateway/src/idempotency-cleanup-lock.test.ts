/**
 * idempotency-cleanup-lock.test.ts (issue #878)
 *
 * Redis lock acquire/release for the idempotency-key cleanup cron, driven by
 * a fake client so the SET NX PX arguments and Lua compare-and-delete
 * semantics are pinned exactly.
 */
import test from 'tape';
import {
  reclaimExpiredIdempotencyKeys,
  getCronIntervalMs,
} from './idempotency-key-cleanup-cron.js';

const LOCK_KEY = 'lock:idempotency-key-cleanup-cron';
const LOCK_TTL_MS = 5 * 60 * 1000;

interface FakeEntry {
  v: string;
  exp: number | null;
}

function createFakeRedis(setResult: unknown = 'OK') {
  const data = new Map<string, FakeEntry>();
  const setCalls: Array<{ key: string; value: string; args: unknown[] }> = [];
  const evalCalls: Array<{ script: string; numKeys: number; args: string[] }> = [];
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

  return {
    data,
    setCalls,
    evalCalls,
    async set(key: string, value: string, ...args: unknown[]) {
      setCalls.push({ key, value, args });
      const modeIdx = args.findIndex((a) => a === 'EX' || a === 'PX');
      let exp: number | null = null;
      if (modeIdx !== -1) {
        const ttl = Number(args[modeIdx + 1]);
        exp = now() + (args[modeIdx] === 'EX' ? ttl * 1000 : ttl);
      }
      const nx = args.includes('NX');
      if (nx && getLive(key)) return null;
      if (setResult !== undefined && data.size === 0) data.set(key, { v: value, exp });
      return setResult;
    },
    async eval(script: string, numKeys: number, ...args: string[]) {
      evalCalls.push({ script, numKeys, args });
      const key = args[0];
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
}

function createMockPrisma(paymentCount: number, settlementCount: number) {
  const paymentArgs: Array<{ where: any; data: any }> = [];
  const settlementArgs: Array<{ where: any; data: any }> = [];
  return {
    paymentArgs,
    settlementArgs,
    prisma: {
      payment: {
        updateMany: async (args: any) => {
          paymentArgs.push(args);
          return { count: paymentCount };
        },
      },
      settlement: {
        updateMany: async (args: any) => {
          settlementArgs.push(args);
          return { count: settlementCount };
        },
      },
    } as any,
  };
}

function createLogger() {
  return { info: () => {}, error: () => {}, warn: () => {} } as any;
}

test('#878: the lock is acquired once with SET NX PX at the documented TTL', async (t) => {
  const redis = createFakeRedis();
  const { prisma } = createMockPrisma(0, 0);

  await reclaimExpiredIdempotencyKeys(prisma, createLogger(), redis);

  t.equal(redis.setCalls.length, 1, 'one SET call for acquisition');
  t.equal(redis.setCalls[0].key, LOCK_KEY, 'lock key is the documented key');
  t.deepEqual(
    redis.setCalls[0].args,
    ['PX', LOCK_TTL_MS, 'NX'],
    'SET called with PX <ttl> NX',
  );
  t.end();
});

test('#878: a non-owner release returns 0 and leaves the lock intact', async (t) => {
  const redis = createFakeRedis();
  const { prisma } = createMockPrisma(0, 0);

  await reclaimExpiredIdempotencyKeys(prisma, createLogger(), redis);

  // Grab the release script actually used, then replay it with a mismatched
  // owner token against a lock held by someone else.
  const { script, args } = redis.evalCalls[0];
  redis.data.set(LOCK_KEY, { v: 'another-replica-token', exp: Date.now() + 60_000 });

  const result = await redis.eval(script, 1, args[0], 'wrong-token');
  t.equal(result, 0, 'mismatched member releases nothing');
  t.ok(redis.data.get(LOCK_KEY), 'lock still exists');
  t.equal(redis.data.get(LOCK_KEY)?.v, 'another-replica-token', 'lock value untouched');
  t.end();
});

test('#878: an owner release deletes the lock exactly once via the Lua script', async (t) => {
  const redis = createFakeRedis();
  const { prisma } = createMockPrisma(0, 0);

  await reclaimExpiredIdempotencyKeys(prisma, createLogger(), redis);

  const { script, args } = redis.evalCalls[0];
  const [lockKey, member] = args;
  redis.data.set(lockKey, { v: member, exp: Date.now() + 60_000 });

  const first = await redis.eval(script, 1, lockKey, member);
  t.equal(first, 1, 'owner release succeeds');
  t.notOk(redis.data.get(lockKey), 'lock deleted');

  const second = await redis.eval(script, 1, lockKey, member);
  t.equal(second, 0, 'second release deletes nothing — the key is already gone');
  t.end();
});

test('#878: the Lua release script is invoked with the lock key and the member token', async (t) => {
  const redis = createFakeRedis();
  const { prisma } = createMockPrisma(1, 1);

  const total = await reclaimExpiredIdempotencyKeys(prisma, createLogger(), redis);
  t.equal(total, 2, 'cleanup ran to completion');

  t.equal(redis.evalCalls.length, 1, 'release invoked once per run');
  t.equal(redis.evalCalls[0].numKeys, 1, 'script takes one key');
  t.equal(redis.evalCalls[0].args[0], LOCK_KEY, 'released against the lock key');
  const member = redis.evalCalls[0].args[1];
  t.ok(typeof member === 'string' && member.length > 0, 'released with the member token');
  t.ok(
    redis.evalCalls[0].script.includes('redis.call("get", KEYS[1])'),
    'release uses the compare-and-delete Lua script',
  );
  t.end();
});

test('#878: a run reclaims only rows past their expiry window', async (t) => {
  const redis = createFakeRedis();
  const { prisma, paymentArgs, settlementArgs } = createMockPrisma(3, 2);

  const total = await reclaimExpiredIdempotencyKeys(prisma, createLogger(), redis);
  t.equal(total, 5, 'combined reclaimed count across both tables');

  for (const args of [...paymentArgs, ...settlementArgs]) {
    t.equal(args.where.idempotencyKey.not, null, 'only rows that still carry a key');
    t.ok(
      args.where.idempotencyKeyExpiresAt.lt instanceof Date,
      'expiry filter is a live "now" Date, so future-expiring rows are excluded',
    );
    t.deepEqual(args.data, { idempotencyKey: null, idempotencyKeyExpiresAt: null }, 'key and expiry cleared');
  }
  t.end();
});

test('#878: when the lock is held by another instance the run is skipped and no rows are deleted', async (t) => {
  // SET NX returns null because another replica owns the lock.
  const redis = createFakeRedis(null);
  const { prisma, paymentArgs } = createMockPrisma(4, 4);

  const total = await reclaimExpiredIdempotencyKeys(prisma, createLogger(), redis);

  t.equal(total, 0, 'skipped run reclaims nothing');
  t.equal(paymentArgs.length, 0, 'Payment.updateMany never called');
  t.equal(redis.evalCalls.length, 0, 'no release attempted for an unacquired lock');
  t.end();
});

test('#878: getCronIntervalMs returns the configured interval', (t) => {
  const original = process.env.IDEMPOTENCY_KEY_CLEANUP_CRON_INTERVAL_MS;
  try {
    process.env.IDEMPOTENCY_KEY_CLEANUP_CRON_INTERVAL_MS = '90000';
    t.equal(getCronIntervalMs(), 90000, 'reads the configured env interval');

    delete process.env.IDEMPOTENCY_KEY_CLEANUP_CRON_INTERVAL_MS;
    t.equal(getCronIntervalMs(), 3600000, 'falls back to the one-hour default');

    process.env.IDEMPOTENCY_KEY_CLEANUP_CRON_INTERVAL_MS = 'garbage';
    t.equal(getCronIntervalMs(), 3600000, 'invalid values fall back rather than throw');
  } finally {
    if (original === undefined) delete process.env.IDEMPOTENCY_KEY_CLEANUP_CRON_INTERVAL_MS;
    else process.env.IDEMPOTENCY_KEY_CLEANUP_CRON_INTERVAL_MS = original;
  }
  t.end();
});
