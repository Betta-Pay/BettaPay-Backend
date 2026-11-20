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
const DEFAULT_MAX_ENTRIES = 1_000;

export interface MerchantCacheOptions {
  ttlMs?: number;
  maxEntries?: number;
}

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export class MerchantCache<T = Record<string, unknown>> {
  private store = new Map<string, CacheEntry<T>>();
  private ttlMs: number;
  private maxEntriesLimit: number;

  constructor(
    ttlMsOrOptions: number | MerchantCacheOptions = DEFAULT_TTL_MS,
    maxEntries: number = DEFAULT_MAX_ENTRIES,
  ) {
    if (typeof ttlMsOrOptions === 'object' && ttlMsOrOptions !== null) {
      this.ttlMs = ttlMsOrOptions.ttlMs ?? DEFAULT_TTL_MS;
      this.maxEntriesLimit =
        typeof ttlMsOrOptions.maxEntries === 'number' && ttlMsOrOptions.maxEntries > 0
          ? ttlMsOrOptions.maxEntries
          : DEFAULT_MAX_ENTRIES;
    } else {
      this.ttlMs = typeof ttlMsOrOptions === 'number' ? ttlMsOrOptions : DEFAULT_TTL_MS;
      this.maxEntriesLimit =
        typeof maxEntries === 'number' && maxEntries > 0
          ? maxEntries
          : DEFAULT_MAX_ENTRIES;
    }
  }

  get maxEntries(): number {
    return this.maxEntriesLimit;
  }

  get(id: string): T | undefined {
    const entry = this.store.get(id);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(id);
      return undefined;
    }
    // Refresh insertion order for LRU eviction
    this.store.delete(id);
    this.store.set(id, entry);
    return entry.value;
  }

  set(id: string, value: T): void {
    if (this.store.has(id)) {
      this.store.delete(id);
    } else if (this.store.size >= this.maxEntriesLimit) {
      const oldestKey = this.store.keys().next().value;
      if (oldestKey !== undefined) {
        this.store.delete(oldestKey);
      }
    }
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
 * Argument order is always `id`, then `cache`, then `loader` (#822).
 *
 * ```ts
 * const merchant = await getCachedMerchant(
 *   merchantId,
 *   merchantCache,
 *   (id) => prisma.merchant.findUnique({ where: { id } }),
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
