import test from 'tape';

// ── Rate feed health computation (mirrors logic in src/index.ts) ─────────

interface RateFeedEntry {
  status: 'healthy' | 'stale' | 'down';
  lastUpdated: string;
  ageMs: number;
}

function computeRateFeeds(
  rates: Record<string, number>,
  globalCachedAt: number,
  rateCachedAt: Record<string, number>,
  feedTtlMs: number,
  now: number,
): Record<string, RateFeedEntry> {
  const rateKeys = Object.keys(rates);
  const feeds: Record<string, RateFeedEntry> = {};

  if (rateKeys.length === 0) {
    const fallbackCurrencies = ['USDC', 'EURT', 'NGN'];
    for (const currency of fallbackCurrencies) {
      const ageMs = now - (rateCachedAt[currency] ?? globalCachedAt);
      feeds[currency] = {
        status: 'down',
        lastUpdated: new Date(rateCachedAt[currency] ?? globalCachedAt).toISOString(),
        ageMs,
      };
    }
  } else {
    for (const currency of rateKeys) {
      const ageMs = now - (rateCachedAt[currency] ?? globalCachedAt);
      let status: 'healthy' | 'stale' | 'down';
      if (ageMs >= 2 * feedTtlMs) {
        status = 'down';
      } else if (ageMs >= feedTtlMs) {
        status = 'stale';
      } else {
        status = 'healthy';
      }
      feeds[currency] = {
        status,
        lastUpdated: new Date(rateCachedAt[currency] ?? globalCachedAt).toISOString(),
        ageMs,
      };
    }
  }

  return feeds;
}

function computeFeedStatus(feeds: Record<string, RateFeedEntry>): 'healthy' | 'degraded' | 'down' {
  const values = Object.values(feeds);
  if (values.some(f => f.status === 'down')) return 'down';
  if (values.some(f => f.status === 'stale')) return 'degraded';
  return 'healthy';
}

// ── Tests ────────────────────────────────────────────────────────────────

const TTL = 60_000;
const now = 1_000_000_000_000;

test('rateFeeds: all fresh — feedStatus healthy', (t) => {
  const rates = { USDC: 1500, EURT: 1700, NGN: 1 };
  const cachedAt = now - 30_000; // 30s ago, < TTL
  const rateCachedAt = { USDC: cachedAt, EURT: cachedAt, NGN: cachedAt };
  const feeds = computeRateFeeds(rates, cachedAt, rateCachedAt, TTL, now);

  t.equal(feeds['USDC'].status, 'healthy');
  t.equal(feeds['EURT'].status, 'healthy');
  t.equal(feeds['NGN'].status, 'healthy');
  t.equal(feeds['USDC'].ageMs, 30_000);
  t.equal(feeds['USDC'].lastUpdated, new Date(cachedAt).toISOString());
  t.equal(computeFeedStatus(feeds), 'healthy');
  t.end();
});

test('rateFeeds: all stale — feedStatus degraded', (t) => {
  const rates = { USDC: 1500, EURT: 1700, NGN: 1 };
  const cachedAt = now - 90_000; // 90s ago, >= TTL, < 2*TTL
  const rateCachedAt = { USDC: cachedAt, EURT: cachedAt, NGN: cachedAt };
  const feeds = computeRateFeeds(rates, cachedAt, rateCachedAt, TTL, now);

  t.equal(feeds['USDC'].status, 'stale');
  t.equal(feeds['EURT'].status, 'stale');
  t.equal(feeds['NGN'].status, 'stale');
  t.equal(feeds['USDC'].ageMs, 90_000);
  t.equal(computeFeedStatus(feeds), 'degraded');
  t.end();
});

test('rateFeeds: all down — feedStatus down', (t) => {
  const rates = { USDC: 1500, EURT: 1700, NGN: 1 };
  const cachedAt = now - 120_000; // 120s ago, >= 2*TTL
  const rateCachedAt = { USDC: cachedAt, EURT: cachedAt, NGN: cachedAt };
  const feeds = computeRateFeeds(rates, cachedAt, rateCachedAt, TTL, now);

  t.equal(feeds['USDC'].status, 'down');
  t.equal(feeds['EURT'].status, 'down');
  t.equal(feeds['NGN'].status, 'down');
  t.equal(feeds['USDC'].ageMs, 120_000);
  t.equal(computeFeedStatus(feeds), 'down');
  t.end();
});

test('rateFeeds: no rates — all down', (t) => {
  const rates = {};
  const cachedAt = now;
  const rateCachedAt = {};
  const feeds = computeRateFeeds(rates, cachedAt, rateCachedAt, TTL, now);

  t.equal(feeds['USDC'].status, 'down');
  t.equal(feeds['EURT'].status, 'down');
  t.equal(feeds['NGN'].status, 'down');
  t.equal(computeFeedStatus(feeds), 'down');
  t.end();
});

test('rateFeeds: boundary at exactly TTL is stale', (t) => {
  const rates = { USDC: 1500 };
  const cachedAt = now - TTL;
  const rateCachedAt = { USDC: cachedAt };
  const feeds = computeRateFeeds(rates, cachedAt, rateCachedAt, TTL, now);

  t.equal(feeds['USDC'].status, 'stale');
  t.end();
});

test('rateFeeds: boundary at exactly 2*TTL is down', (t) => {
  const rates = { USDC: 1500 };
  const cachedAt = now - 2 * TTL;
  const rateCachedAt = { USDC: cachedAt };
  const feeds = computeRateFeeds(rates, cachedAt, rateCachedAt, TTL, now);

  t.equal(feeds['USDC'].status, 'down');
  t.end();
});

test('rateFeeds: mixed statuses — aggregate reflects worst and partial degradation works', (t) => {
  const rates = { USDC: 1500, EURT: 1700, NGN: 1 };
  const globalCachedAt = now - 120_000;
  // USDC is fresh, EURT is stale, NGN is down
  const rateCachedAt = {
    USDC: now - 30_000,
    EURT: now - 90_000,
    NGN: now - 120_000,
  };
  const feeds = computeRateFeeds(rates, globalCachedAt, rateCachedAt, TTL, now);
  
  t.equal(feeds['USDC'].status, 'healthy');
  t.equal(feeds['EURT'].status, 'stale');
  t.equal(feeds['NGN'].status, 'down');
  t.equal(computeFeedStatus(feeds), 'down');
  t.end();
});
