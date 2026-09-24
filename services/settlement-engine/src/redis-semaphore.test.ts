import test from 'tape';
import {
  acquireSemaphore,
  releaseSemaphore,
  renewSemaphore,
  getActiveCount,
} from './redis-semaphore.js';

// Minimal in-memory Redis mock that supports the sorted-set operations and the
// three tagged Lua scripts the semaphore implementation uses.
function createMockRedis() {
  const store: Record<string, { score: number; member: string }[]> = {};
  const ttls: Record<string, number> = {};

  function prune(key: string, minExclusive: number) {
    if (store[key]) store[key] = store[key].filter((e) => e.score > minExclusive);
  }

  return {
    store,
    ttls,
    async zremrangebyscore(key: string, min: number, max: number) {
      if (!store[key]) return 0;
      const before = store[key].length;
      store[key] = store[key].filter((e) => e.score < min || e.score > max);
      return before - store[key].length;
    },
    async zcard(key: string) {
      return (store[key] ?? []).length;
    },
    async zscore(key: string, member: string) {
      const e = (store[key] ?? []).find((x) => x.member === member);
      return e ? e.score.toString() : null;
    },
    async zadd(key: string, score: number, member: string) {
      if (!store[key]) store[key] = [];
      const existing = store[key].find((e) => e.member === member);
      if (existing) existing.score = score;
      else store[key].push({ score, member });
      store[key].sort((a, b) => a.score - b.score);
      return 1;
    },
    async zrem(key: string, member: string) {
      if (!store[key]) return 0;
      const before = store[key].length;
      store[key] = store[key].filter((e) => e.member !== member);
      return before - store[key].length;
    },
    async expire(key: string, ttl: number) {
      ttls[key] = ttl;
      return 1;
    },
    async del(key: string) {
      delete store[key];
      delete ttls[key];
      return 1;
    },
    async eval(script: string, _numKeys: number, ...args: string[]) {
      const key = args[0];

      if (script.includes('SCRIPT:acquire')) {
        const now = parseInt(args[1], 10);
        const windowMs = parseInt(args[2], 10);
        const maxConcurrent = parseInt(args[3], 10);
        const member = args[4];
        const ttlSeconds = parseInt(args[5], 10);
        prune(key, now - windowMs);
        if ((store[key] ?? []).length >= maxConcurrent) return 0;
        if (!store[key]) store[key] = [];
        store[key].push({ score: now, member });
        store[key].sort((a, b) => a.score - b.score);
        ttls[key] = ttlSeconds;
        return 1;
      }

      if (script.includes('SCRIPT:renew')) {
        const now = parseInt(args[1], 10);
        const member = args[2];
        const ttlSeconds = parseInt(args[3], 10);
        const e = (store[key] ?? []).find((x) => x.member === member);
        if (!e) return 0;
        e.score = now;
        store[key].sort((a, b) => a.score - b.score);
        ttls[key] = ttlSeconds;
        return 1;
      }

      if (script.includes('SCRIPT:release')) {
        const member = args[1];
        const before = (store[key] ?? []).length;
        if (store[key]) store[key] = store[key].filter((x) => x.member !== member);
        const removed = before - (store[key]?.length ?? 0);
        if ((store[key]?.length ?? 0) === 0) {
          delete store[key];
          delete ttls[key];
        }
        return removed;
      }

      throw new Error(`unrecognised script: ${script.slice(0, 40)}`);
    },
  };
}

test('acquireSemaphore: returns a member token when slots are available', async (t) => {
  const redis = createMockRedis() as any;
  const token = await acquireSemaphore(redis, 'merchant-1', { maxConcurrent: 3 });
  t.ok(typeof token === 'string' && token.length > 0, 'acquire returns a token');
  t.equal(redis.store['semaphore:settlement:merchant-1'].length, 1, 'one slot consumed');
  t.end();
});

test('acquireSemaphore: returns null when at capacity', async (t) => {
  const redis = createMockRedis() as any;
  await acquireSemaphore(redis, 'm', { maxConcurrent: 3 });
  await acquireSemaphore(redis, 'm', { maxConcurrent: 3 });
  await acquireSemaphore(redis, 'm', { maxConcurrent: 3 });
  t.equal(await acquireSemaphore(redis, 'm', { maxConcurrent: 3 }), null, 'null at capacity');
  t.end();
});

test('acquireSemaphore: different merchants are independent', async (t) => {
  const redis = createMockRedis() as any;
  await acquireSemaphore(redis, 'A', { maxConcurrent: 2 });
  await acquireSemaphore(redis, 'A', { maxConcurrent: 2 });
  t.ok(await acquireSemaphore(redis, 'B', { maxConcurrent: 2 }), 'B can still acquire');
  t.end();
});

test('releaseSemaphore: frees the caller\'s own slot and cleans up an empty key', async (t) => {
  const redis = createMockRedis() as any;
  const t1 = (await acquireSemaphore(redis, 'm', { maxConcurrent: 3 }))!;
  await acquireSemaphore(redis, 'm', { maxConcurrent: 3 });
  t.equal(redis.store['semaphore:settlement:m'].length, 2, 'two slots before release');

  t.equal(await releaseSemaphore(redis, 'm', t1), true, 'release reports the removal');
  t.equal(redis.store['semaphore:settlement:m'].length, 1, 'one slot after release');

  const t2 = redis.store['semaphore:settlement:m'][0].member as string;
  await releaseSemaphore(redis, 'm', t2);
  t.notOk(redis.store['semaphore:settlement:m'], 'key deleted when the last slot is released');
  t.end();
});

// #487
test('releaseSemaphore: double-release of the same token is a no-op', async (t) => {
  const redis = createMockRedis() as any;
  const held = (await acquireSemaphore(redis, 'm', { maxConcurrent: 3 }))!;
  await acquireSemaphore(redis, 'm', { maxConcurrent: 3 });

  t.equal(await releaseSemaphore(redis, 'm', held), true, 'first release removes the slot');
  t.equal(await releaseSemaphore(redis, 'm', held), false, 'second release removes nothing');
  t.equal(redis.store['semaphore:settlement:m'].length, 1, 'the unrelated slot is untouched');
  t.end();
});

// #487
test('releaseSemaphore: a stale token from a crashed job cannot drop a live slot', async (t) => {
  const redis = createMockRedis() as any;
  await acquireSemaphore(redis, 'm', { maxConcurrent: 3 }); // the live job
  const crashedToken = 'never-acquired:deadbeef';

  t.equal(await releaseSemaphore(redis, 'm', crashedToken), false, 'unknown token removes nothing');
  t.equal(redis.store['semaphore:settlement:m'].length, 1, 'live slot survives');
  t.end();
});

// #486 — without renewal a long job's slot ages out and a second job slips in.
test('a slot NOT renewed past its TTL is treated as free (the bug #486 fixes)', async (t) => {
  const redis = createMockRedis() as any;
  const opts = { maxConcurrent: 1, ttlSeconds: 60 };

  await acquireSemaphore(redis, 'm', opts); // long job, never renewed
  const realNow = Date.now;
  Date.now = () => realNow() + 90_000;
  try {
    t.ok(await acquireSemaphore(redis, 'm', opts), 'a 2nd job acquires — the stale slot aged out');
  } finally {
    Date.now = realNow;
  }
  t.end();
});

// #486 — with renewal the slot stays reserved and maxConcurrent holds.
test('renewSemaphore: a job outliving the TTL keeps its slot; no extra concurrent job', async (t) => {
  const redis = createMockRedis() as any;
  const opts = { maxConcurrent: 1, ttlSeconds: 60 };

  const held = (await acquireSemaphore(redis, 'm', opts))!;
  const realNow = Date.now;
  Date.now = () => realNow() + 90_000;
  try {
    t.equal(await renewSemaphore(redis, 'm', held, opts), true, 'renew succeeds while held');
    t.equal(await getActiveCount(redis, 'm', opts), 1, 'the renewed slot survives the prune');
    t.equal(
      await acquireSemaphore(redis, 'm', opts),
      null,
      'still at capacity — the long job keeps its slot',
    );
  } finally {
    Date.now = realNow;
  }
  t.end();
});

// #486
test('renewSemaphore: returns false once the slot has been released', async (t) => {
  const redis = createMockRedis() as any;
  const held = (await acquireSemaphore(redis, 'm', { maxConcurrent: 3 }))!;
  await releaseSemaphore(redis, 'm', held);
  t.equal(await renewSemaphore(redis, 'm', held, {}), false, 'cannot renew a released slot');
  t.end();
});

test('getActiveCount: reflects acquires and releases', async (t) => {
  const redis = createMockRedis() as any;
  t.equal(await getActiveCount(redis, 'm'), 0, 'zero initially');
  const a = (await acquireSemaphore(redis, 'm', { maxConcurrent: 3 }))!;
  await acquireSemaphore(redis, 'm', { maxConcurrent: 3 });
  t.equal(await getActiveCount(redis, 'm'), 2, 'two after two acquires');
  await releaseSemaphore(redis, 'm', a);
  t.equal(await getActiveCount(redis, 'm'), 1, 'one after release');
  t.end();
});

test('acquireSemaphore: only maxConcurrent acquires win under concurrency', async (t) => {
  const redis = createMockRedis() as any;
  const results = await Promise.all(
    Array.from({ length: 10 }, () => acquireSemaphore(redis, 'm', { maxConcurrent: 3 })),
  );
  t.equal(results.filter((r) => r !== null).length, 3, 'exactly 3 tokens handed out');
  t.end();
});
