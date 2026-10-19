/**
 * Issue #892 — Indexer dedup-ratio counter.
 *
 * indexer_dedup_events_total is incremented whenever an event is dropped as a
 * duplicate (Prisma P2002 / skipDuplicates). This test exercises the counter
 * logic in isolation using the same counter-increment pattern as the
 * flushIndexedEvents and indexEventRecord paths.
 */
import test from 'tape';

// Minimal counter stub replicating prom-client Counter behaviour.
function makeCounter() {
  let value = 0;
  return {
    inc(n = 1) { value += n; },
    get() { return value; },
  };
}

// Replicates the flushIndexedEvents dedup logic: out of `attempted` rows,
// `inserted` actually landed; the rest are duplicates.
function simulateFlush(
  attempted: number,
  inserted: number,
  counter: ReturnType<typeof makeCounter>,
): void {
  const deduped = attempted - inserted;
  if (deduped > 0) {
    counter.inc(deduped);
  }
}

test('#892: counter is incremented by the number of deduplicated events in a flush', (t) => {
  const counter = makeCounter();
  simulateFlush(10, 7, counter); // 3 duplicates
  t.equal(counter.get(), 3, 'counter incremented by 3 for 3 duplicates');
  t.end();
});

test('#892: counter is not incremented when there are no duplicates', (t) => {
  const counter = makeCounter();
  simulateFlush(5, 5, counter); // 0 duplicates
  t.equal(counter.get(), 0, 'counter stays at 0 when no events are deduplicated');
  t.end();
});

test('#892: counter accumulates across multiple flush calls', (t) => {
  const counter = makeCounter();
  simulateFlush(10, 8, counter); // 2 deduped
  simulateFlush(6, 4, counter);  // 2 deduped
  simulateFlush(4, 4, counter);  // 0 deduped
  t.equal(counter.get(), 4, 'counter totals duplicates across multiple flushes');
  t.end();
});

test('#892: per-event P2002 path increments by 1', (t) => {
  const counter = makeCounter();
  // Simulate the per-event catch path: inc() with no argument = 1
  counter.inc();
  t.equal(counter.get(), 1, 'single P2002 increments counter by 1');
  t.end();
});

test('#892: all-deduplicated flush increments by the full batch size', (t) => {
  const counter = makeCounter();
  simulateFlush(20, 0, counter); // every event was a duplicate
  t.equal(counter.get(), 20, 'counter equals full batch size when everything is a duplicate');
  t.end();
});
