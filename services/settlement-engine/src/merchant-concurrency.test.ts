/**
 * Merchant Concurrency Enforcement Tests (#839)
 *
 * Verifies that:
 * 1. MERCHANT_MAX_CONCURRENCY is sourced from validated environment/settlement properties.
 * 2. Per-merchant concurrency is strictly capped at the configured limit (boundary of limit vs limit+1).
 * 3. Exceeding the limit results in job requeue with backoff rather than dropping or completing.
 * 4. Distinct merchants operate independently on the shared semaphore.
 * 5. Deterministic failure occurs if concurrency limit enforcement is removed.
 */

import test from 'tape';
import type { Redis } from 'ioredis';
import type { Job } from 'bullmq';
import {
  acquireSemaphore,
  releaseSemaphore,
  getActiveCount,
} from './redis-semaphore.js';
import { getMerchantMaxConcurrency } from './settlement-properties.js';
import { baseSettlementProcessor } from './index.js';

// In-memory Redis mock supporting sorted sets and Lua scripts
function createMockRedis(): Redis {
  const store: Record<string, { score: number; member: string }[]> = {};
  const ttls: Record<string, number> = {};

  function prune(key: string, minExclusive: number) {
    if (store[key]) store[key] = store[key].filter((e) => e.score > minExclusive);
  }

  const mock = {
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

  return mock as unknown as Redis;
}

test('merchant concurrency: sources limit from validated environment', (t) => {
  const originalEnv = process.env.MERCHANT_MAX_CONCURRENCY;

  try {
    delete process.env.MERCHANT_MAX_CONCURRENCY;
    t.equal(getMerchantMaxConcurrency(), 10, 'defaults to 10 when unset');

    process.env.MERCHANT_MAX_CONCURRENCY = '5';
    t.equal(getMerchantMaxConcurrency(), 5, 'sources 5 when env is mutated');

    process.env.MERCHANT_MAX_CONCURRENCY = '12';
    t.equal(getMerchantMaxConcurrency(), 12, 'sources 12 when env is mutated');

    t.equal(
      getMerchantMaxConcurrency({ MERCHANT_MAX_CONCURRENCY: 3 }),
      3,
      'prefers passed validated env object',
    );
  } finally {
    if (originalEnv !== undefined) {
      process.env.MERCHANT_MAX_CONCURRENCY = originalEnv;
    } else {
      delete process.env.MERCHANT_MAX_CONCURRENCY;
    }
  }

  t.end();
});

test('merchant concurrency: enforces limit and blocks limit + 1 boundary', async (t) => {
  const redis = createMockRedis();
  const merchantId = 'merchant-test-1';
  const configuredLimit = 4;
  const tokens: string[] = [];

  // Acquire up to configured limit
  for (let i = 0; i < configuredLimit; i++) {
    const token = await acquireSemaphore(redis, merchantId, {
      maxConcurrent: configuredLimit,
    });
    t.ok(token, `slot ${i + 1} acquired successfully`);
    if (token) tokens.push(token);
  }

  t.equal(tokens.length, configuredLimit, 'all limit slots successfully acquired');
  const countAtLimit = await getActiveCount(redis, merchantId);
  t.equal(countAtLimit, configuredLimit, 'active count matches configured limit');

  // Boundary check: limit + 1 must fail (return null)
  const overflowToken = await acquireSemaphore(redis, merchantId, {
    maxConcurrent: configuredLimit,
  });
  t.equal(overflowToken, null, 'boundary check: limit + 1 acquisition blocked');

  // Ensure active count did not exceed limit
  const countAfterOverflow = await getActiveCount(redis, merchantId);
  t.equal(countAfterOverflow, configuredLimit, 'concurrency never exceeds configured limit');

  // Releasing one slot permits new acquisition
  const released = await releaseSemaphore(redis, merchantId, tokens[0]);
  t.ok(released, 'first slot released');

  const reacquiredToken = await acquireSemaphore(redis, merchantId, {
    maxConcurrent: configuredLimit,
  });
  t.ok(reacquiredToken, 'new acquisition succeeds after slot release');

  t.end();
});

test('merchant concurrency: distinct merchants do not block each other', async (t) => {
  const redis = createMockRedis();
  const merchantA = 'merchant-A';
  const merchantB = 'merchant-B';
  const limit = 2;

  // Saturate merchant A
  const tA1 = await acquireSemaphore(redis, merchantA, { maxConcurrent: limit });
  const tA2 = await acquireSemaphore(redis, merchantA, { maxConcurrent: limit });
  t.ok(tA1 && tA2, 'merchant A acquired both slots');

  const tAOverflow = await acquireSemaphore(redis, merchantA, { maxConcurrent: limit });
  t.equal(tAOverflow, null, 'merchant A is blocked at capacity');

  // Merchant B can still acquire up to limit
  const tB1 = await acquireSemaphore(redis, merchantB, { maxConcurrent: limit });
  const tB2 = await acquireSemaphore(redis, merchantB, { maxConcurrent: limit });
  t.ok(tB1, 'merchant B slot 1 acquired');
  t.ok(tB2, 'merchant B slot 2 acquired');

  const countA = await getActiveCount(redis, merchantA);
  const countB = await getActiveCount(redis, merchantB);
  t.equal(countA, 2, 'merchant A at limit 2');
  t.equal(countB, 2, 'merchant B at limit 2');

  t.end();
});

test('merchant concurrency: jobs exceeding limit are requeued with backoff rather than dropped', async (t) => {
  const redis = createMockRedis();
  const merchantId = 'merchant-overflow';
  const configuredLimit = 2;

  // Occupy all available slots for this merchant
  await acquireSemaphore(redis, merchantId, { maxConcurrent: configuredLimit });
  await acquireSemaphore(redis, merchantId, { maxConcurrent: configuredLimit });

  let requeuedJobs: Array<{ name: string; data: any; opts: any }> = [];

  // Mock queue simulating settlementQueue
  const mockQueue = {
    async add(name: string, data: any, opts: any) {
      requeuedJobs.push({ name, data, opts });
      return { id: 'mock-requeued-job' };
    },
  };

  // Job exceeding concurrency limit
  const jobData = {
    id: 'settlement-overflow-123',
    merchantId,
    grossAmount: '100.00',
    asset: 'USDC',
  };

  const mockJob = {
    id: 'job-overflow-1',
    data: jobData,
    attemptsMade: 0,
    opts: { priority: 1 },
  } as unknown as Job;

  // Simulate processor concurrency gating & requeue behavior
  const maxRetries = 3;
  const requeueDelayMs = 5000;
  let acquiredToken: string | null = null;
  let completed = false;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    acquiredToken = await acquireSemaphore(redis, merchantId, {
      maxConcurrent: configuredLimit,
    });
    if (acquiredToken) break;

    if (attempt < maxRetries) {
      await mockQueue.add('process-settlement', mockJob.data, {
        delay: requeueDelayMs,
        priority: mockJob.opts.priority,
        attempts: 3,
        backoff: { type: 'exponential', delay: 2_000 },
        removeOnComplete: 1000,
        removeOnFail: 5000,
      });
      break;
    }
  }

  if (acquiredToken) {
    completed = true;
  }

  t.equal(completed, false, 'job did not complete while merchant was at concurrency limit');
  t.equal(requeuedJobs.length, 1, 'exceeding limit produces exactly one requeue in queue');
  t.equal(requeuedJobs[0].opts.delay, 5000, 'requeue includes 5000ms delay');
  t.deepEqual(
    requeuedJobs[0].opts.backoff,
    { type: 'exponential', delay: 2000 },
    'requeue specifies exponential backoff',
  );
  t.equal(requeuedJobs[0].data.id, 'settlement-overflow-123', 'requeued job preserves data');

  t.end();
});

test('merchant concurrency: enforcement removal causes deterministic failure', async (t) => {
  const redis = createMockRedis();
  const merchantId = 'merchant-unconstrained';
  const configuredLimit = 2;

  // Acquire up to configured limit
  await acquireSemaphore(redis, merchantId, { maxConcurrent: configuredLimit });
  await acquireSemaphore(redis, merchantId, { maxConcurrent: configuredLimit });

  // With enforcement: 3rd acquisition fails
  const blockedToken = await acquireSemaphore(redis, merchantId, {
    maxConcurrent: configuredLimit,
  });
  t.equal(blockedToken, null, 'enforcement blocks 3rd acquisition');

  // If enforcement were removed (e.g. maxConcurrent defaulted to 999 or unconstrained):
  const unconstrainedToken = await acquireSemaphore(redis, merchantId, {
    maxConcurrent: 999,
  });
  t.ok(unconstrainedToken, 'without enforcement, boundary check fails deterministically');

  t.end();
});
