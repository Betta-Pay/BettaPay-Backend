/**
 * Redis-based per-merchant semaphore for settlement processing.
 *
 * Limits the number of concurrent settlements a single merchant can occupy
 * across all worker instances. Each held slot is a member of a per-merchant
 * sorted set scored by its last-heartbeat timestamp; the key carries a TTL so
 * a crashed worker's slots auto-release.
 *
 * - Acquire returns the caller's opaque member token (#487): release and renew
 *   are scoped to that exact token, so one job can never drop another's slot
 *   and a double-release is a no-op.
 * - `renewSemaphore` / `startSemaphoreRenewal` bump the member's score and the
 *   key TTL while the job runs (#486), so a job that outlasts `ttlSeconds`
 *   keeps its slot reserved and `maxConcurrent` stays enforced.
 */

import type { Redis } from 'ioredis';

const DEFAULT_MAX_CONCURRENT = 3;
const DEFAULT_TTL_SECONDS = 60;

export interface SemaphoreOptions {
  /** Max concurrent jobs per merchant (default: 3) */
  maxConcurrent?: number;
  /** TTL in seconds for auto-release on crash (default: 60). A held slot must
   *  be renewed within this window or it is treated as stale. */
  ttlSeconds?: number;
  /** Key prefix (default: 'semaphore:settlement') */
  prefix?: string;
}

// Every script is tagged so an in-memory test double can dispatch on it.
const acquireScript = `
  -- SCRIPT:acquire
  local key = KEYS[1]
  local now = tonumber(ARGV[1])
  local windowMs = tonumber(ARGV[2])
  local maxConcurrent = tonumber(ARGV[3])
  local member = ARGV[4]
  local ttlSeconds = tonumber(ARGV[5])

  redis.call('ZREMRANGEBYSCORE', key, 0, now - windowMs)

  local count = redis.call('ZCARD', key)
  if count >= maxConcurrent then
    return 0
  end

  redis.call('ZADD', key, now, member)
  redis.call('EXPIRE', key, ttlSeconds)
  return 1
`;

const renewScript = `
  -- SCRIPT:renew
  local key = KEYS[1]
  local now = tonumber(ARGV[1])
  local member = ARGV[2]
  local ttlSeconds = tonumber(ARGV[3])

  if redis.call('ZSCORE', key, member) == false then
    return 0
  end

  redis.call('ZADD', key, now, member)
  redis.call('EXPIRE', key, ttlSeconds)
  return 1
`;

const releaseScript = `
  -- SCRIPT:release
  local key = KEYS[1]
  local member = ARGV[1]

  local removed = redis.call('ZREM', key, member)
  if redis.call('ZCARD', key) == 0 then
    redis.call('DEL', key)
  end
  return removed
`;

function resolve(opts: SemaphoreOptions) {
  return {
    maxConcurrent: opts.maxConcurrent ?? DEFAULT_MAX_CONCURRENT,
    ttlSeconds: opts.ttlSeconds ?? DEFAULT_TTL_SECONDS,
    prefix: opts.prefix ?? 'semaphore:settlement',
  };
}

/**
 * Try to acquire a semaphore slot for the given merchant.
 * Returns the caller's member token on success (pass it to `renewSemaphore` /
 * `releaseSemaphore`), or `null` if the merchant is at capacity.
 */
export async function acquireSemaphore(
  redis: Redis,
  merchantId: string,
  opts: SemaphoreOptions = {},
): Promise<string | null> {
  const { maxConcurrent, ttlSeconds, prefix } = resolve(opts);
  const key = `${prefix}:${merchantId}`;
  const now = Date.now();
  const windowMs = ttlSeconds * 1000;
  const member = `${now}:${Math.random().toString(36).slice(2)}`;

  const acquired = await redis.eval(
    acquireScript,
    1,
    key,
    now.toString(),
    windowMs.toString(),
    maxConcurrent.toString(),
    member,
    ttlSeconds.toString(),
  );

  return acquired === 1 ? member : null;
}

/**
 * Refresh a held slot: bump the member's score to now and the key TTL to
 * `ttlSeconds`. Returns `true` while the slot is still held, `false` if it has
 * already been released or expired (in which case the caller should stop and
 * treat its slot as lost).
 */
export async function renewSemaphore(
  redis: Redis,
  merchantId: string,
  member: string,
  opts: SemaphoreOptions = {},
): Promise<boolean> {
  const { ttlSeconds, prefix } = resolve(opts);
  const key = `${prefix}:${merchantId}`;

  const renewed = await redis.eval(
    renewScript,
    1,
    key,
    Date.now().toString(),
    member,
    ttlSeconds.toString(),
  );

  return renewed === 1;
}

/**
 * Release the slot identified by `member`. Idempotent: releasing an already
 * released (or expired, or never-held) token is a no-op. Returns `true` iff
 * this call actually removed a slot.
 */
export async function releaseSemaphore(
  redis: Redis,
  merchantId: string,
  member: string,
  opts: SemaphoreOptions = {},
): Promise<boolean> {
  const { prefix } = resolve(opts);
  const key = `${prefix}:${merchantId}`;

  const removed = await redis.eval(releaseScript, 1, key, member);
  return removed === 1;
}

export interface SemaphoreRenewalHandle {
  /** Stop the heartbeat. Safe to call more than once. */
  stop: () => void;
}

/**
 * Start a background heartbeat that keeps `member`'s slot fresh for as long as
 * the job runs (#486). Renews every `ttlSeconds / 3` (so two renewals can be
 * missed before the slot is considered stale). Call `stop()` in a `finally`
 * before releasing.
 */
export function startSemaphoreRenewal(
  redis: Redis,
  merchantId: string,
  member: string,
  opts: SemaphoreOptions & {
    onError?: (err: unknown) => void;
    onLost?: () => void;
  } = {},
): SemaphoreRenewalHandle {
  const { ttlSeconds } = resolve(opts);
  const intervalMs = Math.max(1_000, Math.floor((ttlSeconds * 1000) / 3));

  const timer = setInterval(() => {
    void renewSemaphore(redis, merchantId, member, opts)
      .then((held) => {
        if (!held) opts.onLost?.();
      })
      .catch((err) => opts.onError?.(err));
  }, intervalMs);

  if (typeof (timer as { unref?: () => void }).unref === 'function') {
    (timer as { unref: () => void }).unref();
  }

  let stopped = false;
  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
    },
  };
}

/**
 * Get the current count of non-stale held slots for a merchant.
 */
export async function getActiveCount(
  redis: Redis,
  merchantId: string,
  opts: SemaphoreOptions = {},
): Promise<number> {
  const { ttlSeconds, prefix } = resolve(opts);
  const key = `${prefix}:${merchantId}`;
  const now = Date.now();
  const windowMs = ttlSeconds * 1000;

  await redis.zremrangebyscore(key, 0, now - windowMs);
  return redis.zcard(key);
}
