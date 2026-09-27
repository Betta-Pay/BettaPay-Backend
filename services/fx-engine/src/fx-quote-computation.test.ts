import test from 'tape';
import {
  resolveRate,
  computeQuote,
  toDecimalString,
  AMOUNT_DECIMALS,
  RATE_DECIMALS,
  SLIPPAGE_LIMIT_DECIMALS,
  type CachedRate,
} from './quote-computation.js';

// Issue #566 — the quote handler must resolve a rate exactly once and build
// exactly one rounded quote, whether the rate came from the cache or from the
// live fallback. These tests drive the shared path directly so the
// live-fallback arm is covered as well as the cache arm.

const RATE_TTL_MS = 60_000;
const QUOTE_TTL_MS = 60_000;

/** Minimal stand-in for the service's computed-pair cache. */
function makeCache(seed: Record<string, CachedRate> = {}) {
  const store = new Map<string, CachedRate>(Object.entries(seed));
  const calls = { reads: 0, writes: 0, live: 0 };

  return {
    store,
    calls,
    readCache: (key: string) => {
      calls.reads += 1;
      return store.get(key);
    },
    writeCache: (key: string, entry: CachedRate) => {
      calls.writes += 1;
      store.set(key, entry);
    },
    computeLive: (rate: number) => () => {
      calls.live += 1;
      return rate;
    },
  };
}

/** Mirrors what GET /api/quote does with a resolved rate. */
function quoteFor(rate: number, source: 'cache' | 'live', now: number) {
  return computeQuote({
    from: 'USDC',
    to: 'NGN',
    amount: '250.75',
    rate,
    rateSource: source,
    slippageBps: 50,
    createdAt: now,
    quoteTtlMs: QUOTE_TTL_MS,
    rateBatchId: 'batch-1',
  });
}

// ── resolveRate: cache arm ─────────────────────────────────────────────────

test('resolveRate serves a fresh cached rate without computing live', (t) => {
  const now = Date.now();
  const cache = makeCache({ USDC_NGN: { rate: 1545.5, computedAt: now - 1_000 } });

  const resolved = resolveRate({
    key: 'USDC_NGN',
    now,
    ttlMs: RATE_TTL_MS,
    readCache: cache.readCache,
    writeCache: cache.writeCache,
    computeLive: cache.computeLive(9_999),
  });

  t.equal(resolved.rate, 1545.5, 'returns the cached rate');
  t.equal(resolved.source, 'cache', 'reports the cache as the source');
  t.equal(cache.calls.live, 0, 'live computation is not invoked');
  t.equal(cache.calls.writes, 0, 'cache is not rewritten on a hit');
  t.equal(cache.calls.reads, 1, 'cache is read exactly once per resolution');
  t.end();
});

// ── resolveRate: live fallback arm ─────────────────────────────────────────

test('resolveRate falls back to a live computation on a cache miss', (t) => {
  const now = Date.now();
  const cache = makeCache();

  const resolved = resolveRate({
    key: 'USDC_NGN',
    now,
    ttlMs: RATE_TTL_MS,
    readCache: cache.readCache,
    writeCache: cache.writeCache,
    computeLive: cache.computeLive(1545.5),
  });

  t.equal(resolved.rate, 1545.5, 'returns the freshly computed rate');
  t.equal(resolved.source, 'live', 'reports the live fallback as the source');
  t.equal(cache.calls.live, 1, 'live computation runs exactly once');
  t.deepEqual(
    cache.store.get('USDC_NGN'),
    { rate: 1545.5, computedAt: now },
    'the live rate is written back with the same clock reading',
  );
  t.end();
});

test('resolveRate treats an expired entry as a miss and refreshes it', (t) => {
  const now = Date.now();
  const cache = makeCache({
    USDC_NGN: { rate: 1400, computedAt: now - RATE_TTL_MS },
  });

  const resolved = resolveRate({
    key: 'USDC_NGN',
    now,
    ttlMs: RATE_TTL_MS,
    readCache: cache.readCache,
    writeCache: cache.writeCache,
    computeLive: cache.computeLive(1545.5),
  });

  t.equal(resolved.source, 'live', 'an entry exactly at the TTL boundary is stale');
  t.equal(resolved.rate, 1545.5, 'returns the refreshed rate, not the stale one');
  t.equal(cache.store.get('USDC_NGN')?.rate, 1545.5, 'stale entry is replaced');
  t.end();
});

test('a live fallback populates the cache for the next request', (t) => {
  const now = Date.now();
  const cache = makeCache();
  const options = {
    key: 'USDC_NGN',
    ttlMs: RATE_TTL_MS,
    readCache: cache.readCache,
    writeCache: cache.writeCache,
    computeLive: cache.computeLive(1545.5),
  };

  const first = resolveRate({ ...options, now });
  const second = resolveRate({ ...options, now: now + 1_000 });

  t.equal(first.source, 'live', 'first request falls back to live');
  t.equal(second.source, 'cache', 'second request is served from cache');
  t.equal(cache.calls.live, 1, 'the rate is computed only once across both requests');
  t.end();
});

// ── Cache and fallback produce identical quotes ────────────────────────────

test('cache-hit and live-fallback quotes are field-for-field identical', (t) => {
  const now = Date.now();
  const rate = 1545.5;

  const missCache = makeCache();
  const live = resolveRate({
    key: 'USDC_NGN',
    now,
    ttlMs: RATE_TTL_MS,
    readCache: missCache.readCache,
    writeCache: missCache.writeCache,
    computeLive: missCache.computeLive(rate),
  });

  const hitCache = makeCache({ USDC_NGN: { rate, computedAt: now - 5_000 } });
  const cached = resolveRate({
    key: 'USDC_NGN',
    now,
    ttlMs: RATE_TTL_MS,
    readCache: hitCache.readCache,
    writeCache: hitCache.writeCache,
    computeLive: hitCache.computeLive(rate),
  });

  t.equal(live.source, 'live', 'one quote came from the fallback path');
  t.equal(cached.source, 'cache', 'the other came from the cache path');

  const liveQuote = quoteFor(live.rate, live.source, now);
  const cachedQuote = quoteFor(cached.rate, cached.source, now);

  t.equal(liveQuote.result, cachedQuote.result, 'converted amounts match');
  t.equal(liveQuote.rate, cachedQuote.rate, 'rates match');
  t.equal(liveQuote.slippageLimit, cachedQuote.slippageLimit, 'slippage limits match');
  t.equal(liveQuote.expiresAt, cachedQuote.expiresAt, 'expiries match');

  const { rateSource: liveSource, ...liveRest } = liveQuote;
  const { rateSource: cachedSource, ...cachedRest } = cachedQuote;
  t.notEqual(liveSource, cachedSource, 'only the source label differs');
  t.deepEqual(
    liveRest,
    cachedRest,
    'every quote field apart from the source label is identical',
  );
  t.end();
});

// ── Unified rounding ───────────────────────────────────────────────────────

test('computeQuote rounds every field through the shared helper', (t) => {
  const now = Date.now();
  const quote = computeQuote({
    from: 'USDC',
    to: 'NGN',
    amount: '3.333333',
    rate: 1545.123456789,
    rateSource: 'live',
    slippageBps: 125,
    createdAt: now,
    quoteTtlMs: QUOTE_TTL_MS,
    rateBatchId: 'batch-1',
  });

  t.equal(
    quote.result,
    toDecimalString(3.333333 * 1545.123456789, AMOUNT_DECIMALS),
    'amount uses AMOUNT_DECIMALS',
  );
  t.equal(quote.result.split('.')[1].length, AMOUNT_DECIMALS, 'amount decimal count');
  t.equal(
    quote.rate,
    toDecimalString(1545.123456789, RATE_DECIMALS),
    'rate uses RATE_DECIMALS',
  );
  t.equal(quote.rate.split('.')[1].length, RATE_DECIMALS, 'rate decimal count');
  t.equal(quote.slippageLimit, '0.0125', 'slippage limit is the fractional form of the bps');
  t.equal(
    quote.slippageLimit.split('.')[1].length,
    SLIPPAGE_LIMIT_DECIMALS,
    'slippage limit decimal count',
  );
  t.equal(quote.amount, '3.333333', 'the requested amount is echoed verbatim');
  t.equal(quote.expiresAt, now + QUOTE_TTL_MS, 'expiry is derived from the resolution clock');
  t.end();
});

test('the stored quote and the response body share one rounded computation', (t) => {
  const now = Date.now();
  const quote = quoteFor(1545.123456789, 'live', now);

  // What GET /api/quote persists to Redis...
  const stored = {
    from: quote.from,
    to: quote.to,
    amount: quote.amount,
    result: quote.result,
    rate: quote.rate,
    slippageBps: quote.slippageBps,
    expiresAt: quote.expiresAt,
    rateBatchId: quote.rateBatchId,
  };

  // ...and what it returns to the caller.
  const response = {
    from: quote.from,
    to: quote.to,
    amount: quote.amount,
    result: quote.result,
    rate: quote.rate,
    slippageBps: quote.slippageBps,
    expiresAt: quote.expiresAt,
    rateBatchId: quote.rateBatchId,
  };

  t.deepEqual(stored, response, 'persisted and returned quotes cannot drift');
  t.end();
});
