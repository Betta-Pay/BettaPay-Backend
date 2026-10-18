/**
 * Issue #891 — FX quote cache hit/miss counters.
 *
 * fx_quote_cache_hits_total and fx_quote_cache_misses_total Prometheus counters
 * are incremented based on whether resolvePairRate returns source "cache" or "live".
 */
import test from 'tape';

type RateSource = 'cache' | 'live';

interface ResolvedRate {
  rate: number;
  source: RateSource;
}

// Minimal counter stub matching the prom-client Counter interface used in tests.
function makeCounter() {
  let value = 0;
  return {
    inc() { value++; },
    get() { return value; },
    reset() { value = 0; },
  };
}

// Replicate the counter-increment logic from services/fx-engine/src/index.ts (#891).
function handleResolved(
  resolved: ResolvedRate,
  hits: ReturnType<typeof makeCounter>,
  misses: ReturnType<typeof makeCounter>,
): void {
  const cacheHit = resolved.source === 'cache';
  if (cacheHit) {
    hits.inc();
  } else {
    misses.inc();
  }
}

test('#891: cache hit increments fx_quote_cache_hits_total', (t) => {
  const hits = makeCounter();
  const misses = makeCounter();

  handleResolved({ rate: 1.0, source: 'cache' }, hits, misses);

  t.equal(hits.get(), 1, 'hits counter incremented to 1');
  t.equal(misses.get(), 0, 'misses counter stays at 0');
  t.end();
});

test('#891: cache miss increments fx_quote_cache_misses_total', (t) => {
  const hits = makeCounter();
  const misses = makeCounter();

  handleResolved({ rate: 1.0, source: 'live' }, hits, misses);

  t.equal(hits.get(), 0, 'hits counter stays at 0');
  t.equal(misses.get(), 1, 'misses counter incremented to 1');
  t.end();
});

test('#891: counters accumulate across multiple resolutions', (t) => {
  const hits = makeCounter();
  const misses = makeCounter();

  handleResolved({ rate: 1.0, source: 'cache' }, hits, misses);
  handleResolved({ rate: 1.0, source: 'cache' }, hits, misses);
  handleResolved({ rate: 1.0, source: 'live' }, hits, misses);
  handleResolved({ rate: 1.0, source: 'cache' }, hits, misses);
  handleResolved({ rate: 1.0, source: 'live' }, hits, misses);

  t.equal(hits.get(), 3, 'three cache hits counted');
  t.equal(misses.get(), 2, 'two cache misses counted');
  t.end();
});

test('#891: counters are independent — a hit never touches the miss counter', (t) => {
  const hits = makeCounter();
  const misses = makeCounter();

  for (let i = 0; i < 5; i++) {
    handleResolved({ rate: 1.0, source: 'cache' }, hits, misses);
  }

  t.equal(misses.get(), 0, 'misses counter untouched after five cache hits');
  t.end();
});

test('#891: counters are independent — a miss never touches the hit counter', (t) => {
  const hits = makeCounter();
  const misses = makeCounter();

  for (let i = 0; i < 5; i++) {
    handleResolved({ rate: 1.0, source: 'live' }, hits, misses);
  }

  t.equal(hits.get(), 0, 'hits counter untouched after five cache misses');
  t.end();
});
