/**
 * TTL-bounded in-memory cache for merchant reads.
 *
 * Both the settlement engine and the API gateway read the same merchant
 * record multiple times during a single request lifecycle (validation,
 * fee-rule parsing, daily-limit check).  Hitting Prisma on every read
 * adds unnecessary latency and DB load when the merchant record rarely
 * changes between requests.
 *
 * The cache is keyed by merchant ID and evicts entries after `ttlMs`
 * (default 30 s).  Writes (upsert / update / suspend) should call
 * `merchantCache.invalidate(id)` to avoid serving stale data.
 */

const DEFAULT_TTL_MS = 30_000;

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export class MerchantCache<T = Record<string, unknown>> {
  private store = new Map<string, CacheEntry<T>>();
  private ttlMs: number;

  constructor(ttlMs: number = DEFAULT_TTL_MS) {
    this.ttlMs = ttlMs;
  }

  get(id: string): T | undefined {
    const entry = this.store.get(id);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(id);
      return undefined;
    }
    return entry.value;
  }

  set(id: string, value: T): void {
    this.store.set(id, { value, expiresAt: Date.now() + this.ttlMs });
  }

  invalidate(id: string): void {
    this.store.delete(id);
  }

  clear(): void {
    this.store.clear();
  }

  get size(): number {
    return this.store.size;
  }
}

/**
 * Read-through helper: returns the cached merchant or fetches it via the
 * supplied `loader` function, caches the result, and returns it.
 *
 * ```ts
 * const merchant = await getCachedMerchant(merchantId, (id) =>
 *   prisma.merchant.findUnique({ where: { id } }),
 * );
 * ```
 */
export async function getCachedMerchant<T>(
  id: string,
  cache: MerchantCache<T>,
  loader: (id: string) => Promise<T | null>,
): Promise<T | null> {
  const cached = cache.get(id);
  if (cached !== undefined) return cached;

  const fresh = await loader(id);
  if (fresh !== null) {
    cache.set(id, fresh);
  }
  return fresh;
}
