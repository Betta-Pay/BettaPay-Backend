/**
 * FX Engine — BettaPay Backend
 *
 * Provides exchange rate quotes for currency pairs.
 * Rates are fetched from an external API at a configurable interval and
 * cached in memory with a TTL. Hardcoded defaults serve as fallback.
 *
 * Endpoints:
 *   GET  /api/rates                          — latest cached rates with cache metadata
 *   GET  /api/rates/history?from=&to=&at=  — historical rate at a given timestamp
 *   GET  /api/currencies                    — list of supported currency codes
 *   GET  /api/quote?from=&to=&amount=       — FX quote (returns quoteId for verification)
 *   POST /api/quote/verify                  — verify a quote is still valid; returns currentRate
 */

import Fastify from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import * as promClient from "prom-client";
import { randomUUID, randomInt } from "crypto";
import { z } from "zod";
import type { Redis } from "ioredis";
import {
  resolveRate,
  computeQuote,
  type ComputedQuote,
  type ResolvedRate,
} from "./quote-computation.js";
import { Queue, Worker } from "bullmq";
import {
  validateEnvOrExit,
  registerErrorHandler,
  registerRequestId,
  registerServiceAuth,
  createErrorResponse,
  ErrorCodes,
  createLoggerOptions,
  registerTracing,
  CurrencyCode,
  buildFxEngineHealthResponse,
  readServiceVersion,
  createRedisClient,
  waitForRedis,
  startRedisMemoryMonitor,
  startMetricsServer,
  RateOverrideBody,
} from "@bettapay/validation";

const env = validateEnvOrExit(process.env);
const PORT = Number(process.env.PORT ?? "3002");
const startTime = Date.now();
const SERVICE_VERSION = readServiceVersion(import.meta.url);

// ── Fallback / seed rates (issue #47) ──────────────────────────────────────
// Used on first startup before the external API responds, and whenever the
// API is unreachable so the service degrades gracefully.

const FALLBACK_RATES: Record<string, number> = {
  USDC: 1545.5,
  EURT: 1680.2,
  NGN: 1.0,
};

const CURRENCY_DISPLAY_NAMES: Record<string, string> = {
  USDC: "USD Coin",
  EURT: "Euro Tether",
  NGN: "Nigerian Naira",
};

const SUPPORTED_CURRENCIES = Object.keys(FALLBACK_RATES);

// ── In-memory rate cache (issues #47 & #48) ────────────────────────────────

interface RateCache {
  rates: Record<string, number>;
  batchIds: Record<string, string>;
  cachedAt: number; // Unix ms timestamp
  rateCachedAt: Record<string, number>; // Unix ms timestamp per rate
}

const initialBatchId = randomUUID();
const initialTime = Date.now();
let cache: RateCache = {
  rates:    { ...FALLBACK_RATES },
  batchIds: Object.fromEntries(Object.keys(FALLBACK_RATES).map((c) => [c, initialBatchId])),
  cachedAt: initialTime,
  rateCachedAt: Object.fromEntries(Object.keys(FALLBACK_RATES).map((c) => [c, initialTime])),
};

// ── Computed pair-rate cache (issue #55) ───────────────────────────────────
// Avoids recomputing the same cross/inverse rate on every request.
// Keyed by "FROM_TO" (e.g. "USDC_EURT", "NGN_USDC").
// Entries expire after RATE_TTL_MS; the cache is also fully invalidated
// whenever base rates are refreshed via updateBaseRates().

const RATE_TTL_MS = 60_000;

interface ComputedRateEntry {
  rate: number;
  computedAt: number;
}

const computedRateCache = new Map<string, ComputedRateEntry>();

function computeRate(
  from: string,
  to: string,
  baseRates: Record<string, number>,
): number {
  // NGN is the base (rate === 1.0), so all three cases collapse to one formula:
  //   direct  (X → NGN):  baseRates[from] / 1          = baseRates[from]
  //   inverse (NGN → X):  1              / baseRates[to]
  //   cross   (X → Y):    baseRates[from] / baseRates[to]
  return baseRates[from] / baseRates[to];
}

/**
 * Resolve a pair rate through the single cache-or-live path (issue #566).
 *
 * `now` is passed in so a caller that also timestamps the quote uses one
 * clock reading for the TTL check, the cache write and the quote expiry.
 * The returned `source` is the very decision this call made, so callers
 * never re-peek at the cache to label metrics.
 */
function resolvePairRate(from: string, to: string, now = Date.now()): ResolvedRate {
  return resolveRate({
    key: `${from}_${to}`,
    now,
    ttlMs: RATE_TTL_MS,
    readCache: (key) => computedRateCache.get(key),
    writeCache: (key, entry) => {
      computedRateCache.set(key, entry);
    },
    computeLive: () => {
      const fromBatch = cache.batchIds[from];
      const toBatch   = cache.batchIds[to];

      if (!fromBatch) {
        throw new Error(`No rate batch information for ${from}`);
      }
      if (!toBatch) {
        throw new Error(`No rate batch information for ${to}`);
      }

      if (fromBatch !== toBatch) {
        fastify.log.warn(
          { from, to, fromBatch, toBatch },
          'Cross-rate computed with rates from different fetch cycles',
        );
      }

      return computeRate(from, to, cache.rates);
    },
  });
}

function getOrComputeRate(from: string, to: string): number {
  return resolvePairRate(from, to).rate;
}

// ── Rate history snapshots (issue #56) ───────────────────────────────────
// Snapshots are stored in a Redis Sorted Set (score = Unix ms timestamp).
// ZREVRANGEBYSCORE lets us find the closest snapshot at or before any point
// in time in O(log N). Entries older than SNAPSHOT_RETENTION_MS are pruned
// on each write.

// Assigned after Fastify is created so the error handler can use fastify.log.
// The definite-assignment assertion is safe: storeRateSnapshot is only called
// at runtime (never during synchronous module init), by which point redis is set.
let redis!: Redis;

const SNAPSHOT_KEY = "fx:rate_snapshots";
const SNAPSHOT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

async function storeRateSnapshot(rates: Record<string, number>): Promise<void> {
  const now = Date.now();
  const cutoff = now - SNAPSHOT_RETENTION_MS;
  await redis
    .pipeline()
    .zadd(SNAPSHOT_KEY, now, JSON.stringify({ ts: now, rates }))
    .zremrangebyscore(SNAPSHOT_KEY, "-inf", cutoff)
    .exec();
}

function updateBaseRates(updated: Record<string, number>, batchId: string, newlyFetched?: string[]): void {
  const now = Date.now();
  for (const [currency, value] of Object.entries(updated)) {
    cache.rates[currency] = value;
    cache.batchIds[currency] = batchId;
    if (!newlyFetched || newlyFetched.includes(currency) || currency === 'NGN') {
      cache.rateCachedAt[currency] = now;
    }
  }
  cache.cachedAt = now;
  computedRateCache.clear();
  storeRateSnapshot({ ...cache.rates }).catch(() => {}); // Redis errors are non-fatal
}

// ── Live rate refresh loop (issue #251) ────────────────────────────────────
//
// The external rates API (RATES_API_URL) is polled every RATES_REFRESH_INTERVAL_MS
// to keep cache.rates in sync with the source. On any failure the existing
// cache is preserved and the next interval retries — the fallback rates stay
// live until the next successful tick.
//
// The response shape is the CoinGecko `simple/price` payload:
//   { "<asset-id>": { "<vs-currency>": <price> } }
// e.g. { "usd-coin": { "ngn": 1545.5 } }
//
// We map the known asset ids to the keys in cache.rates (USDC, EURT, NGN).
// Any asset id missing from the response is left at its previous value.

const RATE_FETCH_TIMEOUT_MS = 10_000;
const ASSET_ID_TO_KEY: Record<string, string> = {
  "usd-coin": "USDC",
  "tether-eurt": "EURT",
  // NGN is the base currency (rate === 1.0) and not fetched.
};

let refreshIntervalHandle: ReturnType<typeof setInterval> | null = null;
let lastRefresh: {
  at: number;
  ok: boolean;
  durationMs: number;
  error?: string;
} | null = null;
let lastSuccessfulFetch: number | null = null;
let lastOverrideAt: number | null = null;
let fallbackStartTime: number | null = null;

const fxFallbackEventsTotal = new promClient.Counter({
  name: "fx_fallback_events_total",
  help: "Total number of fallback events triggered",
});

const fxFallbackActive = new promClient.Gauge({
  name: "fx_fallback_active",
  help: "Indicates if the system is currently in fallback mode (1 = fallback, 0 = live)",
});
fxFallbackActive.set(0);

// Log every 5 minutes when in fallback mode
const FALLBACK_WARNING_INTERVAL_MS = 5 * 60 * 1000;

// ── Circuit breaker for CoinGecko API calls ────────────────────────────────
//
// States:
//   CLOSED   — normal operation; failures are counted.
//   OPEN     — tripped after the configured failure threshold consecutive
//              failures; fetches are skipped until the cooldown expires.
//   HALF_OPEN — after the cooldown a single probe fetch is allowed.
//              Success → CLOSED, failure → OPEN (resets cooldown).
//
// The threshold is env-configurable (CIRCUIT_BREAKER_FAILURE_THRESHOLD,
// default 5) so different upstreams can have different resilience profiles
// (issue #498). The cooldown window is driven by
// CIRCUIT_BREAKER_COOLDOWN_MS (env, default 5 min).

export type CircuitBreakerState = "CLOSED" | "OPEN" | "HALF_OPEN";

interface CircuitBreaker {
  state: CircuitBreakerState;
  consecutiveFailures: number;
  openedAt: number | null; // Unix ms when state became OPEN
  lastTransitionAt: number; // Unix ms of last state change (for observability)
}

const circuitBreaker: CircuitBreaker = {
  state: "CLOSED",
  consecutiveFailures: 0,
  openedAt: null,
  lastTransitionAt: Date.now(),
};

function transitionCircuitBreaker(
  newState: CircuitBreakerState,
  log: { info: (obj: object, msg: string) => void },
): void {
  const prev = circuitBreaker.state;
  if (prev === newState) return;

  circuitBreaker.state = newState;
  circuitBreaker.lastTransitionAt = Date.now();

  if (newState === "OPEN") {
    circuitBreaker.openedAt = Date.now();
  } else if (newState === "CLOSED") {
    circuitBreaker.consecutiveFailures = 0;
    circuitBreaker.openedAt = null;
  }

  log.info(
    {
      from: prev,
      to: newState,
      consecutiveFailures: circuitBreaker.consecutiveFailures,
    },
    `Circuit breaker transition: ${prev} → ${newState}`,
  );
}

function recordCircuitBreakerSuccess(log: {
  info: (obj: object, msg: string) => void;
}): void {
  circuitBreaker.consecutiveFailures = 0;
  if (circuitBreaker.state !== "CLOSED") {
    transitionCircuitBreaker("CLOSED", log);
  }
}

function recordCircuitBreakerFailure(
  log: { info: (obj: object, msg: string) => void },
  cooldownMs: number,
): void {
  circuitBreaker.consecutiveFailures += 1;

  if (
    circuitBreaker.state === "HALF_OPEN" ||
    (circuitBreaker.state === "CLOSED" &&
      circuitBreaker.consecutiveFailures >= env.CIRCUIT_BREAKER_FAILURE_THRESHOLD)
  ) {
    transitionCircuitBreaker("OPEN", log);
  }
}

function getCircuitBreakerState(cooldownMs: number): CircuitBreakerState {
  if (
    circuitBreaker.state === "OPEN" &&
    circuitBreaker.openedAt !== null &&
    Date.now() - circuitBreaker.openedAt >= cooldownMs
  ) {
    // Cooldown elapsed — advance to HALF_OPEN for the next probe.
    // We do not call transitionCircuitBreaker here to avoid needing a logger
    // reference; the probe in refreshTick will perform the actual transition.
    circuitBreaker.state = "HALF_OPEN";
    circuitBreaker.lastTransitionAt = Date.now();
  }
  return circuitBreaker.state;
}

async function fetchBaseRates(): Promise<Record<string, number> | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), RATE_FETCH_TIMEOUT_MS);
  const startedAt = Date.now();
  try {
    const res = await fetch(env.RATES_API_URL, { signal: controller.signal });
    if (!res.ok) {
      const msg = `RATES_API_URL responded ${res.status} ${res.statusText}`;
      fastify.log.warn({ status: res.status, url: env.RATES_API_URL }, msg);
      lastRefresh = {
        at: Date.now(),
        ok: false,
        durationMs: Date.now() - startedAt,
        error: msg,
      };
      return null;
    }
    const body = (await res.json()) as Record<string, Record<string, number>>;
    const fetched: Record<string, number> = {};
    for (const [assetId, byVs] of Object.entries(body)) {
      const key = ASSET_ID_TO_KEY[assetId];
      if (!key) continue;
      const value = byVs?.ngn;
      if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
        continue;
      fetched[key] = value;
    }
    if (Object.keys(fetched).length === 0) {
      const msg = "RATES_API_URL response had no recognised assets";
      fastify.log.warn({ body }, msg);
      lastRefresh = {
        at: Date.now(),
        ok: false,
        durationMs: Date.now() - startedAt,
        error: msg,
      };
      return null;
    }
    lastRefresh = {
      at: Date.now(),
      ok: true,
      durationMs: Date.now() - startedAt,
    };
    lastSuccessfulFetch = Date.now();
    fallbackStartTime = null;
    fxFallbackActive.set(0);
    return fetched;
  } catch (err) {
    const e = err as Error;
    const msg =
      e.name === "AbortError"
        ? "RATES_API_URL fetch timed out"
        : `RATES_API_URL fetch failed: ${e.message}`;
    fastify.log.warn({ err: e.message }, msg);
    lastRefresh = {
      at: Date.now(),
      ok: false,
      durationMs: Date.now() - startedAt,
      error: msg,
    };
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// #388 — cache stampede protection constants
const RATE_FETCH_LOCK_KEY = "rate_fetch_lock:global";
const RATE_FETCH_LOCK_TTL_MS = 5_000;
const STAMPEDE_POLL_INTERVAL = 50; // ms between polls
const STAMPEDE_POLL_TIMEOUT = 5_000; // ms before giving up and fetching directly

// Acquire a SET NX lock in Redis. Returns the lock token if acquired, null otherwise.
async function acquireRateFetchLock(): Promise<string | null> {
  const token = randomUUID();
  const result = await redis
    .set(RATE_FETCH_LOCK_KEY, token, "PX", RATE_FETCH_LOCK_TTL_MS, "NX")
    .catch(() => null);
  return result === "OK" ? token : null;
}

async function releaseRateFetchLock(token: string): Promise<void> {
  // Only delete the key if we still own it (Lua for atomicity)
  const script = `
    if redis.call("get", KEYS[1]) == ARGV[1] then
      return redis.call("del", KEYS[1])
    else
      return 0
    end
  `;
  await redis.eval(script, 1, RATE_FETCH_LOCK_KEY, token).catch(() => {});
}

async function refreshTick(): Promise<void> {
  try {
    // ── Circuit breaker gate ────────────────────────────────────────────────
    const cbState = getCircuitBreakerState(env.CIRCUIT_BREAKER_COOLDOWN_MS);

    if (cbState === "OPEN") {
      // Still in cooldown — skip fetch entirely to avoid log noise.
      return;
    }

    // HALF_OPEN: one probe is allowed; we log the intent so it is auditable.
    if (cbState === "HALF_OPEN") {
      // Log the probe intent for auditing purposes
      fastify.log.info(
        { consecutiveFailures: circuitBreaker.consecutiveFailures },
        "Circuit breaker HALF_OPEN: probing CoinGecko",
      );
    }

    // #388 — attempt to acquire the distributed fetch lock
    const lockToken = await acquireRateFetchLock().catch(() => null);

    if (lockToken !== null) {
      // We hold the lock — perform the fetch
      try {
        const fetched = await fetchBaseRates();
        if (fetched) {
          const batchId = randomUUID();
          const maxDeviationBps = env.MAX_DEVIATION_BPS;
          const merged: Record<string, number> = { ...cache.rates };
          const rejected: string[] = [];
          const newlyFetched: string[] = [];
          for (const [asset, newRate] of Object.entries(fetched)) {
            const oldRate = cache.rates[asset];
            if (oldRate === undefined || oldRate === 0) {
              merged[asset] = newRate;
              newlyFetched.push(asset);
              continue;
            }
            const deviationBps =
              (Math.abs(newRate - oldRate) / oldRate) * 10000;
            if (deviationBps > maxDeviationBps) {
              rejected.push(
                `${asset}: ${oldRate} → ${newRate} (${deviationBps.toFixed(0)} bps > ${maxDeviationBps} max)`,
              );
              continue;
            }
            merged[asset] = newRate;
            newlyFetched.push(asset);
          }
          if (rejected.length > 0) {
            fastify.log.warn(
              { rejected, maxDeviationBps },
              "Rate deviation guard rejected rates; old rates preserved",
            );
          }
          updateBaseRates(merged, batchId, newlyFetched);
          recordCircuitBreakerSuccess(fastify.log);
          fastify.log.info(
            {
              durationMs: lastRefresh?.durationMs,
              assets: Object.keys(fetched),
              rateBatchId: batchId,
              rejectedCount: rejected.length,
            },
            "FX rates refreshed",
          );
        } else {
          recordCircuitBreakerFailure(
            fastify.log,
            env.CIRCUIT_BREAKER_COOLDOWN_MS,
          );
          if (fallbackStartTime === null) {
            fallbackStartTime = Date.now();
            fastify.log.warn("Entering fallback FX rate mode");
            fxFallbackEventsTotal.inc();
            fxFallbackActive.set(1);
          }
        }
      } finally {
        await releaseRateFetchLock(lockToken);
      }
      return;
    }

    // Lock not acquired — another instance is fetching. Busy-poll the snapshot
    // store until the lock holder populates it or the timeout expires.
    const deadline = Date.now() + STAMPEDE_POLL_TIMEOUT;
    const snapshotBefore = cache.cachedAt;

    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, STAMPEDE_POLL_INTERVAL));
      if (cache.cachedAt > snapshotBefore) {
        fastify.log.info(
          "Stampede protection: another instance refreshed the rate cache",
        );
        return;
      }
    }

    // Lock holder may have failed — attempt fetch ourselves as fallback
    fastify.log.warn("Stampede poll timed out; falling back to direct fetch");
    const fetched = await fetchBaseRates();
    if (fetched) {
      const batchId = randomUUID();
      const maxDeviationBps = env.MAX_DEVIATION_BPS;
      const merged: Record<string, number> = { ...cache.rates };
      const rejected: string[] = [];
      const newlyFetched: string[] = [];
      for (const [asset, newRate] of Object.entries(fetched)) {
        const oldRate = cache.rates[asset];
        if (oldRate === undefined || oldRate === 0) {
          merged[asset] = newRate;
          newlyFetched.push(asset);
          continue;
        }
        const deviationBps =
          (Math.abs(newRate - oldRate) / oldRate) * 10000;
        if (deviationBps > maxDeviationBps) {
          rejected.push(
            `${asset}: ${oldRate} → ${newRate} (${deviationBps.toFixed(0)} bps > ${maxDeviationBps} max)`,
          );
          continue;
        }
        merged[asset] = newRate;
        newlyFetched.push(asset);
      }
      if (rejected.length > 0) {
        fastify.log.warn(
          { rejected, maxDeviationBps },
          "Rate deviation guard rejected rates (stampede fallback); old rates preserved",
        );
      }
      updateBaseRates(merged, batchId, newlyFetched);
      recordCircuitBreakerSuccess(fastify.log);
    } else {
      recordCircuitBreakerFailure(fastify.log, env.CIRCUIT_BREAKER_COOLDOWN_MS);
      if (fallbackStartTime === null) {
        fallbackStartTime = Date.now();
        fastify.log.warn("Entering fallback FX rate mode");
        fxFallbackEventsTotal.inc();
        fxFallbackActive.set(1);
      }
    }
  } catch (err) {
    fastify.log.error({ err }, "Unexpected error in refresh tick");
  }
}

async function warmupCacheFromRedis(): Promise<void> {
  let loadedCount = 0;
  let discardedCount = 0;
  const now = Date.now();

  try {
    const members = await redis.zrevrangebyscore(
      SNAPSHOT_KEY,
      "+inf",
      "-inf",
      "LIMIT",
      0,
      1,
    );
    if (!members.length) {
      fastify.log.info(
        "No cached rate snapshot found in Redis; using fallback rates",
      );
      warmupStats = { loadedCount: 0, discardedCount: 0, timestamp: null };
      return;
    }

    const snapshot = JSON.parse(members[0]) as {
      ts: number;
      rates: Record<string, number>;
    };
    const validatedRates: Record<string, number> = {};

    // Issue #340 — Validate each rate during warmup
    for (const [currency, rate] of Object.entries(snapshot.rates)) {
      // Validate: positive number
      if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) {
        fastify.log.warn(
          { currency, rate },
          "[FX] Warmup: discarding invalid rate (not a positive number)",
        );
        discardedCount++;
        continue;
      }

      // Validate: supported currency
      if (!SUPPORTED_CURRENCIES.includes(currency)) {
        fastify.log.warn(
          { currency, rate },
          "[FX] Warmup: discarding invalid rate (unsupported currency)",
        );
        discardedCount++;
        continue;
      }

      validatedRates[currency] = rate;
      loadedCount++;
    }

    // Validate: fetchedAt not in future
    if (snapshot.ts > now) {
      fastify.log.warn(
        {
          snapshotTime: new Date(snapshot.ts).toISOString(),
          currentTime: new Date(now).toISOString(),
        },
        "[FX] Warmup: snapshot timestamp is in the future; using fallback rates",
      );
      warmupStats = {
        loadedCount: 0,
        discardedCount: Object.keys(snapshot.rates).length,
        timestamp: new Date(snapshot.ts).toISOString(),
      };
      return;
    }

    // If all rates for all currencies were discarded, trigger immediate fetch
    if (Object.keys(validatedRates).length === 0) {
      fastify.log.warn(
        { loadedCount, discardedCount },
        "[FX] Warmup: all rates discarded; triggering immediate fetch",
      );
      warmupStats = {
        loadedCount,
        discardedCount,
        timestamp: new Date(snapshot.ts).toISOString(),
      };
      await refreshTick();
      return;
    }

    warmupStats = {
      loadedCount,
      discardedCount,
      timestamp: new Date(snapshot.ts).toISOString(),
    };
    updateBaseRates(validatedRates, randomUUID());
    computedRateCache.clear();
    fastify.log.info(
      {
        timestamp: new Date(snapshot.ts).toISOString(),
        rates: validatedRates,
        loadedCount,
        discardedCount,
      },
      "Rate cache warmed up from Redis snapshot",
    );
  } catch (err) {
    const e = err as Error;
    fastify.log.warn(
      { err: e.message },
      "Failed to warm up cache from Redis; using fallback rates",
    );
    warmupStats = { loadedCount: 0, discardedCount: 0, timestamp: null };
  }
}

let fallbackWarningIntervalHandle: ReturnType<typeof setInterval> | null = null;

// Issue #340 — Warmup stats for admin endpoint
let warmupStats: {
  loadedCount: number;
  discardedCount: number;
  timestamp: string | null;
} = {
  loadedCount: 0,
  discardedCount: 0,
  timestamp: null,
};

function scheduleNextRefresh(): void {
  const base = env.RATES_REFRESH_INTERVAL_MS;
  const halfRange = Math.round(base * 0.25);
  const jitter = randomInt(-halfRange, halfRange + 1);
  const delay = base + jitter;

  fastify.log.info(
    { baseInterval: base, delay, jitter },
    "Scheduling next FX rate refresh",
  );

  refreshIntervalHandle = setTimeout(() => {
    refreshTick().finally(() => {
      if (refreshIntervalHandle !== null) {
        scheduleNextRefresh();
      }
    });
  }, delay);

  if (typeof refreshIntervalHandle.unref === "function") {
    refreshIntervalHandle.unref();
  }
}

function startRefreshLoop(): void {
  if (refreshIntervalHandle !== null) return;
  scheduleNextRefresh();
  fastify.log.info(
    { intervalMs: env.RATES_REFRESH_INTERVAL_MS, url: env.RATES_API_URL },
    "FX rate refresh loop started",
  );

  // Log warning every 5 minutes if in fallback mode (#236)
  if (fallbackWarningIntervalHandle === null) {
    fallbackWarningIntervalHandle = setInterval(() => {
      if (fallbackStartTime !== null) {
        const durationMs = Date.now() - fallbackStartTime;
        const durationMin = Math.round(durationMs / 60000);
        fastify.log.warn(
          { durationMs, durationMin },
          `Operating in fallback FX rate mode for ${durationMin} minute(s); rates API unavailable`,
        );
      }
    }, FALLBACK_WARNING_INTERVAL_MS);
    if (typeof fallbackWarningIntervalHandle.unref === "function") {
      fallbackWarningIntervalHandle.unref();
    }
  }
}

// ── Quote storage (issue #57) ────────────────────────────────────────────
// Quotes are stored in Redis under fx:quote:<quoteId>.
//
// Two TTLs:
//   QUOTE_TTL_MS         — how long the rate is locked / valid (60 s, = RATE_TTL_MS)
//   QUOTE_CLEANUP_TTL_MS — how long the key lives in Redis    (10 min)
//
// The longer cleanup TTL lets POST /api/quote/verify return
// { valid: false, stale: true, currentRate } for expired-but-known quotes
// instead of a 404, so clients can see how much the rate has moved.

const QUOTE_TTL_MS = RATE_TTL_MS;
const QUOTE_CLEANUP_TTL_MS = 10 * 60 * 1000;
const QUOTE_KEY_PREFIX = "fx:quote:";

interface StoredQuote {
  quoteId: string;
  from: string;
  to: string;
  amount: string;
  result: string;
  rate: string;
  slippageBps: number;
  expiresAt:   number; // Unix ms — quote validity cutoff
  rateBatchId: string;
  unroundedRate?: number;
}

export const fastify = Fastify({
  logger: createLoggerOptions({ level: env.LOG_LEVEL }),
});

registerRequestId(fastify);
// #386 — exponential backoff retry strategy
const redisHealthState: import('@bettapay/validation').RedisHealthState = {
  connected: false,
  errors: 0,
  reconnects: 0,
};

redis = createRedisClient(env.REDIS_URL, fastify.log, { healthState: redisHealthState });
redis.on("error", (err: any) =>
  fastify.log.warn({ err: err.message }, "Redis error in fx-engine"),
);
fastify.addHook("onClose", async () => {
  await redis.quit().catch(() => {});
});

// ── Rate history cleanup job ──────────────────────────────────────────────
// BullMQ repeatable job that runs daily to purge rate history snapshots
// older than RATE_HISTORY_RETENTION_DAYS.  Re-reads the env var each run
// so operators can tune retention without a restart.

const redisConn = new URL(env.REDIS_URL);
const bullMqConnection = {
  host: redisConn.hostname,
  port: parseInt(redisConn.port || "6379", 10),
  maxRetriesPerRequest: 3,
  retryStrategy: (times: number) => {
    const delay = Math.min(Math.pow(2, times) * 100, 5_000);
    fastify.log.warn(
      { attempt: times, delayMs: delay },
      "BullMQ Redis connection retry (cleanup)",
    );
    return delay;
  },
};

const RATE_CLEANUP_LOCK_KEY = "rate_cleanup_lock:global";
const RATE_CLEANUP_LOCK_TTL_MS = 30_000;

async function acquireCleanupLock(): Promise<string | null> {
  const token = randomUUID();
  const result = await redis
    .set(RATE_CLEANUP_LOCK_KEY, token, "PX", RATE_CLEANUP_LOCK_TTL_MS, "NX")
    .catch(() => null);
  return result === "OK" ? token : null;
}

async function releaseCleanupLock(token: string): Promise<void> {
  const script = `
    if redis.call("get", KEYS[1]) == ARGV[1] then
      return redis.call("del", KEYS[1])
    else
      return 0
    end
  `;
  await redis.eval(script, 1, RATE_CLEANUP_LOCK_KEY, token).catch(() => {});
}

/**
 * Reads RATE_HISTORY_RETENTION_DAYS from the environment each invocation
 * (no restart required when the value changes) and purges rate history
 * snapshots older than the retention window from the Redis sorted set.
 *
 * @returns Number of entries removed.
 */
async function runRateHistoryCleanup(): Promise<number> {
  const lockToken = await acquireCleanupLock();
  if (!lockToken) {
    fastify.log.info("Rate history cleanup skipped (lock held by another instance)");
    return 0;
  }

  try {
    const retentionDays = parseInt(
      process.env.RATE_HISTORY_RETENTION_DAYS ?? "7",
      10,
    );
    const effectiveDays =
      Number.isFinite(retentionDays) && retentionDays >= 1 ? retentionDays : 7;
    const cutoff = Date.now() - effectiveDays * 24 * 60 * 60 * 1000;

    const purged = await redis.zremrangebyscore(SNAPSHOT_KEY, "-inf", cutoff);
    fastify.log.info(
      {
        purged,
        retentionDays: effectiveDays,
        cutoff: new Date(cutoff).toISOString(),
      },
      "Rate history cleanup completed",
    );
    return purged;
  } finally {
    await releaseCleanupLock(lockToken);
  }
}

const cleanupQueue = new Queue("rate-history-cleanup", {
  connection: bullMqConnection,
  defaultJobOptions: {
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 50 },
  },
});

const cleanupWorker = new Worker(
  "rate-history-cleanup",
  async (_job) => {
    await runRateHistoryCleanup();
  },
  {
    connection: bullMqConnection,
    concurrency: 1,
    autorun: true,
  },
);

cleanupWorker.on("error", (err) => {
  fastify.log.error({ err: err.message }, "Rate history cleanup worker error");
});

cleanupQueue.on("error", (err) => {
  fastify.log.error({ err: err.message }, "Rate history cleanup queue error");
});

fastify.register(cors, {
  origin: env.ALLOWED_ORIGINS,
});
fastify.register(rateLimit, { max: 200, timeWindow: 60 * 1000 });
registerErrorHandler(fastify);
registerServiceAuth(fastify, env.INTER_SERVICE_SECRET);
// Distributed tracing: log + propagate x-request-id / x-trace-id (#118).
registerTracing(fastify);

// ── Rate staleness helpers ───────────────────────────────────────────────────

function getRateSource(): "live" | "seed" {
  return lastSuccessfulFetch !== null ? "live" : "seed";
}

function logRateStalenessIfStale(
  log: { warn: (obj: object, msg: string) => void; error: (obj: object, msg: string) => void },
  pair?: string,
): void {
  const now = Date.now();
  let maxStalenessSeconds = 0;
  let timestamp = cache.cachedAt;
  
  if (pair) {
    const [from, to] = pair.split('_');
    const fromAge = now - (cache.rateCachedAt[from] ?? cache.cachedAt);
    const toAge = now - (cache.rateCachedAt[to] ?? cache.cachedAt);
    if (fromAge > toAge) {
      maxStalenessSeconds = Math.floor(fromAge / 1000);
      timestamp = cache.rateCachedAt[from] ?? cache.cachedAt;
    } else {
      maxStalenessSeconds = Math.floor(toAge / 1000);
      timestamp = cache.rateCachedAt[to] ?? cache.cachedAt;
    }
  } else {
    for (const age of Object.values(cache.rateCachedAt)) {
      const staleness = Math.floor((now - age) / 1000);
      if (staleness > maxStalenessSeconds) {
        maxStalenessSeconds = staleness;
        timestamp = age;
      }
    }
  }

  const stalenessSeconds = maxStalenessSeconds;
  if (stalenessSeconds <= env.MAX_STALE_SECONDS) return;

  const source = getRateSource();
  const baseFields = {
    source,
    rateTimestamp: new Date(timestamp).toISOString(),
    stalenessSeconds,
    threshold: env.MAX_STALE_SECONDS,
  };
  const pairFields = pair ? { ...baseFields, currencyPair: pair } : baseFields;

  if (source === "live") {
    log.warn(
      pairFields,
      pair
        ? `Stale rate served for ${pair} (${stalenessSeconds}s old, source: live)`
        : `Stale rates served (${stalenessSeconds}s old, source: live)`,
    );
  } else {
    log.error(
      pairFields,
      pair
        ? `Stale rate served for ${pair} (${stalenessSeconds}s old, source: seed)`
        : `Stale rates served (${stalenessSeconds}s old, source: seed)`,
    );
  }
}

fastify.get("/api/health", async (_request, reply) => {
  const health = await buildFxEngineHealthResponse({
    pingRedis: () => redis.ping(),
    redisHealthState,
    ratesApiUrl: env.RATES_API_URL,
    startTime,
    service: "fx-engine",
    version: SERVICE_VERSION,
  });

  // Per-pair rate feed freshness (TTL-based status)
  const now = Date.now();
  const FEED_TTL_MS = env.RATES_REFRESH_INTERVAL_MS;

  const rateFeeds: Record<
    string,
    {
      status: "healthy" | "stale" | "down";
      lastUpdated: string;
      ageMs: number;
    }
  > = {};

  const rateKeys = Object.keys(cache.rates);
  if (rateKeys.length === 0) {
    for (const currency of Object.keys(FALLBACK_RATES)) {
      const ageMs = now - (cache.rateCachedAt[currency] ?? cache.cachedAt);
      rateFeeds[currency] = {
        status: "down",
        lastUpdated: new Date(cache.rateCachedAt[currency] ?? cache.cachedAt).toISOString(),
        ageMs,
      };
    }
  } else {
    for (const currency of rateKeys) {
      const ageMs = now - (cache.rateCachedAt[currency] ?? cache.cachedAt);
      let status: "healthy" | "stale" | "down";
      if (ageMs >= 2 * FEED_TTL_MS) {
        status = "down";
      } else if (ageMs >= FEED_TTL_MS) {
        status = "stale";
      } else {
        status = "healthy";
      }
      rateFeeds[currency] = {
        status,
        lastUpdated: new Date(cache.rateCachedAt[currency] ?? cache.cachedAt).toISOString(),
        ageMs,
      };
    }
  }

  const feedValues = Object.values(rateFeeds);
  const feedStatus: "healthy" | "degraded" | "down" = feedValues.some(
    (f) => f.status === "down",
  )
    ? "down"
    : feedValues.some((f) => f.status === "stale")
      ? "degraded"
      : "healthy";

  if (feedStatus === "down" && health.status !== "unhealthy") {
    health.status = "unhealthy";
  } else if (feedStatus === "degraded" && health.status === "healthy") {
    health.status = "degraded";
  }

  // Degrade to degraded if fallback mode has been active for >1 hour (#236)
  const ONE_HOUR_MS = 60 * 60 * 1000;
  let fallbackExceeded = false;
  if (
    fallbackStartTime !== null &&
    Date.now() - fallbackStartTime > ONE_HOUR_MS
  ) {
    fallbackExceeded = true;
    if (health.status !== "unhealthy") {
      health.status = "degraded";
    }
  }

  const ratesApi = health.upstream?.find((d) => d.name === "rates-api");
  if (ratesApi) {
    if (feedStatus === "down") {
      ratesApi.status = "unhealthy";
    } else if (feedStatus === "degraded" && ratesApi.status === "healthy") {
      ratesApi.status = "degraded";
    }
    if (fallbackExceeded) {
      ratesApi.status = ratesApi.status === "healthy" ? "degraded" : ratesApi.status;
    }
    ratesApi.details = {
      ...(ratesApi.details ?? {}),
      latencyMs: lastRefresh?.durationMs ?? null,
      circuitBreakerState: circuitBreaker.state,
    };
    if (fallbackExceeded) {
      ratesApi.details.fallbackModeDuration = "exceeded 1 hour";
    }
  }

  const statusCode = health.status === "unhealthy" ? 503 : 200;
  return reply.code(statusCode).send({ ...health, feedStatus, rateFeeds });
});

fastify.get("/api/rates", async (_request, _reply) => {
  logRateStalenessIfStale(fastify.log);
  return {
    rates: cache.rates,
    updatedAt: new Date(cache.cachedAt).toISOString(),
  };
});

fastify.get("/api/currencies", async (_request, _reply) => {
  return {
    currencies: SUPPORTED_CURRENCIES.map((code) => ({
      code,
      name: CURRENCY_DISPLAY_NAMES[code],
    })),
  };
});

// ── GET /api/admin/rates/status (#236) ─────────────────────────────────
// Admin endpoint showing rate fetch mode (live vs fallback), staleness, and duration.
// Also exposes the CoinGecko circuit breaker state (#CB).

fastify.get(
  "/api/admin/rates/status",
  {
    preValidation: [fastify.serviceAuth],
  },
  async (_request, _reply) => {
    const inFallback = fallbackStartTime !== null;
    const fallbackDurationMs =
      fallbackStartTime !== null ? Date.now() - fallbackStartTime : 0;
    const fallbackDurationMin = Math.round(fallbackDurationMs / 60000);

    // Evaluate cooldown expiry without side-effects (read-only snapshot)
    const cbSnapshot = {
      state: circuitBreaker.state,
      consecutiveFailures: circuitBreaker.consecutiveFailures,
      openedAt: circuitBreaker.openedAt
        ? new Date(circuitBreaker.openedAt).toISOString()
        : null,
      lastTransitionAt: new Date(circuitBreaker.lastTransitionAt).toISOString(),
      cooldownMs: env.CIRCUIT_BREAKER_COOLDOWN_MS,
      cooldownRemainingMs:
        circuitBreaker.state === "OPEN" && circuitBreaker.openedAt !== null
          ? Math.max(
              0,
              env.CIRCUIT_BREAKER_COOLDOWN_MS -
                (Date.now() - circuitBreaker.openedAt),
            )
          : 0,
    };

    // Per-pair rate staleness
    const now = Date.now();
    const source = getRateSource();
    const rateStaleness: Record<
      string,
      { source: "live" | "seed"; lastUpdated: string; stalenessSeconds: number; stale: boolean }
    > = {};
    for (const currency of Object.keys(cache.rates)) {
      const stalenessSeconds = Math.floor((now - (cache.rateCachedAt[currency] ?? cache.cachedAt)) / 1000);
      rateStaleness[currency] = {
        source,
        lastUpdated: new Date(cache.rateCachedAt[currency] ?? cache.cachedAt).toISOString(),
        stalenessSeconds,
        stale: stalenessSeconds > env.MAX_STALE_SECONDS,
      };
    }

    return {
      mode: inFallback ? "fallback" : "live",
      lastSuccessfulFetch: lastSuccessfulFetch
        ? new Date(lastSuccessfulFetch).toISOString()
        : null,
      fallbackActiveDuration: inFallback
        ? `${fallbackDurationMin} minutes`
        : null,
      fallbackActiveDurationMs: fallbackDurationMs,
      circuitBreaker: cbSnapshot,
      warmup: warmupStats,
      currentRates: cache.rates,
      updatedAt: new Date(cache.cachedAt).toISOString(),
      rateStaleness,
    };
  },
);

// ── POST /api/admin/rates/override ───────────────────────────────────────
// Admin override endpoint: bypasses the deviation guard and forces new rates
// into the cache. Requires a valid x-service-token.

fastify.post<{ Body: unknown }>(
  "/api/admin/rates/override",
  {
    preValidation: [fastify.serviceAuth],
  },
  async (request, reply) => {
    let body: z.infer<typeof RateOverrideBody>;
    try {
      body = RateOverrideBody.parse(request.body);
    } catch (err) {
      if (err instanceof z.ZodError) {
        return reply
          .code(400)
          .send(
            createErrorResponse(
              ErrorCodes.VALIDATION_ERROR,
              "Invalid override body",
              err.errors,
            ),
          );
      }
      throw err;
    }

    lastOverrideAt = Date.now();
    updateBaseRates({ ...cache.rates, ...body.rates }, randomUUID());
    fastify.log.warn(
      { rates: body.rates },
      "Admin override: rate deviation guard bypassed",
    );
    return {
      status: "ok",
      overriddenAt: new Date(lastOverrideAt).toISOString(),
      rates: body.rates,
    };
  },
);

// ── GET /api/quote (issues #48 & #49) ────────────────────────────────────

const QuoteQuerySchema = z.object({
  from: CurrencyCode.default("USDC"),
  to: CurrencyCode.default("NGN"),
  amount: z
    .string()
    .regex(/^\d+(\.\d+)?$/, "amount must be a numeric string")
    .default("1"),
  slippageBps: z
    .string()
    .regex(/^\d+$/, "slippageBps must be a non-negative integer")
    .optional(),
});

fastify.get(
  "/api/quote",
  {
    config: {
      rateLimit: {
        max: 100,
        timeWindow: 60 * 1000,
      },
    },
  },
  async (request, reply) => {
    // Issue #342 — Track quote creation latency
    const quoteStartTime = Date.now();
    let cacheHit = false;

    let query: z.infer<typeof QuoteQuerySchema>;
    try {
      query = QuoteQuerySchema.parse(request.query);
    } catch (err) {
      if (err instanceof z.ZodError) {
        return reply
          .code(400)
          .send(
            createErrorResponse(
              ErrorCodes.INVALID_QUERY,
              "Invalid query parameters",
              err.errors,
            ),
          );
      }
      throw err;
    }

    const from = query.from.toUpperCase();
    const to = query.to.toUpperCase();
    const amount = parseFloat(query.amount);

    if (amount <= 0) {
      return reply
        .code(400)
        .send(
          createErrorResponse(
            ErrorCodes.INVALID_AMOUNT,
            "Amount must be greater than zero",
          ),
        );
    }

    // Validate that both currencies are supported (issue #49)
    const unsupported: string[] = [];
    if (!SUPPORTED_CURRENCIES.includes(from)) unsupported.push(from);
    if (!SUPPORTED_CURRENCIES.includes(to)) unsupported.push(to);

    if (unsupported.length > 0) {
      return reply.code(400).send(
        createErrorResponse(
          ErrorCodes.UNSUPPORTED_CURRENCY_PAIR,
          `Unsupported currency: ${unsupported.join(", ")}`,
          {
            unsupportedCurrencies: unsupported,
            supportedCurrencies: SUPPORTED_CURRENCIES,
          },
        ),
      );
    }

    if (from === to) {
      return reply
        .code(400)
        .send(
          createErrorResponse(
            ErrorCodes.INVALID_QUERY,
            "from and to must be different currencies",
          ),
        );
    }

    const requestedBps =
      query.slippageBps !== undefined
        ? parseInt(query.slippageBps, 10)
        : env.DEFAULT_SLIPPAGE_BPS;
    const effectiveBps = Math.min(requestedBps, env.MAX_SLIPPAGE_BPS);

    // Issue #566 — one cache-or-live resolution, one computation, one rounding.
    // `resolvePairRate` reports whether it served a cached rate or fell back to
    // a live computation, so the #342 cache_hit label describes the very rate
    // this quote was built from rather than a separate, racy cache peek.
    const resolvedAt = Date.now();
    const resolved = resolvePairRate(from, to, resolvedAt);
    cacheHit = resolved.source === "cache";
    logRateStalenessIfStale(fastify.log, `${from}_${to}`);

    const stalenessSeconds = Math.floor((resolvedAt - cache.cachedAt) / 1000);
    if (stalenessSeconds > env.MAX_STALE_SECONDS) {
      reply.header("X-FX-Stale", "true");
    }

    const quote: ComputedQuote = computeQuote({
      from,
      to,
      amount: query.amount,
      rate: resolved.rate,
      rateSource: resolved.source,
      slippageBps: effectiveBps,
      createdAt: resolvedAt,
      quoteTtlMs: QUOTE_TTL_MS,
      rateBatchId: cache.batchIds[from] ?? '',
    });

    // Store quote so it can be verified later. If Redis is unavailable the
    // quote is still returned — clients just won't be able to call /verify.
    // The stored record reuses the computed quote verbatim: no field is
    // recomputed or re-rounded for storage.
    let quoteId: string | null = null;
    try {
      quoteId = randomUUID();
      const stored: StoredQuote = {
        quoteId,
        from: quote.from,
        to: quote.to,
        amount: quote.amount,
        result: quote.result,
        rate: quote.rate,
        slippageBps: quote.slippageBps,
        expiresAt: quote.expiresAt,
        rateBatchId: quote.rateBatchId,
        unroundedRate: resolved.rate,
      };
      await redis.set(
        `${QUOTE_KEY_PREFIX}${quoteId}`,
        JSON.stringify(stored),
        "PX",
        QUOTE_CLEANUP_TTL_MS,
      );
    } catch (err) {
      fastify.log.warn(
        { err },
        "Failed to store quote; quote will not be verifiable",
      );
      quoteId = null;
    }

    // Issue #342 — Record quote creation latency
    const quoteDuration = Date.now() - quoteStartTime;
    fxQuoteCreationDurationHistogram.observe(
      { cache_hit: cacheHit ? "true" : "false" },
      quoteDuration,
    );

    return {
      quoteId,
      from: quote.from,
      to: quote.to,
      amount: quote.amount,
      result: quote.result,
      rate: quote.rate,
      slippageBps: quote.slippageBps,
      slippageLimit: quote.slippageLimit,
      stale:         Math.floor((resolvedAt - Math.min(cache.rateCachedAt[quote.from] ?? cache.cachedAt, cache.rateCachedAt[quote.to] ?? cache.cachedAt)) / 1000) > env.MAX_STALE_SECONDS,
      cachedAt:      new Date(cache.cachedAt).toISOString(),
      expiresAt:     new Date(quote.expiresAt).toISOString(),
      rateBatchId:   quote.rateBatchId,
    };
  },
);

// ── GET /api/rates/history (issue #56) ───────────────────────────────────

const HistoryQuerySchema = z.object({
  from: CurrencyCode,
  to: CurrencyCode,
  at: z.string().optional(), // ISO 8601; defaults to now
});

fastify.get(
  "/api/rates/history",
  {
    config: {
      rateLimit: {
        max: 100,
        timeWindow: 60 * 1000,
      },
    },
  },
  async (request, reply) => {
    let query: z.infer<typeof HistoryQuerySchema>;
    try {
      query = HistoryQuerySchema.parse(request.query);
    } catch (err) {
      if (err instanceof z.ZodError) {
        return reply
          .code(400)
          .send(
            createErrorResponse(
              ErrorCodes.INVALID_QUERY,
              "Invalid query parameters",
              err.errors,
            ),
          );
      }
      throw err;
    }

    const from = query.from.toUpperCase();
    const to = query.to.toUpperCase();

    const unsupported: string[] = [];
    if (!SUPPORTED_CURRENCIES.includes(from)) unsupported.push(from);
    if (!SUPPORTED_CURRENCIES.includes(to)) unsupported.push(to);

    if (unsupported.length > 0) {
      return reply.code(400).send(
        createErrorResponse(
          ErrorCodes.UNSUPPORTED_CURRENCY_PAIR,
          `Unsupported currency: ${unsupported.join(", ")}`,
          {
            unsupportedCurrencies: unsupported,
            supportedCurrencies: SUPPORTED_CURRENCIES,
          },
        ),
      );
    }

    if (from === to) {
      return reply
        .code(400)
        .send(
          createErrorResponse(
            ErrorCodes.INVALID_QUERY,
            "from and to must be different currencies",
          ),
        );
    }

    const atMs = query.at ? new Date(query.at).getTime() : Date.now();
    if (isNaN(atMs)) {
      return reply
        .code(400)
        .send(
          createErrorResponse(
            ErrorCodes.INVALID_QUERY,
            "at must be a valid ISO 8601 timestamp",
          ),
        );
    }

    const members = await redis.zrevrangebyscore(
      SNAPSHOT_KEY,
      atMs,
      "-inf",
      "LIMIT",
      0,
      1,
    );
    if (!members.length) {
      return reply
        .code(404)
        .send(
          createErrorResponse(
            ErrorCodes.NOT_FOUND,
            "No rate snapshot found at or before the requested time",
          ),
        );
    }

    const snapshot = JSON.parse(members[0]) as {
      ts: number;
      rates: Record<string, number>;
    };

    if (!(from in snapshot.rates) || !(to in snapshot.rates)) {
      return reply
        .code(404)
        .send(
          createErrorResponse(
            ErrorCodes.NOT_FOUND,
            "No rate data for the requested pair at the given time",
          ),
        );
    }

    const rate = computeRate(from, to, snapshot.rates);

    return {
      from,
      to,
      rate: rate.toFixed(8),
      at: new Date(snapshot.ts).toISOString(),
    };
  },
);

// ── POST /api/quote/verify (issue #57) ───────────────────────────────────

const VerifyQuoteBody = z.object({
  quoteId: z.string().min(1),
});

interface VerifyQuoteRouteBody {
  quoteId?: unknown;
}

fastify.post<{ Body: VerifyQuoteRouteBody }>(
  "/api/quote/verify",
  {
    config: {
      rateLimit: {
        max: 100,
        timeWindow: 60 * 1000,
      },
    },
  },
  async (request, reply) => {
    let body: z.infer<typeof VerifyQuoteBody>;
    try {
      body = VerifyQuoteBody.parse(request.body);
    } catch (err) {
      if (err instanceof z.ZodError) {
        return reply
          .code(400)
          .send(
            createErrorResponse(
              ErrorCodes.INVALID_QUERY,
              "Invalid request body",
              err.errors,
            ),
          );
      }
      throw err;
    }

    const raw = await redis.get(`${QUOTE_KEY_PREFIX}${body.quoteId}`);
    if (!raw) {
      return reply
        .code(404)
        .send(createErrorResponse(ErrorCodes.NOT_FOUND, "Quote not found"));
    }

    const stored = JSON.parse(raw) as StoredQuote;
    const now = Date.now();

    // Quote age validation
    const createdAt = stored.expiresAt - QUOTE_TTL_MS;
    const quoteAge = now - createdAt;
    if (quoteAge < env.QUOTE_MIN_AGE_MS) {
      return reply
        .code(400)
        .send(createErrorResponse(ErrorCodes.QUOTE_TOO_YOUNG, "Quote too young"));
    }
    if (quoteAge > env.QUOTE_MAX_LIFETIME_MS) {
      return reply
        .code(400)
        .send(createErrorResponse(ErrorCodes.QUOTE_TOO_OLD, "Quote too old"));
    }

    const currentRate = getOrComputeRate(stored.from, stored.to);
    const slippageBps = stored.slippageBps ?? env.DEFAULT_SLIPPAGE_BPS;
    const rateBatchId = cache.batchIds[stored.from] ?? '';
    const quotedRate = stored.unroundedRate ?? parseFloat(stored.rate);

    // Fail-open: if market rate is unavailable (fallback mode), accept by expiry
    let valid: boolean;
    if (fallbackStartTime !== null) {
      valid = now <= stored.expiresAt;
    } else {
      const deviation =
        (Math.abs(currentRate - quotedRate) / quotedRate) * 10000;
      valid = now <= stored.expiresAt && deviation <= slippageBps;
    }

    return {
      valid,
      stale: !valid,
      quoteId: stored.quoteId,
      from: stored.from,
      to: stored.to,
      rate: stored.rate,
      currentRate: currentRate.toFixed(8),
      slippageBps,
      slippageLimit: (slippageBps / 10_000).toFixed(4),
      expiresAt:     new Date(stored.expiresAt).toISOString(),
      rateBatchId,
    };
  },
);

// ── Start ──────────────────────────────────────────────────────────────────

let shuttingDown = false;

async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;

  fastify.log.info(`Received ${signal}, shutting down gracefully...`);

  try {
    if (refreshIntervalHandle !== null) {
      clearTimeout(refreshIntervalHandle);
      refreshIntervalHandle = null;
    }
    await cleanupWorker.close();
    await cleanupQueue.close();
    await fastify.close();
    await new Promise<void>((resolve) => metricsServer.close(() => resolve()));
    process.exit(0);
  } catch (err) {
    fastify.log.error(err, "Error during shutdown");
    process.exit(1);
  }
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// ── Prometheus metrics endpoint (#387) ────────────────────────────────────
promClient.collectDefaultMetrics();

const redisMemoryGauge = new promClient.Gauge({
  name: "redis_memory_usage_bytes",
  help: "Current Redis memory usage in bytes (used_memory from INFO memory)",
});
const redisEvictedCounter = new promClient.Counter({
  name: "redis_evicted_keys_total",
  help: "Total number of keys evicted from Redis (evicted_keys from INFO stats)",
});

// Issue #342 — Quote creation latency tracking
const fxQuoteCreationDurationHistogram = new promClient.Histogram({
  name: "fx_quote_creation_duration_milliseconds",
  help: "Duration of FX quote creation in milliseconds",
  labelNames: ["cache_hit"] as const,
  buckets: [1, 2, 5, 10, 20, 50, 100],
});

// Served on its own port (see startMetricsServer below), not on the
// application port — keeps the scrape endpoint unauthenticated without
// exposing it alongside application traffic.
const metricsServer = startMetricsServer({
  appPort: PORT,
  contentType: promClient.register.contentType,
  getMetrics: () => promClient.register.metrics(),
  log: fastify.log,
});

const start = async () => {
  try {
    // #391 — wait for Redis before doing anything else
    await waitForRedis(redis, fastify.log);

    // Warm up cache from latest Redis snapshot (#232)
    await warmupCacheFromRedis();
    // Seed the snapshot store so history is queryable from the very first request
    await storeRateSnapshot(cache.rates).catch((err) => {
      fastify.log.warn({ err }, "Failed to store initial rate snapshot");
    });
    // First refresh before we start serving: if it succeeds, cache is
    // updated; if it fails, we keep the FALLBACK_RATES seed.
    await refreshTick();
    startRefreshLoop();

    // #387 — Redis memory monitoring: update prom gauges every 30 s
    startRedisMemoryMonitor(redis, fastify.log, {
      intervalMs: 30_000,
      warnThresholdRatio: 0.8,
    });

    // Schedule the daily rate history cleanup repeatable job.
    // The job key is static so re-deployments don't duplicate the schedule.
    await cleanupQueue.add(
      "daily-cleanup",
      {},
      {
        repeat: { pattern: "0 0 * * *" },
        jobId: "rate-history-cleanup-daily",
      },
    );
    fastify.log.info(
      "Rate history cleanup repeatable job scheduled (daily at midnight)",
    );

    // Wire up gauge updates alongside the shared logger-based monitor
    setInterval(async () => {
      try {
        const [memInfo, statsInfo] = await Promise.all([
          redis.info("memory"),
          redis.info("stats"),
        ]);
        const usedMemMatch = memInfo.match(/^used_memory:(\d+)/m);
        const evictedMatch = statsInfo.match(/^evicted_keys:(\d+)/m);
        if (usedMemMatch) redisMemoryGauge.set(parseInt(usedMemMatch[1], 10));
        if (evictedMatch) redisEvictedCounter.reset(); // counter only grows; set abs value via inc
      } catch {
        // non-fatal
      }
    }, 30_000);

    await fastify.listen({ port: PORT, host: "0.0.0.0" });
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};
start();
