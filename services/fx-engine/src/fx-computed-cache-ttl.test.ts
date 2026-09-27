/**
 * Tests for computed pair-rate cache expiry (issue #615).
 *
 * `resolveRate` (quote-computation.ts) already refuses to *serve* an
 * expired computedRateCache entry, but nothing previously removed the
 * expired entry itself: during a prolonged upstream outage, updateBaseRates
 * never runs and computedRateCache.clear() never fires, so every pair ever
 * queried sits in the map forever. This mirrors pruneExpiredComputedRates
 * from index.ts in isolation, the same pattern used by the other fx-engine
 * test files.
 */

import test from "tape";

const RATE_TTL_MS = 60_000;

interface ComputedRateEntry {
  rate: number;
  computedAt: number;
}

function pruneExpiredComputedRates(
  cache: Map<string, ComputedRateEntry>,
  now: number,
): void {
  for (const [key, entry] of cache) {
    if (now - entry.computedAt >= RATE_TTL_MS) {
      cache.delete(key);
    }
  }
}

test("pruneExpiredComputedRates: removes entries older than the TTL", (t) => {
  const now = 1_000_000_000_000;
  const cache = new Map<string, ComputedRateEntry>([
    ["USDC_NGN", { rate: 1545.5, computedAt: now - RATE_TTL_MS - 1 }],
  ]);

  pruneExpiredComputedRates(cache, now);

  t.equal(cache.has("USDC_NGN"), false, "expired entry is evicted");
  t.end();
});

test("pruneExpiredComputedRates: keeps entries within the TTL", (t) => {
  const now = 1_000_000_000_000;
  const cache = new Map<string, ComputedRateEntry>([
    ["USDC_NGN", { rate: 1545.5, computedAt: now - RATE_TTL_MS + 1 }],
  ]);

  pruneExpiredComputedRates(cache, now);

  t.equal(cache.has("USDC_NGN"), true, "fresh entry is kept");
  t.end();
});

test("pruneExpiredComputedRates: an entry exactly at the TTL boundary is evicted", (t) => {
  const now = 1_000_000_000_000;
  const cache = new Map<string, ComputedRateEntry>([
    ["USDC_NGN", { rate: 1545.5, computedAt: now - RATE_TTL_MS }],
  ]);

  pruneExpiredComputedRates(cache, now);

  t.equal(cache.has("USDC_NGN"), false, "boundary entry matches resolveRate's own >= check");
  t.end();
});

test("pruneExpiredComputedRates: a prolonged outage does not leak every pair ever queried", (t) => {
  const now = 1_000_000_000_000;
  const cache = new Map<string, ComputedRateEntry>();

  // Simulate many distinct pairs queried during an outage, each stamped at
  // a different (now-expired) time, with base-rate refresh never succeeding
  // so nothing else ever clears the map.
  for (let i = 0; i < 500; i++) {
    cache.set(`PAIR_${i}`, { rate: i + 1, computedAt: now - RATE_TTL_MS - i });
  }
  t.equal(cache.size, 500, "cache grew unbounded during the outage");

  pruneExpiredComputedRates(cache, now);

  t.equal(cache.size, 0, "all stale entries are reclaimed once pruned");
  t.end();
});
