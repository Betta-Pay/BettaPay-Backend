import { Redis } from "ioredis"; // Standard Redis client configuration in backend

const redis = new Redis(process.env.REDIS_URL || "redis://localhost:6379");

const AUTH_IP_THRESHOLD = Number(process.env.AUTH_IP_THRESHOLD) || 5;
const IP_BAN_TTL = 3600; // Block malicious IPs for 1 hour

/**
 * Checks an IP address score and blocks request context if it exceeds the max threshold.
 */
export async function enforceAuthIpReputation(ip: string): Promise<boolean> {
  const score = await redis.get(`auth_fail:${ip}`);
  if (score && Number(score) >= AUTH_IP_THRESHOLD) {
    return false; // IP is throttled/blocked
  }
  return true; // IP is clean
}

/**
 * Records an authentication failure, bumping the IP penalty counter closer to the block limit.
 */
export async function recordAuthIpFailure(ip: string): Promise<number> {
  const key = `auth_fail:${ip}`;
  const current = await redis.incr(key);
  if (current === 1) {
    await redis.expire(key, IP_BAN_TTL);
  }
  return current;
}

/**
 * Completely clears an IP's failure history counter upon a successful log-in.
 */
export async function recordAuthIpSuccess(ip: string): Promise<void> {
  await redis.del(`auth_fail:${ip}`);
}

/**
 * Tracks rate limiting metrics for token refreshes.
 */
export async function incrementRefreshRate(ip: string): Promise<number> {
  const key = `auth_refresh:${ip}`;
  const current = await redis.incr(key);
  if (current === 1) {
    await redis.expire(key, 60); // 1-minute tracking window
  }
  return current;
}

/**
 * Specialized utility allowing admin panels to safely query internal scores.
 */
export async function getIpScore(ip: string): Promise<{ ip: string; failures: number; blocked: boolean }> {
  const score = await redis.get(`auth_fail:${ip}`);
  const failures = score ? Number(score) : 0;
  return {
    ip,
    failures,
    blocked: failures >= AUTH_IP_THRESHOLD,
  };
}
