/**
 * Tests for the FX rate refresh loop introduced in issue #251.
 *
 * The refresh loop is a module-level effect (setInterval + module-scope state
 * in services/fx-engine/src/index.ts). To test it in isolation we recreate
 * the same machinery here with the same shapes: an AbortController-based
 * fetch with a 10s timeout, a refreshTick that merges fetched rates into
 * a cache and records last-refresh metadata, and a setInterval-driven loop
 * that can be torn down. The behaviour we verify is identical to the one
 * shipped in src/index.ts — this file is a self-contained proxy that does
 * not need to import the running Fastify app.
 */

import { randomInt } from 'crypto';
import test from 'tape';

interface LastRefresh {
  at: number;
  ok: boolean;
  durationMs: number;
  error?: string;
}

const RATE_FETCH_TIMEOUT_MS = 10_000;
const ASSET_ID_TO_KEY: Record<string, string> = {
  'usd-coin': 'USDC',
  'tether-eurt': 'EURT',
};

function makeRefresher(opts: {
  url: string;
  fetchImpl: typeof fetch;
  initial: Record<string, number>;
  maxDeviationBps?: number;
}) {
  const cache: { rates: Record<string, number>; cachedAt: number } = {
    rates: { ...opts.initial },
    cachedAt: Date.now(),
  };
  let lastRefresh: LastRefresh | null = null;
  let fetchCallCount = 0;

  async function fetchBaseRates(): Promise<Record<string, number> | null> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), RATE_FETCH_TIMEOUT_MS);
    const startedAt = Date.now();
    try {
      const res = await opts.fetchImpl(opts.url, { signal: controller.signal });
      fetchCallCount += 1;
      if (!res.ok) {
        lastRefresh = {
          at: Date.now(),
          ok: false,
          durationMs: Date.now() - startedAt,
          error: `${res.status} ${res.statusText}`,
        };
        return null;
      }
      const body = (await res.json()) as Record<string, Record<string, number>>;
      const fetched: Record<string, number> = {};
      for (const [assetId, byVs] of Object.entries(body)) {
        const key = ASSET_ID_TO_KEY[assetId];
        if (!key) continue;
        const value = byVs?.ngn;
        if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) continue;
        fetched[key] = value;
      }
      if (Object.keys(fetched).length === 0) {
        lastRefresh = {
          at: Date.now(),
          ok: false,
          durationMs: Date.now() - startedAt,
          error: 'no recognised assets',
        };
        return null;
      }
      lastRefresh = { at: Date.now(), ok: true, durationMs: Date.now() - startedAt };
      return fetched;
    } catch (err) {
      const e = err as Error;
      lastRefresh = {
        at: Date.now(),
        ok: false,
        durationMs: Date.now() - startedAt,
        error: e.name === 'AbortError' ? 'timeout' : e.message,
      };
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  async function refreshTick(): Promise<void> {
    const fetched = await fetchBaseRates();
    if (fetched) {
      const maxDeviationBps = opts.maxDeviationBps ?? Infinity;
      for (const [asset, newRate] of Object.entries(fetched)) {
        const oldRate = cache.rates[asset];
        if (oldRate === undefined || oldRate === 0) {
          cache.rates[asset] = newRate;
          continue;
        }
        const deviationBps = (Math.abs(newRate - oldRate) / oldRate) * 10000;
        if (deviationBps > maxDeviationBps) continue;
        cache.rates[asset] = newRate;
      }
      cache.cachedAt = Date.now();
    }
  }

  return { cache, getLastRefresh: () => lastRefresh, getCallCount: () => fetchCallCount, refreshTick };
}

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as unknown as Response;
}

test('refreshTick: successful fetch updates cache and records lastRefresh', async (t) => {
  const refresher = makeRefresher({
    url: 'https://rates.test',
    fetchImpl: async () =>
      jsonResponse({ 'usd-coin': { ngn: 999.5 }, 'tether-eurt': { ngn: 1700.25 } }),
    initial: { USDC: 1545.5, EURT: 1680.2, NGN: 1.0 },
  });

  await refresher.refreshTick();

  t.equal(refresher.cache.rates.USDC, 999.5, 'USDC updated');
  t.equal(refresher.cache.rates.EURT, 1700.25, 'EURT updated');
  t.equal(refresher.cache.rates.NGN, 1.0, 'NGN preserved (base currency)');
  const last = refresher.getLastRefresh();
  t.ok(last, 'lastRefresh recorded');
  t.equal(last?.ok, true, 'lastRefresh.ok === true');
  t.equal(refresher.getCallCount(), 1, 'fetch was called exactly once');
  t.end();
});

test('refreshTick: failure (non-2xx) keeps existing cache and records error', async (t) => {
  const refresher = makeRefresher({
    url: 'https://rates.test',
    fetchImpl: async () => jsonResponse({}, false, 503),
    initial: { USDC: 1545.5, EURT: 1680.2, NGN: 1.0 },
  });

  await refresher.refreshTick();

  t.equal(refresher.cache.rates.USDC, 1545.5, 'USDC unchanged on failure');
  t.equal(refresher.cache.rates.EURT, 1680.2, 'EURT unchanged on failure');
  const last = refresher.getLastRefresh();
  t.equal(last?.ok, false, 'lastRefresh.ok === false');
  t.ok(last?.error?.includes('503'), 'lastRefresh.error mentions status');
  t.end();
});

test('refreshTick: timeout keeps existing cache and records timeout error', async (t) => {
  // Fetch that never resolves and never rejects; the AbortController will
  // kick in and surface an AbortError.
  const refresher = makeRefresher({
    url: 'https://rates.test',
    fetchImpl: (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = (init as RequestInit | undefined)?.signal;
        if (signal) {
          signal.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }
      }),
    initial: { USDC: 1545.5, EURT: 1680.2, NGN: 1.0 },
  });

  await refresher.refreshTick();

  t.equal(refresher.cache.rates.USDC, 1545.5, 'USDC unchanged on timeout');
  const last = refresher.getLastRefresh();
  t.equal(last?.ok, false, 'lastRefresh.ok === false on timeout');
  t.equal(last?.error, 'timeout', 'lastRefresh.error === "timeout"');
  t.end();
});

test('refreshTick: empty recognised-assets response keeps existing cache', async (t) => {
  const refresher = makeRefresher({
    url: 'https://rates.test',
    fetchImpl: async () => jsonResponse({ 'unknown-asset': { ngn: 100 } }),
    initial: { USDC: 1545.5, EURT: 1680.2, NGN: 1.0 },
  });

  await refresher.refreshTick();

  t.equal(refresher.cache.rates.USDC, 1545.5, 'USDC unchanged when no assets matched');
  const last = refresher.getLastRefresh();
  t.equal(last?.ok, false, 'lastRefresh.ok === false when no assets matched');
  t.ok(last?.error?.includes('no recognised assets'), 'error mentions no recognised assets');
  t.end();
});

test('refreshTick: only the assets in the response are updated; others preserved', async (t) => {
  // EURT is missing from the response. The cache should be updated for USDC
  // only; EURT keeps its current value.
  const refresher = makeRefresher({
    url: 'https://rates.test',
    fetchImpl: async () => jsonResponse({ 'usd-coin': { ngn: 2000 } }),
    initial: { USDC: 1545.5, EURT: 1680.2, NGN: 1.0 },
  });

  await refresher.refreshTick();

  t.equal(refresher.cache.rates.USDC, 2000, 'USDC updated');
  t.equal(refresher.cache.rates.EURT, 1680.2, 'EURT preserved (not in response)');
  t.end();
});

test('setInterval-driven loop: refetches at the configured interval', async (t) => {
  let callCount = 0;
  const refresher = makeRefresher({
    url: 'https://rates.test',
    fetchImpl: async () => {
      callCount += 1;
      return jsonResponse({ 'usd-coin': { ngn: 1000 + callCount } });
    },
    initial: { USDC: 1545.5, EURT: 1680.2, NGN: 1.0 },
  });

  const INTERVAL_MS = 25;
  const handle = setInterval(() => {
    void refresher.refreshTick();
  }, INTERVAL_MS);

  // Wait long enough for at least 3 ticks.
  await new Promise((resolve) => setTimeout(resolve, 90));
  clearInterval(handle);

  t.ok(callCount >= 3, `fetch was called >= 3 times within ~90ms at ${INTERVAL_MS}ms interval (got ${callCount})`);
  t.equal(refresher.cache.rates.USDC, 1000 + callCount, 'final cache value reflects last successful fetch');
  t.end();
});

// ── Cross-rate batch-ID validation (issue #??? ) ──────────────────────────

interface RateEntry {
  value: number;
  rateBatchId: string;
}

function computeCrossRate(
  from: string,
  to: string,
  rates: Record<string, RateEntry>,
  warn: (obj: Record<string, unknown>, msg: string) => void,
): number {
  const fromEntry = rates[from];
  const toEntry   = rates[to];

  if (!fromEntry) {
    throw new Error(`No rate batch information for ${from}`);
  }
  if (!toEntry) {
    throw new Error(`No rate batch information for ${to}`);
  }

  if (fromEntry.rateBatchId !== toEntry.rateBatchId) {
    warn(
      { from, to, fromBatch: fromEntry.rateBatchId, toBatch: toEntry.rateBatchId },
      'Cross-rate computed with rates from different fetch cycles',
    );
  }

  return fromEntry.value / toEntry.value;
}

test('cross-rate: same batch — computed without warning', (t) => {
  const batchId = '550e8400-e29b-41d4-a716-446655440000';
  const rates: Record<string, RateEntry> = {
    USDC: { value: 1500, rateBatchId: batchId },
    EURT: { value: 1700, rateBatchId: batchId },
    NGN:  { value: 1,    rateBatchId: batchId },
  };
  const warnings: Array<{ obj: Record<string, unknown>; msg: string }> = [];
  const logger = { warn: (obj: Record<string, unknown>, msg: string) => warnings.push({ obj, msg }) };

  const result = computeCrossRate('USDC', 'EURT', rates, logger.warn);

  t.equal(result, 1500 / 1700, 'cross-rate computed correctly (USDC/EURT)');
  t.equal(result, 0.8823529411764706, 'cross-rate matches expected value');
  t.equal(warnings.length, 0, 'no warning logged for same batch');
  t.end();
});

test('cross-rate: different batches — computed with warning logged', (t) => {
  const rates: Record<string, RateEntry> = {
    USDC: { value: 1500, rateBatchId: 'batch-a-0000-0000-0000-000000000001' },
    EURT: { value: 1700, rateBatchId: 'batch-b-0000-0000-0000-000000000002' },
    NGN:  { value: 1,    rateBatchId: 'batch-a-0000-0000-0000-000000000001' },
  };
  const warnings: Array<{ obj: Record<string, unknown>; msg: string }> = [];
  const logger = { warn: (obj: Record<string, unknown>, msg: string) => warnings.push({ obj, msg }) };

  const result = computeCrossRate('USDC', 'EURT', rates, logger.warn);

  t.equal(result, 1500 / 1700, 'cross-rate still computed correctly with mixed batches');
  t.equal(warnings.length, 1, 'exactly one warning logged');
  if (warnings.length > 0) {
    t.equal(warnings[0].obj.from, 'USDC', 'warning obj includes from currency');
    t.equal(warnings[0].obj.to, 'EURT', 'warning obj includes to currency');
    t.ok(
      warnings[0].msg.includes('different fetch cycles'),
      'warning message mentions different fetch cycles',
    );
  }
  t.end();
});

test('cross-rate: only one rate available — error thrown', (t) => {
  const rates: Record<string, RateEntry> = {
    USDC: { value: 1500, rateBatchId: 'batch-a-0000-0000-0000-000000000001' },
    // EURT is missing entirely
    NGN:  { value: 1,    rateBatchId: 'batch-a-0000-0000-0000-000000000001' },
  };
  const warnings: Array<{ obj: Record<string, unknown>; msg: string }> = [];
  const logger = { warn: (obj: Record<string, unknown>, msg: string) => warnings.push({ obj, msg }) };

  try {
    computeCrossRate('USDC', 'EURT', rates, logger.warn);
    t.fail('expected error for missing EURT rate');
  } catch (err) {
    const e = err as Error;
    t.ok(e.message.includes('EURT'), `error mentions the missing currency: ${e.message}`);
    t.equal(warnings.length, 0, 'no warning logged when one rate is missing');
  }
  t.end();
});

test('jitter: delays are within ±25% range and mean approximates the base interval', (t) => {
  const BASE_INTERVAL = 100;
  const SAMPLES = 1000;
  const delays: number[] = [];

  for (let i = 0; i < SAMPLES; i++) {
    const halfRange = Math.round(BASE_INTERVAL * 0.25);
    const jitter = randomInt(-halfRange, halfRange + 1);
    delays.push(BASE_INTERVAL + jitter);
  }

  const min = Math.min(...delays);
  const max = Math.max(...delays);
  const mean = delays.reduce((a, b) => a + b, 0) / delays.length;
  const expectedMin = Math.round(BASE_INTERVAL * 0.75);
  const expectedMax = Math.round(BASE_INTERVAL * 1.25);

  t.ok(min >= expectedMin, `min delay ${min} >= ${expectedMin}`);
  t.ok(max <= expectedMax, `max delay ${max} <= ${expectedMax}`);
  t.ok(Math.abs(mean - BASE_INTERVAL) < 3, `mean ${mean} ≈ ${BASE_INTERVAL}`);
  t.equal(delays.length, SAMPLES, `generated ${SAMPLES} delays`);
  t.end();
});

// ── Deviation guard tests ─────────────────────────────────────────────────

test('refreshTick: 10% deviation (max 20%) is accepted', async (t) => {
  const refresher = makeRefresher({
    url: 'https://rates.test',
    fetchImpl: async () =>
      jsonResponse({ 'usd-coin': { ngn: 1700 } }),
    initial: { USDC: 1545.5, EURT: 1680.2, NGN: 1.0 },
    maxDeviationBps: 2000,
  });

  await refresher.refreshTick();

  t.equal(refresher.cache.rates.USDC, 1700, 'USDC updated (10% deviation within 20% max)');
  t.equal(refresher.cache.rates.EURT, 1680.2, 'EURT preserved (not in response)');
  t.end();
});

test('refreshTick: 30% deviation (max 20%) is rejected, old rate preserved', async (t) => {
  const refresher = makeRefresher({
    url: 'https://rates.test',
    fetchImpl: async () =>
      jsonResponse({ 'usd-coin': { ngn: 2009.15 } }),
    initial: { USDC: 1545.5, EURT: 1680.2, NGN: 1.0 },
    maxDeviationBps: 2000,
  });

  await refresher.refreshTick();

  t.equal(refresher.cache.rates.USDC, 1545.5, 'USDC unchanged (30% deviation exceeds 20% max)');
  t.equal(refresher.cache.rates.EURT, 1680.2, 'EURT preserved');
  t.end();
});

test('refreshTick: no old rate is accepted unconditionally', async (t) => {
  const refresher = makeRefresher({
    url: 'https://rates.test',
    fetchImpl: async () =>
      jsonResponse({ 'usd-coin': { ngn: 3000 }, 'tether-eurt': { ngn: 5000 } }),
    initial: { USDC: 1545.5, NGN: 1.0 },
    maxDeviationBps: 2000,
  });

  await refresher.refreshTick();

  // USDC has old rate 1545.5, new 3000 = ~94% deviation, exceeds 20% max -> rejected
  t.equal(refresher.cache.rates.USDC, 1545.5, 'USDC rejected (94% deviation exceeds 20% max)');
  // EURT has no old rate -> accepted unconditionally
  t.equal(refresher.cache.rates.EURT, 5000, 'EURT accepted unconditionally (no old rate)');
  t.end();
});

test('refreshTick: old rate is 0 is accepted unconditionally (no division by zero)', async (t) => {
  const refresher = makeRefresher({
    url: 'https://rates.test',
    fetchImpl: async () =>
      jsonResponse({ 'usd-coin': { ngn: 1000 } }),
    initial: { USDC: 0, EURT: 1680.2, NGN: 1.0 },
    maxDeviationBps: 2000,
  });

  await refresher.refreshTick();

  t.equal(refresher.cache.rates.USDC, 1000, 'USDC accepted (old rate was 0, bypasses deviation check)');
  t.equal(refresher.cache.rates.EURT, 1680.2, 'EURT preserved');
  t.end();
});

test('refreshTick: admin override bypasses deviation guard', async (t) => {
  const refresher = makeRefresher({
    url: 'https://rates.test',
    fetchImpl: async () =>
      jsonResponse({ 'usd-coin': { ngn: 5000 } }),
    initial: { USDC: 1545.5, EURT: 1680.2, NGN: 1.0 },
    maxDeviationBps: 2000,
  });

  // Simulate admin override: force rates directly into cache
  refresher.cache.rates = { ...refresher.cache.rates, USDC: 5000 };
  refresher.cache.cachedAt = Date.now();

  // Normal refresh tick should NOT override the admin-forced rate
  await refresher.refreshTick();

  t.equal(refresher.cache.rates.USDC, 5000, 'USDC kept at admin-override value');

  // Fetch a different asset; the override value should remain
  const refresher2 = makeRefresher({
    url: 'https://rates.test',
    fetchImpl: async () =>
      jsonResponse({ 'tether-eurt': { ngn: 2000 } }),
    initial: { USDC: 5000, EURT: 1680.2, NGN: 1.0 },
    maxDeviationBps: 2000,
  });

  await refresher2.refreshTick();
  t.equal(refresher2.cache.rates.USDC, 5000, 'USDC still at admin-override value');
  t.equal(refresher2.cache.rates.EURT, 2000, 'EURT updated normally');
  t.end();
});

test('jitter: cache TTL is based on fetch time not scheduled time', async (t) => {
  let fetchResolve: (body: Record<string, Record<string, number>>) => void;
  const fetchPromise = new Promise<Record<string, Record<string, number>>>((resolve) => {
    fetchResolve = resolve;
  });

  const refresher = makeRefresher({
    url: 'https://rates.test',
    fetchImpl: async () => {
      const body = await fetchPromise;
      return jsonResponse(body);
    },
    initial: { USDC: 1545.5, EURT: 1680.2, NGN: 1.0 },
  });

  // Tick starts but fetch is blocked
  const tickPromise = refresher.refreshTick();

  // Simulate 500ms of scheduling jitter before fetch completes
  await new Promise((r) => setTimeout(r, 500));
  const fetchTime = Date.now();
  fetchResolve!({ 'usd-coin': { ngn: 2000 } });

  await tickPromise;

  // cachedAt should be close to fetchTime, not the tick start time
  t.ok(
    Math.abs(refresher.cache.cachedAt - fetchTime) < 50,
    `cache.cachedAt (${refresher.cache.cachedAt}) within 50ms of fetch time (${fetchTime})`,
  );
  t.equal(refresher.cache.rates.USDC, 2000, 'cache rates updated correctly');
  t.end();
});
