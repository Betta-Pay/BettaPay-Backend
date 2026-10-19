import test from 'tape';
import {
  acquireSemaphore,
  releaseSemaphore,
  renewSemaphore,
  startSemaphoreRenewal,
  getActiveCount,
} from './redis-semaphore.js';

// Fake Redis: records every eval call and keeps sorted-set state driven by the
// tagged Lua scripts, so assertions can check both arguments and effects.
function createFakeRedis() {
  const members = new Map<string, number>(); // member -> score
  const evalCalls: { script: string; args: string[] }[] = [];
  const ttls: Record<string, number> = {};

  const redis = {
    members,
    evalCalls,
    ttls,
    renewCalls: () => evalCalls.filter((c) => c.script.includes('SCRIPT:renew')),
    async eval(script: string, _numKeys: number, ...args: string[]) {
      evalCalls.push({ script, args });
      const key = args[0];
      if (script.includes('SCRIPT:acquire')) {
        const [now, windowMs, max, member, ttl] = args.slice(1);
        for (const [m, score] of members) {
          if (score <= Number(now) - Number(windowMs)) members.delete(m);
        }
        if (members.size >= Number(max)) return 0;
        members.set(member, Number(now));
        ttls[key] = Number(ttl);
        return 1;
      }
      if (script.includes('SCRIPT:renew')) {
        const [now, member, ttl] = args.slice(1);
        if (!members.has(member)) return 0;
        members.set(member, Number(now));
        ttls[key] = Number(ttl);
        return 1;
      }
      if (script.includes('SCRIPT:release')) {
        return members.delete(args[1]) ? 1 : 0;
      }
      throw new Error('unrecognised script');
    },
    async zremrangebyscore(_key: string, _min: number, max: number) {
      let removed = 0;
      for (const [m, score] of members) {
        if (score <= max) {
          members.delete(m);
          removed++;
        }
      }
      return removed;
    },
    async zcard() {
      return members.size;
    },
  };
  return redis;
}

// Fake timers: capture setInterval/clearInterval and Date.now so the test
// advances time deterministically.
function installFakeTimers() {
  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  const realNow = Date.now;
  let clock = realNow();
  let nextId = 1;
  const intervals = new Map<number, { fn: () => void; every: number; nextAt: number }>();
  const scheduled: number[] = [];

  (globalThis as any).setInterval = (fn: () => void, every: number) => {
    const id = nextId++;
    intervals.set(id, { fn, every, nextAt: clock + every });
    scheduled.push(every);
    return { id, unref() {} };
  };
  (globalThis as any).clearInterval = (handle: { id: number }) => {
    intervals.delete(handle.id);
  };
  Date.now = () => clock;

  return {
    scheduled,
    activeIntervals: () => intervals.size,
    async advance(ms: number) {
      const target = clock + ms;
      for (;;) {
        const due = [...intervals.values()]
          .filter((i) => i.nextAt <= target)
          .sort((a, b) => a.nextAt - b.nextAt)[0];
        if (!due) break;
        clock = due.nextAt;
        due.nextAt += due.every;
        due.fn();
        // let the async renew promise chain settle
        await new Promise((r) => setImmediate(r));
      }
      clock = target;
    },
    restore() {
      globalThis.setInterval = realSetInterval;
      globalThis.clearInterval = realClearInterval;
      Date.now = realNow;
    },
  };
}

test('renewal is scheduled at ttlSeconds / 3', async (t) => {
  const timers = installFakeTimers();
  try {
    const redis = createFakeRedis() as any;
    const opts = { maxConcurrent: 1, ttlSeconds: 60 };
    const member = (await acquireSemaphore(redis, 'm', opts))!;
    const handle = startSemaphoreRenewal(redis, 'm', member, opts);

    t.deepEqual(timers.scheduled, [20_000], '60s TTL schedules a 20s interval');
    handle.stop();

    const handle2 = startSemaphoreRenewal(redis, 'm', member, { ttlSeconds: 90 });
    t.equal(timers.scheduled[1], 30_000, '90s TTL schedules a 30s interval');
    handle2.stop();
  } finally {
    timers.restore();
  }
  t.end();
});

test('advancing one renewal period calls the renew script with the member token', async (t) => {
  const timers = installFakeTimers();
  try {
    const redis = createFakeRedis() as any;
    const opts = { maxConcurrent: 1, ttlSeconds: 60, prefix: 'sem:test' };
    const member = (await acquireSemaphore(redis, 'm1', opts))!;
    const handle = startSemaphoreRenewal(redis, 'm1', member, opts);

    t.equal(redis.renewCalls().length, 0, 'no renewal before the first period');
    await timers.advance(19_999);
    t.equal(redis.renewCalls().length, 0, 'still none just before the period elapses');

    await timers.advance(1);
    const calls = redis.renewCalls();
    t.equal(calls.length, 1, 'renew called once after one period');
    const [key, now, token, ttl] = calls[0].args;
    t.equal(key, 'sem:test:m1', 'renew targets the merchant key');
    t.equal(token, member, 'renew carries the member token');
    t.equal(ttl, '60', 'renew passes ttlSeconds');
    t.equal(now, String(Date.now()), 'renew passes the current time');
    handle.stop();
  } finally {
    timers.restore();
  }
  t.end();
});

test('renewal bumps the member score before the TTL expires', async (t) => {
  const timers = installFakeTimers();
  try {
    const redis = createFakeRedis() as any;
    const opts = { maxConcurrent: 1, ttlSeconds: 60 };
    const member = (await acquireSemaphore(redis, 'm', opts))!;
    const acquiredScore = redis.members.get(member) as number;
    const handle = startSemaphoreRenewal(redis, 'm', member, opts);

    await timers.advance(20_000);
    const renewedScore = redis.members.get(member) as number;
    t.ok(renewedScore > acquiredScore, 'score increased after renewal');
    t.equal(renewedScore, acquiredScore + 20_000, 'score equals the renewal time');
    t.ok(renewedScore - acquiredScore < 60_000, 'bumped well before the TTL window');
    handle.stop();
  } finally {
    timers.restore();
  }
  t.end();
});

test('a long job retains its permit past the initial TTL while renewal is active', async (t) => {
  const timers = installFakeTimers();
  try {
    const redis = createFakeRedis() as any;
    const opts = { maxConcurrent: 1, ttlSeconds: 60 };
    const member = (await acquireSemaphore(redis, 'm', opts))!;
    const handle = startSemaphoreRenewal(redis, 'm', member, opts);

    await timers.advance(150_000); // 2.5x the initial TTL
    t.equal(redis.renewCalls().length, 7, 'renewed every 20s across the run');
    t.equal(await getActiveCount(redis, 'm', opts), 1, 'permit still held past the TTL');
    t.equal(await acquireSemaphore(redis, 'm', opts), null, 'competing worker is refused');
    handle.stop();
  } finally {
    timers.restore();
  }
  t.end();
});

test('without renewal the permit ages out past the TTL', async (t) => {
  const timers = installFakeTimers();
  try {
    const redis = createFakeRedis() as any;
    const opts = { maxConcurrent: 1, ttlSeconds: 60 };
    await acquireSemaphore(redis, 'm', opts);

    await timers.advance(90_000);
    t.equal(await getActiveCount(redis, 'm', opts), 0, 'unrenewed permit is gone');
    t.ok(await acquireSemaphore(redis, 'm', opts), 'a competing worker slips in');
  } finally {
    timers.restore();
  }
  t.end();
});

test('releaseSemaphore frees the slot so another acquirer can proceed', async (t) => {
  const redis = createFakeRedis() as any;
  const opts = { maxConcurrent: 1, ttlSeconds: 60 };
  const first = (await acquireSemaphore(redis, 'm', opts))!;

  t.equal(await acquireSemaphore(redis, 'm', opts), null, 'blocked while held');
  t.equal(await releaseSemaphore(redis, 'm', first, opts), true, 'release removes the slot');
  const second = await acquireSemaphore(redis, 'm', opts);
  t.ok(second && second !== first, 'another acquirer proceeds with a new token');
  t.end();
});

test('the renewal handle stops calling renew once stopped', async (t) => {
  const timers = installFakeTimers();
  try {
    const redis = createFakeRedis() as any;
    const opts = { maxConcurrent: 1, ttlSeconds: 60 };
    const member = (await acquireSemaphore(redis, 'm', opts))!;
    const handle = startSemaphoreRenewal(redis, 'm', member, opts);

    await timers.advance(20_000);
    t.equal(redis.renewCalls().length, 1, 'renewed while active');

    handle.stop();
    t.equal(timers.activeIntervals(), 0, 'interval cleared');
    await timers.advance(120_000);
    t.equal(redis.renewCalls().length, 1, 'no further renew calls after stop');

    t.doesNotThrow(() => handle.stop(), 'stop is safe to call twice');
  } finally {
    timers.restore();
  }
  t.end();
});

test('renewal stops scheduling after release (stop in finally, then release)', async (t) => {
  const timers = installFakeTimers();
  try {
    const redis = createFakeRedis() as any;
    const opts = { maxConcurrent: 1, ttlSeconds: 60 };
    const member = (await acquireSemaphore(redis, 'm', opts))!;
    const handle = startSemaphoreRenewal(redis, 'm', member, opts);

    await timers.advance(40_000);
    handle.stop();
    await releaseSemaphore(redis, 'm', member, opts);
    const before = redis.renewCalls().length;

    await timers.advance(120_000);
    t.equal(redis.renewCalls().length, before, 'no renew calls after release');
    t.equal(await renewSemaphore(redis, 'm', member, opts), false, 'a released token cannot be renewed');
  } finally {
    timers.restore();
  }
  t.end();
});

test('onLost fires when a renewal finds the slot gone', async (t) => {
  const timers = installFakeTimers();
  try {
    const redis = createFakeRedis() as any;
    const opts = { maxConcurrent: 1, ttlSeconds: 60 };
    const member = (await acquireSemaphore(redis, 'm', opts))!;
    let lost = 0;
    const handle = startSemaphoreRenewal(redis, 'm', member, { ...opts, onLost: () => lost++ });

    await releaseSemaphore(redis, 'm', member, opts);
    await timers.advance(20_000);
    t.equal(lost, 1, 'onLost reported once');
    handle.stop();
  } finally {
    timers.restore();
  }
  t.end();
});

test('getActiveCount reflects the acquired and released slots', async (t) => {
  const redis = createFakeRedis() as any;
  const opts = { maxConcurrent: 3, ttlSeconds: 60 };
  t.equal(await getActiveCount(redis, 'm', opts), 0, 'zero initially');
  const a = (await acquireSemaphore(redis, 'm', opts))!;
  const b = (await acquireSemaphore(redis, 'm', opts))!;
  t.equal(await getActiveCount(redis, 'm', opts), 2, 'two after two acquires');
  await releaseSemaphore(redis, 'm', a, opts);
  t.equal(await getActiveCount(redis, 'm', opts), 1, 'one after a release');
  await releaseSemaphore(redis, 'm', b, opts);
  t.equal(await getActiveCount(redis, 'm', opts), 0, 'zero after all released');
  t.end();
});
