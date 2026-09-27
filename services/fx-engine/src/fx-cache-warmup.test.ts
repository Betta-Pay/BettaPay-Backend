import test from 'tape';

// Mock Redis client for testing
class MockRedis {
  private store: Map<string, any[]> = new Map();

  async zadd(key: string, score: number, member: string): Promise<number> {
    if (!this.store.has(key)) {
      this.store.set(key, []);
    }
    const arr = this.store.get(key)!;
    arr.push({ score, member });
    arr.sort((a, b) => b.score - a.score);
    return 1;
  }

  async zrevrangebyscore(key: string, max: string | number, min: string | number, ...args: any[]): Promise<string[]> {
    const members = this.store.get(key) || [];
    const limit = args.includes('LIMIT') ? args[args.indexOf('LIMIT') + 2] : undefined;
    const filtered = members.slice(0, limit || members.length);
    return filtered.map((m) => m.member);
  }

  pipeline() {
    return {
      zadd: (key: string, score: number, member: string) => this,
      zremrangebyscore: (key: string, min: string, max: string) => this,
      exec: async () => [[1], [0]],
    };
  }
}

interface RateCache {
  rates: Record<string, number>;
  cachedAt: number;
}

let cache: RateCache = {
  rates: { USDC: 1545.50, EURT: 1680.20, NGN: 1.0 },
  cachedAt: Date.now(),
};

const FALLBACK_RATES: Record<string, number> = {
  USDC: 1545.50,
  EURT: 1680.20,
  NGN: 1.0,
};

const SNAPSHOT_KEY = 'fx:rate_snapshots';

function updateBaseRates(newRates: Record<string, number>): void {
  cache = { rates: newRates, cachedAt: Date.now() };
}

interface WarmupOptions {
  minFillRatio?: number;
  requiredCurrencies?: string[];
  maxRetries?: number;
  backoffMs?: number;
}

const REQUIRED_CURRENCIES = ['USDC', 'EURT', 'NGN'];

async function warmupCacheFromRedis(
  redis: MockRedis,
  options: WarmupOptions = {},
): Promise<void> {
  const {
    minFillRatio = 0.5,
    requiredCurrencies = REQUIRED_CURRENCIES,
    maxRetries = 1,
    backoffMs = 10,
  } = options;

  let lastError: Error | null = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const members = await redis.zrevrangebyscore(SNAPSHOT_KEY, '+inf', '-inf', 'LIMIT', 0, 1);
      if (!members.length) {
        // Check if cache already has required valid fallback rates
        const validCurrencies = requiredCurrencies.filter(
          (c) => typeof cache.rates[c] === 'number' && Number.isFinite(cache.rates[c]) && cache.rates[c] > 0,
        );
        const fillRatio = validCurrencies.length / requiredCurrencies.length;
        if (fillRatio < minFillRatio) {
          throw new Error(
            `No snapshot in Redis and cache fill ratio (${fillRatio.toFixed(2)}) is below required minimum (${minFillRatio})`,
          );
        }
        return;
      }

      const snapshot = JSON.parse(members[0]) as { ts: number; rates: Record<string, number> };
      if (!snapshot || typeof snapshot.rates !== 'object' || snapshot.rates === null) {
        throw new Error('Invalid snapshot structure');
      }

      const validRates: Record<string, number> = {};
      for (const [c, r] of Object.entries(snapshot.rates)) {
        if (typeof r === 'number' && Number.isFinite(r) && r > 0) {
          validRates[c] = r;
        }
      }

      const validCount = Object.keys(validRates).length;
      const fillRatio = validCount / requiredCurrencies.length;
      if (fillRatio < minFillRatio) {
        throw new Error(
          `Snapshot valid rate count (${validCount}) fails minimum fill ratio requirement (${minFillRatio})`,
        );
      }

      updateBaseRates(validRates);
      return;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < maxRetries - 1) {
        await new Promise((res) => setTimeout(res, backoffMs * (attempt + 1)));
      }
    }
  }

  // All retries exhausted: verify if cache has enough fallback rates or fail loudly
  const validCurrencies = requiredCurrencies.filter(
    (c) => typeof cache.rates[c] === 'number' && Number.isFinite(cache.rates[c]) && cache.rates[c] > 0,
  );
  const fillRatio = validCurrencies.length / requiredCurrencies.length;
  if (fillRatio < minFillRatio) {
    throw new Error(
      `FX cache warmup failed: all sources failed and rate cache is empty/insufficient. Reason: ${lastError?.message}`,
    );
  }
}

test('FX cache warmup: no snapshot in Redis (uses valid fallback rates)', async (t) => {
  const redis = new MockRedis();
  cache = { rates: { ...FALLBACK_RATES }, cachedAt: Date.now() };
  const initialCache = { ...cache.rates };

  await warmupCacheFromRedis(redis);

  t.deepEqual(cache.rates, initialCache, 'cache retains fallback rates when no snapshot exists');
  t.end();
});

test('FX cache warmup: with snapshot in Redis', async (t) => {
  const redis = new MockRedis();
  cache = { rates: { ...FALLBACK_RATES }, cachedAt: Date.now() };
  const snapshot = { ts: Date.now(), rates: { USDC: 2000.00, EURT: 1800.00, NGN: 1.0 } };

  await redis.zadd(SNAPSHOT_KEY, snapshot.ts, JSON.stringify(snapshot));

  const oldRates = { ...cache.rates };
  await warmupCacheFromRedis(redis);

  t.notDeepEqual(cache.rates, oldRates, 'cache updated with snapshot rates');
  t.equal(cache.rates.USDC, 2000.00, 'USDC rate updated to 2000.00');
  t.equal(cache.rates.EURT, 1800.00, 'EURT rate updated to 1800.00');
  t.equal(cache.rates.NGN, 1.0, 'NGN rate unchanged');
  t.end();
});

test('FX cache warmup: multiple snapshots (uses latest)', async (t) => {
  const redis = new MockRedis();
  cache = { rates: { ...FALLBACK_RATES }, cachedAt: Date.now() };
  const oldSnapshot = { ts: Date.now() - 3600000, rates: { USDC: 1000.00, EURT: 1000.00, NGN: 1.0 } };
  const newSnapshot = { ts: Date.now(), rates: { USDC: 2500.00, EURT: 2000.00, NGN: 1.0 } };

  await redis.zadd(SNAPSHOT_KEY, oldSnapshot.ts, JSON.stringify(oldSnapshot));
  await redis.zadd(SNAPSHOT_KEY, newSnapshot.ts, JSON.stringify(newSnapshot));

  await warmupCacheFromRedis(redis);

  t.equal(cache.rates.USDC, 2500.00, 'uses latest snapshot USDC rate');
  t.equal(cache.rates.EURT, 2000.00, 'uses latest snapshot EURT rate');
  t.end();
});

test('FX cache warmup: invalid JSON in snapshot (falls back gracefully when valid fallback exists)', async (t) => {
  const redis = new MockRedis();
  cache = { rates: { ...FALLBACK_RATES }, cachedAt: Date.now() };
  (redis as any).store.set(SNAPSHOT_KEY, [{ score: Date.now(), member: 'invalid json' }]);

  const oldRates = { ...cache.rates };
  await warmupCacheFromRedis(redis);

  t.deepEqual(cache.rates, oldRates, 'cache keeps fallback rates when snapshot is invalid JSON');
  t.end();
});

test('FX cache warmup: snapshot with missing rates property (falls back to existing rates)', async (t) => {
  const redis = new MockRedis();
  cache = { rates: { ...FALLBACK_RATES }, cachedAt: Date.now() };
  const badSnapshot = { ts: Date.now() }; // Missing rates property

  await redis.zadd(SNAPSHOT_KEY, Date.now(), JSON.stringify(badSnapshot));

  await warmupCacheFromRedis(redis);
  t.equal(cache.rates.USDC, 1545.50, 'preserves valid fallback rate');
  t.end();
});

// ── All-Fail Path & Minimum-Fill Requirement Tests (Issue #499) ────────────────

test('FX cache warmup: all-fail with empty cache fails loudly (throws error)', async (t) => {
  const redis = new MockRedis();
  // Start with empty cache (no valid fallback rates)
  cache = { rates: {}, cachedAt: 0 };

  let threw = false;
  try {
    await warmupCacheFromRedis(redis, { minFillRatio: 0.5 });
  } catch (err) {
    threw = true;
    t.ok((err as Error).message.includes('warmup failed'), 'error message explains warmup failure');
  }

  t.true(threw, 'warmup throws and fails loudly when cache is empty and no snapshot exists');
  t.equal(Object.keys(cache.rates).length, 0, 'no empty/corrupt rates are served');
  t.end();
});

test('FX cache warmup: retries with backoff on transient errors before succeeding', async (t) => {
  let attempts = 0;
  const flakeyRedis: any = {
    async zrevrangebyscore() {
      attempts++;
      if (attempts < 2) {
        throw new Error('Transient connection error');
      }
      return [JSON.stringify({ ts: Date.now(), rates: { USDC: 1600.00, EURT: 1700.00, NGN: 1.0 } })];
    },
  };

  cache = { rates: {}, cachedAt: 0 };
  await warmupCacheFromRedis(flakeyRedis, { maxRetries: 3, backoffMs: 5, minFillRatio: 0.5 });

  t.equal(attempts, 2, 'retried warmup upon initial failure');
  t.equal(cache.rates.USDC, 1600.00, 'warmed up rates successfully after retry');
  t.end();
});

test('FX cache warmup: fails when snapshot fill ratio does not satisfy minimum requirement', async (t) => {
  const redis = new MockRedis();
  cache = { rates: {}, cachedAt: 0 };
  // Only 1 out of 3 currencies provided (33% fill < 50% required)
  const incompleteSnapshot = { ts: Date.now(), rates: { NGN: 1.0 } };
  await redis.zadd(SNAPSHOT_KEY, Date.now(), JSON.stringify(incompleteSnapshot));

  let threw = false;
  try {
    await warmupCacheFromRedis(redis, { minFillRatio: 0.5, maxRetries: 1 });
  } catch (err) {
    threw = true;
    t.ok((err as Error).message.includes('fill ratio'), 'error identifies insufficient fill ratio');
  }

  t.true(threw, 'throws when fill ratio is below threshold on empty cache');
  t.end();
});
