/**
 * Tests for the rate history cleanup job.
 *
 * The cleanup handler runs daily via BullMQ and purges snapshots older than
 * RATE_HISTORY_RETENTION_DAYS from the Redis sorted set `fx:rate_snapshots`.
 * This file tests the core cleanup logic in isolation — the BullMQ scheduling
 * and worker lifecycle are integration concerns.
 */

import test from 'tape';

// ── Mock Redis client ────────────────────────────────────────────────────

interface SortedSetMember {
  score: number;
  member: string;
}

class MockRedis {
  store = new Map<string, SortedSetMember[]>();
  lockAcquired = true;

  async set(key: string, value: string, ...args: any[]): Promise<string | null> {
    if (!this.lockAcquired) return null;
    return 'OK';
  }

  async eval(script: string, numKeys: number, key: string, arg: string): Promise<number> {
    return 1;
  }

  async zadd(key: string, score: number, member: string): Promise<number> {
    if (!this.store.has(key)) {
      this.store.set(key, []);
    }
    const arr = this.store.get(key)!;
    // Replace if same member already present (sorted-set semantics)
    const existingIdx = arr.findIndex((m) => m.member === member);
    if (existingIdx !== -1) {
      arr.splice(existingIdx, 1);
    }
    arr.push({ score, member });
    arr.sort((a, b) => a.score - b.score);
    return 1;
  }

  async zremrangebyscore(
    key: string,
    min: string | number,
    max: string | number,
  ): Promise<number> {
    const arr = this.store.get(key);
    if (!arr || arr.length === 0) return 0;

    const minVal = typeof min === 'string' && min === '-inf' ? -Infinity : Number(min);
    const maxVal = typeof max === 'string' && max === '+inf' ? Infinity : Number(max);

    const before = arr.length;
    const kept = arr.filter(
      (m) => m.score < minVal || m.score > maxVal,
    );
    const removed = before - kept.length;
    this.store.set(key, kept);
    return removed;
  }

  async zcard(key: string): Promise<number> {
    return this.store.get(key)?.length ?? 0;
  }

  async zrange(key: string, start: number, stop: number): Promise<string[]> {
    const arr = this.store.get(key) || [];
    return arr.slice(start, stop >= 0 ? stop + 1 : undefined).map((m) => m.member);
  }

  pipeline() {
    const self = this;
    return {
      zadd: (key: string, score: number, member: string) => this,
      zremrangebyscore: (key: string, min: string, max: string) => this,
      exec: async () => [[1], [0]],
    };
  }
}

// ── Constants (mirrors services/fx-engine/src/index.ts) ──────────────────

const SNAPSHOT_KEY = 'fx:rate_snapshots';

// ── Cleanup logic under test ─────────────────────────────────────────────
//
// Replicates runRateHistoryCleanup() from index.ts but accepts the retention
// days as a parameter so each test can configure it independently.

async function acquireCleanupLock(redis: MockRedis): Promise<string | null> {
  const token = 'mock-token';
  const result = await redis.set('RATE_CLEANUP_LOCK_KEY', token, 'PX', 30000, 'NX').catch(() => null);
  return result === 'OK' ? token : null;
}

async function releaseCleanupLock(redis: MockRedis, token: string): Promise<void> {
  await redis.eval('mock', 1, 'RATE_CLEANUP_LOCK_KEY', token).catch(() => {});
}

async function runRateHistoryCleanup(
  redis: MockRedis,
  retentionDays: number,
): Promise<number> {
  const lockToken = await acquireCleanupLock(redis);
  if (!lockToken) return 0;
  try {
    const effectiveDays = Number.isFinite(retentionDays) && retentionDays >= 1
      ? retentionDays
      : 7;
    const cutoff = Date.now() - effectiveDays * 24 * 60 * 60 * 1000;
    const purged = await redis.zremrangebyscore(SNAPSHOT_KEY, '-inf', cutoff);
    return purged;
  } finally {
    await releaseCleanupLock(redis, lockToken);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────

function makeSnapshot(ageHours: number, seed: number) {
  const ts = Date.now() - ageHours * 60 * 60 * 1000;
  return {
    ts,
    member: JSON.stringify({
      ts,
      rates: { USDC: 1500 + seed, EURT: 1600 + seed, NGN: 1.0 },
    }),
  };
}

// ── Tests ────────────────────────────────────────────────────────────────

test('Rate history cleanup: old snapshot removed, recent ones kept', async (t) => {
  const redis = new MockRedis();
  const RETENTION_DAYS = 7;

  // 2 snapshots within retention (1 hour and 1 day old)
  const recent1 = makeSnapshot(1, 0);
  const recent2 = makeSnapshot(24, 10);

  // 1 snapshot outside retention (10 days old — well past 7 days)
  const old = makeSnapshot(10 * 24, 999);

  await redis.zadd(SNAPSHOT_KEY, recent1.ts, recent1.member);
  await redis.zadd(SNAPSHOT_KEY, recent2.ts, recent2.member);
  await redis.zadd(SNAPSHOT_KEY, old.ts, old.member);

  // Verify all 3 are present before cleanup
  const countBefore = await redis.zcard(SNAPSHOT_KEY);
  t.equal(countBefore, 3, 'all 3 snapshots inserted');

  const purged = await runRateHistoryCleanup(redis, RETENTION_DAYS);

  t.equal(purged, 1, 'exactly 1 old snapshot removed');
  const countAfter = await redis.zcard(SNAPSHOT_KEY);
  t.equal(countAfter, 2, '2 snapshots remain after cleanup');

  // Confirm the remaining ones are the recent snapshots
  const remaining = await redis.zrange(SNAPSHOT_KEY, 0, -1);
  const remainingParsed = remaining.map((m) => JSON.parse(m));
  const timestamps = remainingParsed.map((s: any) => s.ts);

  t.ok(timestamps.includes(recent1.ts), 'recent snapshot 1 is kept');
  t.ok(timestamps.includes(recent2.ts), 'recent snapshot 2 is kept');
  t.notOk(timestamps.includes(old.ts), 'old snapshot is gone');

  t.end();
});

test('Rate history cleanup: 0 snapshots — no error, purged = 0', async (t) => {
  const redis = new MockRedis();

  // No snapshots at all
  const purged = await runRateHistoryCleanup(redis, 7);

  t.equal(purged, 0, 'purged count is 0 when there are no snapshots');
  const count = await redis.zcard(SNAPSHOT_KEY);
  t.equal(count, 0, 'key is empty');

  t.end();
});

test('Rate history cleanup: retention = 1 day, snapshot from 2 days ago — removed', async (t) => {
  const redis = new MockRedis();

  // Snapshot from 2 days ago with retention = 1 day
  const oldSnapshot = makeSnapshot(48, 0); // 48 hours = 2 days

  await redis.zadd(SNAPSHOT_KEY, oldSnapshot.ts, oldSnapshot.member);

  const countBefore = await redis.zcard(SNAPSHOT_KEY);
  t.equal(countBefore, 1, 'snapshot inserted');

  const purged = await runRateHistoryCleanup(redis, 1);

  t.equal(purged, 1, '2-day-old snapshot removed with 1-day retention');
  const countAfter = await redis.zcard(SNAPSHOT_KEY);
  t.equal(countAfter, 0, 'no snapshots remain');

  t.end();
});

test('Rate history cleanup: retention = 7 days (default), snapshot from 6 days ago — kept', async (t) => {
  const redis = new MockRedis();

  // Snapshot from 6 days ago with default 7-day retention
  const recentSnapshot = makeSnapshot(6 * 24, 42);

  await redis.zadd(SNAPSHOT_KEY, recentSnapshot.ts, recentSnapshot.member);

  const purged = await runRateHistoryCleanup(redis, 7);

  t.equal(purged, 0, '6-day-old snapshot is NOT removed with 7-day retention');
  const count = await redis.zcard(SNAPSHOT_KEY);
  t.equal(count, 1, 'snapshot remains');

  t.end();
});

test('Rate history cleanup: invalid retention (≤ 0) defaults to 7 days', async (t) => {
  const redis = new MockRedis();

  const newSnapshot = makeSnapshot(1, 10);
  const oldSnapshot = makeSnapshot(10 * 24, 999);

  await redis.zadd(SNAPSHOT_KEY, newSnapshot.ts, newSnapshot.member);
  await redis.zadd(SNAPSHOT_KEY, oldSnapshot.ts, oldSnapshot.member);

  // Pass 0 (invalid) — should fall back to 7 days default
  const purged = await runRateHistoryCleanup(redis, 0);

  t.equal(purged, 1, 'old snapshot removed using default 7-day retention');
  const count = await redis.zcard(SNAPSHOT_KEY);
  t.equal(count, 1, 'only the recent snapshot remains');

  // Verify the remaining one
  const remaining = await redis.zrange(SNAPSHOT_KEY, 0, 0);
  const parsed = JSON.parse(remaining[0]) as { ts: number };
  t.equal(parsed.ts, newSnapshot.ts, 'remaining is the recent snapshot');

  t.end();
});

test('Rate history cleanup: lock cannot be acquired — returns 0, does not purge', async (t) => {
  const redis = new MockRedis();
  redis.lockAcquired = false;

  const oldSnapshot = makeSnapshot(10 * 24, 999);
  await redis.zadd(SNAPSHOT_KEY, oldSnapshot.ts, oldSnapshot.member);

  const purged = await runRateHistoryCleanup(redis, 7);

  t.equal(purged, 0, 'purged count is 0 when lock fails');
  const count = await redis.zcard(SNAPSHOT_KEY);
  t.equal(count, 1, 'key still has snapshot');

  t.end();
});
