/**
 * Single quote computation path (Issue #566).
 *
 * `GET /api/quote` used to resolve a rate twice: once by peeking into the
 * computed-rate cache (to decide the `cache_hit` metric label) and again
 * inside `getOrComputeRate()`, which repeated the same TTL check against a
 * second `Date.now()` reading. The two peeks could disagree — a cache entry
 * expiring between them was reported as a hit while the live path actually
 * ran — and the resulting amounts were rounded independently for the stored
 * quote and for the HTTP response.
 *
 * Everything here is pure and side-effect free apart from the injected cache
 * callbacks, so both the cache-hit and the live-fallback path can be exercised
 * directly in tests.
 */

/** Decimal places every rate is rounded to, on every path. */
export const RATE_DECIMALS = 8;
/** Decimal places every converted amount is rounded to, on every path. */
export const AMOUNT_DECIMALS = 4;
/** Decimal places the fractional slippage limit is rounded to. */
export const SLIPPAGE_LIMIT_DECIMALS = 4;

/** A rate held in the computed-pair cache. */
export interface CachedRate {
  rate: number;
  computedAt: number;
}

/** Which arm of the single resolution path produced the rate. */
export type RateSource = "cache" | "live";

export interface ResolvedRate {
  rate: number;
  source: RateSource;
}

export interface ResolveRateOptions {
  /** Cache key for the pair, e.g. "USDC_NGN". */
  key: string;
  /** Single clock reading shared by the TTL check and the cache write. */
  now: number;
  /** How long a cached pair rate stays usable. */
  ttlMs: number;
  readCache: (key: string) => CachedRate | undefined;
  /** Live computation, invoked only on a miss or an expired entry. */
  computeLive: () => number;
  writeCache: (key: string, entry: CachedRate) => void;
}

/**
 * Resolve a pair rate from the cache, falling back to a live computation.
 *
 * This is the only place that decides cache-vs-live: the returned `source`
 * is the same decision the returned `rate` came from, so callers never have
 * to re-derive it.
 */
export function resolveRate(options: ResolveRateOptions): ResolvedRate {
  const { key, now, ttlMs, readCache, computeLive, writeCache } = options;

  const entry = readCache(key);
  if (entry && now - entry.computedAt < ttlMs) {
    return { rate: entry.rate, source: "cache" };
  }

  const rate = computeLive();
  writeCache(key, { rate, computedAt: now });
  return { rate, source: "live" };
}

/**
 * Round to a fixed number of decimals.
 *
 * Every rate, amount and slippage limit in a quote goes through this helper,
 * so the stored quote and the response body can never disagree.
 */
export function toDecimalString(value: number, decimals: number): string {
  return value.toFixed(decimals);
}

export interface QuoteInput {
  from: string;
  to: string;
  /** Raw request amount, echoed back verbatim. */
  amount: string;
  rate: number;
  rateSource: RateSource;
  slippageBps: number;
  /** Single clock reading shared by the quote's expiry and its metrics. */
  createdAt: number;
  quoteTtlMs: number;
  rateBatchId: string;
}

export interface ComputedQuote {
  from: string;
  to: string;
  amount: string;
  /** Converted amount, rounded to AMOUNT_DECIMALS. */
  result: string;
  /** Applied rate, rounded to RATE_DECIMALS. */
  rate: string;
  slippageBps: number;
  /** Fractional form of slippageBps, rounded to SLIPPAGE_LIMIT_DECIMALS. */
  slippageLimit: string;
  createdAt: number;
  expiresAt: number;
  rateBatchId: string;
  rateSource: RateSource;
}

/**
 * Build the single, fully rounded quote used by both the Redis record and the
 * HTTP response. Callers must not re-round any of these fields.
 */
export function computeQuote(input: QuoteInput): ComputedQuote {
  const amount = parseFloat(input.amount);

  return {
    from: input.from,
    to: input.to,
    amount: input.amount,
    result: toDecimalString(amount * input.rate, AMOUNT_DECIMALS),
    rate: toDecimalString(input.rate, RATE_DECIMALS),
    slippageBps: input.slippageBps,
    slippageLimit: toDecimalString(
      input.slippageBps / 10_000,
      SLIPPAGE_LIMIT_DECIMALS,
    ),
    createdAt: input.createdAt,
    expiresAt: input.createdAt + input.quoteTtlMs,
    rateBatchId: input.rateBatchId,
    rateSource: input.rateSource,
  };
}
