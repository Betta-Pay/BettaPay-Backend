import { z } from 'zod';
import { IncomingMessage } from 'http';
import { randomUUID } from 'crypto';
import { FastifyRequest } from 'fastify';
import { resolveAllowedOrigins } from './cors.js';

export * from './schemas.js';
export * from './currency.js';
export * from './plugins.js';
export * from './prisma.js';
export * from './cors.js';
export * from './tracing.js';
export * from './fastify-plugins.js';
export * from './logger.js';
export * from './envAwareSchema.js';
export * from './webhookSchema.js';
export * from './health.js';
export * from './audit.js';
export * from './redis.js';
export * from './metrics-server.js';
export * from './feature-flags.js';
export * from './startup-checks.js';
export * from './encryption.js';
import { z } from "zod";
import { IncomingMessage } from "http";
import { randomUUID } from "crypto";
import { FastifyRequest } from "fastify";
import { resolveAllowedOrigins } from "./cors.js";

export * from "./schemas.js";
export * from "./currency.js";
export * from "./plugins.js";
export * from "./prisma.js";
export * from "./cors.js";
export * from "./tracing.js";
export * from "./fastify-plugins.js";
export * from "./logger.js";
export * from "./envAwareSchema.js";
export * from "./webhookSchema.js";
export * from "./health.js";
export * from "./audit.js";
export * from "./redis.js";
export * from "./metrics-server.js";
export * from "./feature-flags.js";
export * from "./startup-checks.js";
export * from "./encryption.js";
import "dotenv/config";

export function genReqId(req: FastifyRequest | IncomingMessage): string {
  const reqId = req.headers["x-request-id"];
  return (Array.isArray(reqId) ? reqId[0] : reqId) || randomUUID();
}

// ─── Standard error response envelope ─────────────────────────────────────────
// Every API error response follows { error: { code, message, details? } } so
// clients can branch on a stable `code` instead of parsing human-readable strings.

export const ErrorCodes = {
  UNAUTHORIZED: "UNAUTHORIZED",
  FORBIDDEN: "FORBIDDEN",
  NOT_FOUND: "NOT_FOUND",
  VALIDATION_ERROR: "VALIDATION_ERROR",
  INVALID_REQUEST: "INVALID_REQUEST",
  RATE_LIMITED: "RATE_LIMITED",
  REQUEST_TIMEOUT: "REQUEST_TIMEOUT",
  GATEWAY_TIMEOUT: "GATEWAY_TIMEOUT",
  INTERNAL_ERROR: "INTERNAL_ERROR",
  UNSUPPORTED_CURRENCY_PAIR: "UNSUPPORTED_CURRENCY_PAIR",
  INVALID_AMOUNT: "INVALID_AMOUNT",
  INVALID_QUERY: "INVALID_QUERY",
  INVALID_ORIGIN: "INVALID_ORIGIN",
  CONCURRENCY_EXCEEDED: "CONCURRENCY_EXCEEDED",
  // #317 — returned when a suspended merchant attempts to create a payment
  // or settlement. Distinct from INVALID_REQUEST so clients can branch on it.
  MERCHANT_SUSPENDED: "MERCHANT_SUSPENDED",
  QUOTE_TOO_YOUNG: "QUOTE_TOO_YOUNG",
  QUOTE_TOO_OLD: "QUOTE_TOO_OLD",
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

export interface ErrorResponse {
  error: {
    code: string;
    message: string;
    details?: unknown;
    reqId?: string;
  };
}

export function createErrorResponse(
  code: string,
  message: string,
  details?: unknown,
  reqId?: string,
): ErrorResponse {
  const error: ErrorResponse["error"] = { code, message };
  if (details !== undefined) {
    error.details = details;
  }
  if (reqId !== undefined) {
    error.reqId = reqId;
  }
  return { error };
}

// Backend environment schema — all critical values are required.
// Services will refuse to start if any required variable is missing.
export const EnvSchema = z
  .object({
    NODE_ENV: z
      .enum(["development", "production", "test"])
      .default("development"),
    PORT: z
      .string()
      .transform((s) => parseInt(s, 10))
      .default("3000"),

    // Feature flags — comma-separated list of enabled flag names, e.g.
    // "new_settlement_flow,enhanced_fx_quotes". An absent or empty value means
    // all flags are disabled. Flag names are matched case-insensitively.
    FEATURE_FLAGS: z.string().optional(),

    // Two-tier upstream timeouts.
    // READ_TIMEOUT_MS caps idempotent GET calls (fx quotes, indexer events) so
    // the gateway fails fast during upstream read outages. Default: 2 s.
    // WRITE_TIMEOUT_MS caps mutation calls (POST settlements) where the
    // downstream service may need longer to commit. Default: 30 s.
    READ_TIMEOUT_MS: z
      .string()
      .transform((s) => parseInt(s, 10))
      .default("2000"),
    WRITE_TIMEOUT_MS: z
      .string()
      .transform((s) => parseInt(s, 10))
      .default("30000"),

    // Logging — pino level for the shared logger config (#119).
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .default("info"),

    // Fees — default basis points applied when a merchant has no custom fee rule.
    FEES_DEFAULT_BPS: z
      .string()
      .transform((s) => parseInt(s, 10))
      .default("100"),

    // Volume-based fee discount tiers — optional JSON array of tier objects.
    // Each tier defines a minimum monthly gross volume threshold (in USD/USDC)
    // and a discount in basis points subtracted from the merchant's base feeBps.
    // Tiers are evaluated in descending volumeUsd order; the highest-matching
    // tier wins. The effective fee is clamped to [0, feeBps] (never negative).
    //
    // Example:
    //   FEE_DISCOUNT_TIERS='[{"volumeUsd":10000,"discountBps":10},{"volumeUsd":50000,"discountBps":25}]'
    //
    // A merchant with $15 000 monthly volume and a 100 bps base fee would pay
    // 90 bps effective fee (100 − 10 = 90).
    FEE_DISCOUNT_TIERS: z
      .string()
      .optional()
      .transform((s): Array<{ volumeUsd: number; discountBps: number }> => {
        if (!s) return [];
        try {
          const parsed = JSON.parse(s);
          if (!Array.isArray(parsed)) return [];
          return parsed.filter(
            (t): t is { volumeUsd: number; discountBps: number } =>
              typeof t === "object" &&
              t !== null &&
              typeof t.volumeUsd === "number" &&
              typeof t.discountBps === "number" &&
              t.volumeUsd >= 0 &&
              t.discountBps >= 0,
          );
        } catch {
          return [];
        }
      })
      .pipe(
        z.array(
          z.object({
            volumeUsd: z.number().nonnegative(),
            discountBps: z.number().nonnegative(),
          }),
        ),
      ),

    // Auth
    JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters"),
    JWT_EXPIRES_IN: z.string().default("24h"),
    FIELD_ENCRYPTION_KEY: z
      .string()
      .min(32, "FIELD_ENCRYPTION_KEY must be at least 32 characters"),
    // Admin API key for privileged endpoints (optional)
    ADMIN_API_KEY: z
      .string()
      .min(32, "ADMIN_API_KEY must be at least 32 characters")
      .optional(),
    GOOGLE_CLIENT_ID: z.string().min(1, "GOOGLE_CLIENT_ID is required"),

    // Google OAuth — optional comma-separated list of allowed email domains.
    // When set, only emails from these domains can authenticate.
    ALLOWED_EMAIL_DOMAINS: z.string().optional(),

    // Google OAuth lockout configuration.
    AUTH_MAX_FAILED_ATTEMPTS: z
      .string()
      .transform((s) => parseInt(s, 10))
      .default("5"),
    AUTH_LOCKOUT_MINUTES: z
      .string()
      .transform((s) => parseInt(s, 10))
      .default("15"),

    // Indexer RPC backoff ceiling. Doubles the wait interval on 429s up to
    // this maximum value.
    MAX_BACKOFF_INTERVAL_MS: z
      .string()
      .transform((s) => parseInt(s, 10))
      .default("300000"),

    // Inter-service auth — shared secret presented in the `x-service-token` header
    // on internal (service-to-service) calls. Required so services fail fast
    // rather than silently trusting an unauthenticated network.
    INTER_SERVICE_SECRET: z
      .string()
      .min(16, "INTER_SERVICE_SECRET must be at least 16 characters"),

    // CORS — comma-separated origins (parsed to string[] in validateEnv)
    ALLOWED_ORIGINS: z.string().optional(),

    // Database — required; services crash fast if not provided
    DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),

    // Read-replica database — optional; if provided, Prisma routes read queries
    // (findMany, findFirst, count, aggregate) to this URL while writes go to DATABASE_URL.
    // When absent a warning is logged and all queries use the primary database.
    DATABASE_READ_REPLICA_URL: z.string().optional(),

    // Connection pool — limits concurrent DB connections and prevents
    // connection exhaustion under burst traffic. Pool timeout ensures
    // a stalled query does not block the entire service indefinitely.
    // Values are applied as ?connection_limit=N&pool_timeout=10 on the
    // connection URL; pg.Pool.max is set to the same size for adapter-
    // based clients (api-gateway). Default of 10 matches pg.Pool's own
    // built-in default and is safe for most workloads.
    DATABASE_POOL_SIZE: z
      .string()
      .transform((s) => parseInt(s, 10))
      .default("10"),
    DATABASE_POOL_TIMEOUT: z
      .string()
      .transform((s) => parseInt(s, 10))
      .default("10"),

    // Redis — optional, falls back to localhost
    REDIS_URL: z.string().default("redis://localhost:6379"),
    REDIS_MAX_RETRIES: z
      .string()
      .transform((s) => parseInt(s, 10))
      .default("3"),

    // Per-merchant concurrent request limiting
    MERCHANT_MAX_CONCURRENCY: z
      .string()
      .transform((s) => parseInt(s, 10))
      .default("10"),

    // Stellar
    STELLAR_RPC_URL: z
      .string()
      .url()
      .default("https://soroban-testnet.stellar.org"),
    STELLAR_NETWORK_PASSPHRASE: z
      .string()
      .default("Test SDF Network ; September 2015"),
    STELLAR_HORIZON_URL: z
      .string()
      .url()
      .default("https://horizon-testnet.stellar.org"),

    // Contract addresses — required; no silent fallbacks in code
    SETTLEMENT_CONTRACT_ID: z
      .string()
      .min(1, "SETTLEMENT_CONTRACT_ID is required"),
    GOVERNANCE_CONTRACT_ID: z
      .string()
      .min(1, "GOVERNANCE_CONTRACT_ID is required"),
    ADMIN_ADDRESS: z.string().min(1, "ADMIN_ADDRESS is required"),
    ADMIN_SECRET: z.string().min(1, "ADMIN_SECRET is required"),

    // Multi-contract indexing — comma-separated contract IDs; falls back to
    // SETTLEMENT_CONTRACT_ID for backward compatibility.
    CONTRACT_IDS: z.string().optional(),
    CONTRACT_NAMES: z.string().optional(),

    // Service URLs (used by gateway to proxy requests)
    FX_ENGINE_URL: z.string().url().default("http://localhost:3002"),
    SETTLEMENT_ENGINE_URL: z.string().url().default("http://localhost:3001"),
    INDEXER_URL: z.string().url().default("http://localhost:3003"),

    // Number of trusted reverse-proxy hops in front of the gateway (#621).
    // X-Forwarded-For / X-Real-IP are only consulted when this is > 0 — the
    // header is otherwise attacker-controlled and unconditionally trusting it
    // (the prior behavior) let a spoofed X-Forwarded-For poison AuditLog.ipAddress.
    // Default 0 means: never trust the header, always use the raw socket address.
    TRUSTED_PROXY_COUNT: z
      .string()
      .transform((s) => parseInt(s, 10))
      .default("0"),

    // FX Engine — live rate fetching and caching
    RATES_API_URL: z
      .string()
      .url()
      .default(
        "https://api.coingecko.com/api/v3/simple/price?ids=usd-coin,tether-eurt&vs_currencies=ngn",
      ),
    RATES_REFRESH_INTERVAL_MS: z
      .string()
      .transform((s) => parseInt(s, 10))
      .default("60000"),
    RATES_CACHE_TTL_MS: z
      .string()
      .transform((s) => parseInt(s, 10))
      .default("60000"),

    // FX Engine — circuit breaker cooldown before probing CoinGecko again
    // after 5 consecutive failures. Default: 5 minutes.
    CIRCUIT_BREAKER_COOLDOWN_MS: z
      .string()
      .transform((s) => parseInt(s, 10))
      .default("300000"),

    // FX Engine — maximum allowed deviation (in basis points) between the
    // current cached rate and a newly fetched rate. When the deviation
    // exceeds this threshold the new rate is rejected, the old rate is
    // preserved, and a warning is logged. Default: 2000 bps = 20%.
    MAX_DEVIATION_BPS: z
      .string()
      .transform((s) => parseInt(s, 10))
      .default("2000"),

    // FX Engine — staleness threshold (seconds)
    MAX_STALE_SECONDS: z
      .string()
      .transform((s) => parseInt(s, 10))
      .default("300")
      .refine((val) => Number.isFinite(val) && val > 0, {
        message: "MAX_STALE_SECONDS must be a positive integer",
      }),

    // FX Engine — slippage tolerance (basis points; 100 bps = 1%)
    DEFAULT_SLIPPAGE_BPS: z
      .string()
      .transform((s) => parseInt(s, 10))
      .default("50"),
    MAX_SLIPPAGE_BPS: z
      .string()
      .transform((s) => parseInt(s, 10))
      .default("500"),

    // FX Engine — quote age validation
    QUOTE_MIN_AGE_MS: z
      .string()
      .transform((s) => parseInt(s, 10))
      .default("1000")
      .refine((val) => Number.isFinite(val) && val > 0, {
        message: "QUOTE_MIN_AGE_MS must be a positive integer",
      }),
    QUOTE_MAX_LIFETIME_MS: z
      .string()
      .transform((s) => parseInt(s, 10))
      .default("300000")
      .refine((val) => Number.isFinite(val) && val > 0, {
        message: "QUOTE_MAX_LIFETIME_MS must be a positive integer",
      }),

    // Indexer — lag warning threshold (number of ledgers behind the Stellar tip)
    INDEXER_LAG_WARN_THRESHOLD: z
      .string()
      .transform((s) => parseInt(s, 10))
      .default("10"),

    // Indexer — smart startup ledger discovery (#352)
    // When no indexed events exist, start from max(1, tip - INITIAL_BACKFILL_LEDGERS).
    INITIAL_BACKFILL_LEDGERS: z
      .string()
      .transform((s) => parseInt(s, 10))
      .default("1000"),
    // Manual override: skip auto-discovery and start from this ledger.
    INDEX_FROM_LEDGER: z.string().optional(),

    // Indexer — Poll cycle timeout (ms). When a cycle exceeds this, it is aborted.
    POLL_TIMEOUT_MS: z
      .string()
      .transform((s) => parseInt(s, 10))
      .default("30000"),

    // Indexer — Event retention policy
    EVENT_RETENTION_DAYS: z
      .string()
      .transform((s) => parseInt(s, 10))
      .default("30")
      .refine((val) => process.env.NODE_ENV !== "production" || val >= 1, {
        message: "EVENT_RETENTION_DAYS must be >= 1 in production",
      }),

    // FX Engine — Rate history retention (days).
    // Snapshots older than this are purged by the daily rate-history-cleanup job.
    RATE_HISTORY_RETENTION_DAYS: z
      .string()
      .transform((s) => parseInt(s, 10))
      .default("7")
      .refine((val) => val >= 1, {
        message: "RATE_HISTORY_RETENTION_DAYS must be >= 1",
      }),

    // Settlement Batching — interval (seconds) for batch job and minimum count per batch.
    // Reject zero/negative intervals (tight loop risk) and unreasonable upper bounds.
    BATCH_INTERVAL_SECONDS: z
      .string()
      .transform((s) => parseInt(s, 10))
      .default("300")
      .refine((val) => Number.isFinite(val) && val >= 1 && val <= 86400, {
        message: "BATCH_INTERVAL_SECONDS must be between 1 and 86400",
      }),
    BATCH_MIN_COUNT: z
      .string()
      .transform((s) => parseInt(s, 10))
      .default("2")
      .refine((val) => Number.isFinite(val) && val >= 1 && val <= 10000, {
        message: "BATCH_MIN_COUNT must be between 1 and 10000",
      }),

    // Settlement Engine — optional daily volume limit for pre-validation.
    // When set, the settlement engine rejects settlement creation requests
    // that would exceed this limit within a single day (UTC). Default: 100000.
    DAILY_SETTLEMENT_VOLUME_LIMIT: z
      .string()
      .transform((s) => parseInt(s, 10))
      .default("100000"),

    // Settlement Engine — worker job timeout (ms)
    SETTLEMENT_JOB_TIMEOUT_MS: z
      .string()
      .transform((s) => parseInt(s, 10))
      .default("30000")
      .refine((val) => Number.isFinite(val) && val > 0, {
        message: "SETTLEMENT_JOB_TIMEOUT_MS must be a positive integer",
      }),
  })
  .superRefine((data, ctx) => {
    if (data.QUOTE_MIN_AGE_MS >= data.QUOTE_MAX_LIFETIME_MS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "QUOTE_MIN_AGE_MS must be less than QUOTE_MAX_LIFETIME_MS",
        path: ["QUOTE_MIN_AGE_MS"],
      });
    }

    if (data.NODE_ENV === "production") {
      const secret = data.JWT_SECRET;
      if (!secret) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "JWT_SECRET is required in production",
          path: ["JWT_SECRET"],
        });
        return;
      }

      const defaults = [
        "change-me-to-a-long-random-secret-before-production",
        "super-secret-development-key-please-change",
      ];
      if (defaults.includes(secret)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "JWT_SECRET cannot be a default development value in production",
          path: ["JWT_SECRET"],
        });
        return;
      }

      const lowerSecret = secret.toLowerCase();
      if (
        lowerSecret.includes("please-change") ||
        lowerSecret.includes("change-me") ||
        lowerSecret.includes("development")
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "JWT_SECRET cannot contain development placeholders (e.g., 'change-me', 'please-change', 'development')",
          path: ["JWT_SECRET"],
        });
        return;
      }

      const uniqueChars = new Set(secret).size;
      if (uniqueChars < 8) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "JWT_SECRET is too weak: must contain at least 8 unique characters",
          path: ["JWT_SECRET"],
        });
        return;
      }

      const hasLower = /[a-z]/.test(secret);
      const hasUpper = /[A-Z]/.test(secret);
      const hasDigit = /[0-9]/.test(secret);
      const hasSpecial = /[^a-zA-Z0-9]/.test(secret);

      if (!hasLower || !hasUpper || (!hasDigit && !hasSpecial)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "JWT_SECRET is too weak: must include a mix of uppercase letters, lowercase letters, and digits or special characters",
          path: ["JWT_SECRET"],
        });
      }
    }
  })
  .refine((data) => data.QUOTE_MIN_AGE_MS < data.QUOTE_MAX_LIFETIME_MS, {
    message: "QUOTE_MIN_AGE_MS must be less than QUOTE_MAX_LIFETIME_MS",
  })
  .refine((data) => data.DEFAULT_SLIPPAGE_BPS <= data.MAX_SLIPPAGE_BPS, {
    message:
      "DEFAULT_SLIPPAGE_BPS must be less than or equal to MAX_SLIPPAGE_BPS",
  });

export type Env = Omit<
  z.infer<typeof EnvSchema>,
  "ALLOWED_ORIGINS" | "CONTRACT_IDS" | "FEATURE_FLAGS" | "ALLOWED_EMAIL_DOMAINS"
> & {
  ALLOWED_ORIGINS: string[];
  CONTRACT_IDS: string[];
  ALLOWED_EMAIL_DOMAINS: string[];
  FEATURE_FLAGS: string[];
};

// For string length issues, appends the received length (e.g. "(got 8)") rather
// than the raw value itself, so secrets are never echoed into logs.
function formatEnvIssue(
  issue: z.ZodIssue,
  env: Record<string, unknown>,
): string {
  const path = issue.path.join(".");
  const rawValue = env[path];
  const detail =
    (issue.code === "too_small" || issue.code === "too_big") &&
    typeof rawValue === "string"
      ? ` (got ${rawValue.length})`
      : "";
  return `  ${path}: ${issue.message}${detail}`;
}

export function validateEnv(env: Record<string, unknown>): Env {
  const { origins, error: originsError } = resolveAllowedOrigins(env);
  if (originsError) {
    throw new Error(
      `\n[BettaPay] Invalid or missing environment variables:\n  ALLOWED_ORIGINS: ${originsError}\n`,
    );
  }

  try {
    const parsed = EnvSchema.parse(env);

    const contractIds = (parsed.CONTRACT_IDS ?? parsed.SETTLEMENT_CONTRACT_ID)
      .split(",")
      .map((id) => id.trim())
      .filter((id) => id.length > 0);

    if (contractIds.length === 0) {
      throw new Error(
        "\n[BettaPay] Invalid or missing environment variables:\n  CONTRACT_IDS: at least one contract ID must be provided\n",
      );
    }

    return {
      ...parsed,
      ALLOWED_ORIGINS: origins,
      CONTRACT_IDS: contractIds,
      ALLOWED_EMAIL_DOMAINS: parsed.ALLOWED_EMAIL_DOMAINS
        ? parsed.ALLOWED_EMAIL_DOMAINS.split(",")
            .map((d) => d.trim().toLowerCase())
            .filter(Boolean)
        : [],
      FEATURE_FLAGS: parsed.FEATURE_FLAGS
        ? parsed.FEATURE_FLAGS.split(",")
            .map((f) => f.trim().toLowerCase())
            .filter(Boolean)
        : [],
    };
  } catch (error) {
    if (error instanceof z.ZodError) {
      const message = error.errors
        .map((e) => formatEnvIssue(e, env))
        .join("\n");
      throw new Error(
        `\n[BettaPay] Invalid or missing environment variables:\n${message}\n`,
      );
    }
    throw error;
  }
}

// Wraps validateEnv() for use at service startup: logs a single clean,
// human-readable message (no stack trace) and exits with code 1 on failure,
// so misconfiguration is caught fast instead of surfacing later at runtime.
export function validateEnvOrExit(env: Record<string, unknown>): Env {
  try {
    return validateEnv(env);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return process.exit(1);
  }
}

export * from "./prisma-pool-metrics.js";
export * from "./encryption.js";
