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

import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { Redis } from 'ioredis';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import {
  validateEnv,
  registerErrorHandler,
  registerRequestId,
  createErrorResponse,
  ErrorCodes,
  createLoggerOptions,
  registerTracing,
  CurrencyCode,
  buildFxEngineHealthResponse,
  readServiceVersion,
} from '@bettapay/validation';

const env = validateEnv(process.env);
const PORT = Number(process.env.PORT ?? '3002');
const startTime = Date.now();
const SERVICE_VERSION = readServiceVersion(import.meta.url);

// ── Fallback / seed rates (issue #47) ──────────────────────────────────────
// Used on first startup before the external API responds, and whenever the
// API is unreachable so the service degrades gracefully.

const FALLBACK_RATES: Record<string, number> = {
  USDC: 1545.50,
  EURT: 1680.20,
  NGN:  1.0,
};

const CURRENCY_DISPLAY_NAMES: Record<string, string> = {
  USDC: 'USD Coin',
  EURT: 'Euro Tether',
  NGN:  'Nigerian Naira',
};

const SUPPORTED_CURRENCIES = Object.keys(FALLBACK_RATES);

// ── In-memory rate cache (issues #47 & #48) ────────────────────────────────

interface RateCache {
  rates: Record<string, number>;
  cachedAt: number; // Unix ms timestamp
}

let cache: RateCache = {
  rates:    { ...FALLBACK_RATES },
  cachedAt: Date.now(),
};

// ── Computed pair-rate cache (issue #55) ───────────────────────────────────
// Avoids recomputing the same cross/inverse rate on every request.
// Keyed by "FROM_TO" (e.g. "USDC_EURT", "NGN_USDC").
// Entries expire after RATE_TTL_MS; the cache is also fully invalidated
// whenever base rates are refreshed via updateBaseRates().

const RATE_TTL_MS = 60_000;

interface ComputedRateEntry {
  rate:       number;
  computedAt: number;
}

const computedRateCache = new Map<string, ComputedRateEntry>();

function computeRate(from: string, to: string, baseRates: Record<string, number>): number {
  // NGN is the base (rate === 1.0), so all three cases collapse to one formula:
  //   direct  (X → NGN):  baseRates[from] / 1          = baseRates[from]
  //   inverse (NGN → X):  1              / baseRates[to]
  //   cross   (X → Y):    baseRates[from] / baseRates[to]
  return baseRates[from] / baseRates[to];
}

function getOrComputeRate(from: string, to: string): number {
  const key   = `${from}_${to}`;
  const now   = Date.now();
  const entry = computedRateCache.get(key);

  if (entry && now - entry.computedAt < RATE_TTL_MS) {
    return entry.rate;
  }

  const rate = computeRate(from, to, cache.rates);
  computedRateCache.set(key, { rate, computedAt: now });
  return rate;
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

const SNAPSHOT_KEY           = 'fx:rate_snapshots';
const SNAPSHOT_RETENTION_MS  = 7 * 24 * 60 * 60 * 1000; // 7 days

async function storeRateSnapshot(rates: Record<string, number>): Promise<void> {
  const now    = Date.now();
  const cutoff = now - SNAPSHOT_RETENTION_MS;
  await redis
    .pipeline()
    .zadd(SNAPSHOT_KEY, now, JSON.stringify({ ts: now, rates }))
    .zremrangebyscore(SNAPSHOT_KEY, '-inf', cutoff)
    .exec();
}

function updateBaseRates(newRates: Record<string, number>): void {
  cache = { rates: newRates, cachedAt: Date.now() };
  computedRateCache.clear();
  storeRateSnapshot(newRates).catch(() => {}); // Redis errors are non-fatal
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

const QUOTE_TTL_MS         = RATE_TTL_MS;
const QUOTE_CLEANUP_TTL_MS = 10 * 60 * 1000;
const QUOTE_KEY_PREFIX     = 'fx:quote:';

interface StoredQuote {
  quoteId:     string;
  from:        string;
  to:          string;
  amount:      string;
  result:      string;
  rate:        string;
  slippageBps: number;
  expiresAt:   number; // Unix ms — quote validity cutoff
}

const fastify = Fastify({
  logger: createLoggerOptions({ level: env.LOG_LEVEL }),
});

registerRequestId(fastify);
redis = new Redis(env.REDIS_URL, { enableOfflineQueue: false });
redis.on('error', (err) => fastify.log.warn({ err: err.message }, 'Redis error in fx-engine'));
fastify.addHook('onClose', async () => { await redis.quit().catch(() => {}); });

fastify.register(cors, {
  origin: env.ALLOWED_ORIGINS,
});
fastify.register(rateLimit, { max: 200, timeWindow: 60 * 1000 });
registerErrorHandler(fastify);
// Distributed tracing: log + propagate x-request-id / x-trace-id (#118).
registerTracing(fastify);

fastify.get('/api/health', async (_request, reply) => {
  const health = await buildFxEngineHealthResponse({
    pingRedis: () => redis.ping(),
    ratesApiUrl: env.RATES_API_URL,
    startTime,
    service: 'fx-engine',
    version: SERVICE_VERSION,
  });
  const statusCode = health.status === 'unhealthy' ? 503 : 200;
  return reply.code(statusCode).send(health);
});

fastify.get('/api/rates', async (_request, _reply) => {
  return { rates: cache.rates, updatedAt: new Date(cache.cachedAt).toISOString() };
});

fastify.get('/api/currencies', async (_request, _reply) => {
  return {
    currencies: SUPPORTED_CURRENCIES.map((code) => ({
      code,
      name: CURRENCY_DISPLAY_NAMES[code],
    })),
  };
});

// ── GET /api/quote (issues #48 & #49) ────────────────────────────────────

const QuoteQuerySchema = z.object({
  from:        CurrencyCode.default('USDC'),
  to:          CurrencyCode.default('NGN'),
  amount:      z.string().regex(/^\d+(\.\d+)?$/, 'amount must be a numeric string').default('1'),
  slippageBps: z.string().regex(/^\d+$/, 'slippageBps must be a non-negative integer').optional(),
});

fastify.get(
  '/api/quote',
  {
    config: {
      rateLimit: {
        max:        100,
        timeWindow: 60 * 1000,
      },
    },
  },
  async (request, reply) => {
    let query: z.infer<typeof QuoteQuerySchema>;
    try {
      query = QuoteQuerySchema.parse(request.query);
    } catch (err) {
      if (err instanceof z.ZodError) {
        return reply.code(400).send(
          createErrorResponse(ErrorCodes.INVALID_QUERY, 'Invalid query parameters', err.errors),
        );
      }
      throw err;
    }

    const from   = query.from.toUpperCase();
    const to     = query.to.toUpperCase();
    const amount = parseFloat(query.amount);

    if (amount <= 0) {
      return reply.code(400).send(
        createErrorResponse(ErrorCodes.INVALID_AMOUNT, 'Amount must be greater than zero'),
      );
    }

    // Validate that both currencies are supported (issue #49)
    const unsupported: string[] = [];
    if (!SUPPORTED_CURRENCIES.includes(from)) unsupported.push(from);
    if (!SUPPORTED_CURRENCIES.includes(to))   unsupported.push(to);

    if (unsupported.length > 0) {
      return reply.code(400).send(
        createErrorResponse(
          ErrorCodes.UNSUPPORTED_CURRENCY_PAIR,
          `Unsupported currency: ${unsupported.join(', ')}`,
          { unsupportedCurrencies: unsupported, supportedCurrencies: SUPPORTED_CURRENCIES },
        ),
      );
    }

    if (from === to) {
      return reply.code(400).send(
        createErrorResponse(ErrorCodes.INVALID_QUERY, 'from and to must be different currencies'),
      );
    }

    const requestedBps  = query.slippageBps !== undefined
      ? parseInt(query.slippageBps, 10)
      : env.DEFAULT_SLIPPAGE_BPS;
    const effectiveBps  = Math.min(requestedBps, env.MAX_SLIPPAGE_BPS);
    const slippageLimit = (effectiveBps / 10_000).toFixed(4);

    const exchangeRate = getOrComputeRate(from, to);
    const targetAmount = amount * exchangeRate;
    const expiresAt    = Date.now() + QUOTE_TTL_MS;

    // Store quote so it can be verified later. If Redis is unavailable the
    // quote is still returned — clients just won't be able to call /verify.
    let quoteId: string | null = null;
    try {
      quoteId = randomUUID();
      const stored: StoredQuote = {
        quoteId,
        from,
        to,
        amount:      query.amount,
        result:      targetAmount.toFixed(4),
        rate:        exchangeRate.toFixed(8),
        slippageBps: effectiveBps,
        expiresAt,
      };
      await redis.set(
        `${QUOTE_KEY_PREFIX}${quoteId}`,
        JSON.stringify(stored),
        'PX',
        QUOTE_CLEANUP_TTL_MS,
      );
    } catch (err) {
      fastify.log.warn({ err }, 'Failed to store quote; quote will not be verifiable');
      quoteId = null;
    }

    return {
      quoteId,
      from,
      to,
      amount:        query.amount,
      result:        targetAmount.toFixed(4),
      rate:          exchangeRate.toFixed(8),
      slippageBps:   effectiveBps,
      slippageLimit,
      cachedAt:      new Date(cache.cachedAt).toISOString(),
      expiresAt:     new Date(expiresAt).toISOString(),
    };
  },
);

// ── GET /api/rates/history (issue #56) ───────────────────────────────────

const HistoryQuerySchema = z.object({
  from: CurrencyCode,
  to:   CurrencyCode,
  at:   z.string().optional(), // ISO 8601; defaults to now
});

fastify.get(
  '/api/rates/history',
  {
    config: {
      rateLimit: {
        max:        100,
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
        return reply.code(400).send(
          createErrorResponse(ErrorCodes.INVALID_QUERY, 'Invalid query parameters', err.errors),
        );
      }
      throw err;
    }

    const from = query.from.toUpperCase();
    const to   = query.to.toUpperCase();

    const unsupported: string[] = [];
    if (!SUPPORTED_CURRENCIES.includes(from)) unsupported.push(from);
    if (!SUPPORTED_CURRENCIES.includes(to))   unsupported.push(to);

    if (unsupported.length > 0) {
      return reply.code(400).send(
        createErrorResponse(
          ErrorCodes.UNSUPPORTED_CURRENCY_PAIR,
          `Unsupported currency: ${unsupported.join(', ')}`,
          { unsupportedCurrencies: unsupported, supportedCurrencies: SUPPORTED_CURRENCIES },
        ),
      );
    }

    if (from === to) {
      return reply.code(400).send(
        createErrorResponse(ErrorCodes.INVALID_QUERY, 'from and to must be different currencies'),
      );
    }

    const atMs = query.at ? new Date(query.at).getTime() : Date.now();
    if (isNaN(atMs)) {
      return reply.code(400).send(
        createErrorResponse(ErrorCodes.INVALID_QUERY, 'at must be a valid ISO 8601 timestamp'),
      );
    }

    const members = await redis.zrevrangebyscore(SNAPSHOT_KEY, atMs, '-inf', 'LIMIT', 0, 1);
    if (!members.length) {
      return reply.code(404).send(
        createErrorResponse(
          ErrorCodes.NOT_FOUND,
          'No rate snapshot found at or before the requested time',
        ),
      );
    }

    const snapshot = JSON.parse(members[0]) as { ts: number; rates: Record<string, number> };

    if (!(from in snapshot.rates) || !(to in snapshot.rates)) {
      return reply.code(404).send(
        createErrorResponse(
          ErrorCodes.NOT_FOUND,
          'No rate data for the requested pair at the given time',
        ),
      );
    }

    const rate = computeRate(from, to, snapshot.rates);

    return {
      from,
      to,
      rate: rate.toFixed(8),
      at:   new Date(snapshot.ts).toISOString(),
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
  '/api/quote/verify',
  {
    config: {
      rateLimit: {
        max:        100,
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
        return reply.code(400).send(
          createErrorResponse(ErrorCodes.INVALID_QUERY, 'Invalid request body', err.errors),
        );
      }
      throw err;
    }

    const raw = await redis.get(`${QUOTE_KEY_PREFIX}${body.quoteId}`);
    if (!raw) {
      return reply.code(404).send(
        createErrorResponse(ErrorCodes.NOT_FOUND, 'Quote not found'),
      );
    }

    const stored      = JSON.parse(raw) as StoredQuote;
    const now         = Date.now();
    const valid       = now <= stored.expiresAt;
    const currentRate = getOrComputeRate(stored.from, stored.to);
    const slippageBps = stored.slippageBps ?? env.DEFAULT_SLIPPAGE_BPS;

    return {
      valid,
      stale:         !valid,
      quoteId:       stored.quoteId,
      from:          stored.from,
      to:            stored.to,
      rate:          stored.rate,
      currentRate:   currentRate.toFixed(8),
      slippageBps,
      slippageLimit: (slippageBps / 10_000).toFixed(4),
      expiresAt:     new Date(stored.expiresAt).toISOString(),
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
    await fastify.close();
    process.exit(0);
  } catch (err) {
    fastify.log.error(err, 'Error during shutdown');
    process.exit(1);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

const start = async () => {
  try {
    // Seed the snapshot store so history is queryable from the very first request
    await storeRateSnapshot(cache.rates).catch((err) => {
      fastify.log.warn({ err }, 'Failed to store initial rate snapshot');
    });
    await fastify.listen({ port: PORT, host: '0.0.0.0' });
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};
start();
