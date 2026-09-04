import { Redis } from "ioredis";

const redis = new Redis(process.env.REDIS_URL || "redis://localhost:6379");
const IDEMPOTENCY_KEY_TTL = 86400; // 24 hours in seconds to prevent unbounded Redis growth

/**
 * Saves a payment response with a strict 24-hour expiration safety limit.
 */
export async function saveIdempotencyKey(key: string, responseData: any): Promise<void> {
  const redisKey = `idempotency:${key}`;
  
  // The 'EX' flag instructs Redis to automatically purge the key after 24 hours
  await redis.set(
    redisKey, 
    JSON.stringify(responseData), 
    "EX", 
    IDEMPOTENCY_KEY_TTL
  );
}

/**
 * Retrieves the stored response data to check for key reuse.
 */
export async function getIdempotencyKey(key: string): Promise<any | null> {
  const data = await redis.get(`idempotency:${key}`);
  if (!data) return null;
  return JSON.parse(data);
}
