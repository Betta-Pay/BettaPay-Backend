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
import "dotenv/config";

export function genReqId(req: FastifyRequest | IncomingMessage): string {
  const reqId = req.headers['x-request-id'];
  return (Array.isArray(reqId) ? reqId[0] : reqId) || randomUUID();
}

// ─── Standard error response envelope ─────────────────────────────────────────
// Every API error response follows { error: { code, message, details? } } so
// clients can branch on a stable `code` instead of parsing human-readable strings.

export const ErrorCodes = {
  UNAUTHORIZED: 'UNAUTHORIZED',
  NOT_FOUND: 'NOT_FOUND',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  INVALID_REQUEST: 'INVALID_REQUEST',
  REQUEST_TIMEOUT: 'REQUEST_TIMEOUT',
  GATEWAY_TIMEOUT: 'GATEWAY_TIMEOUT',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  UNSUPPORTED_CURRENCY_PAIR: 'UNSUPPORTED_CURRENCY_PAIR',
  INVALID_AMOUNT: 'INVALID_AMOUNT',
  INVALID_QUERY: 'INVALID_QUERY',
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

export interface ErrorResponse {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export function createErrorResponse(code: string, message: string, details?: unknown): ErrorResponse {
  const error: ErrorResponse['error'] = { code, message };
  if (details !== undefined) {
    error.details = details;
  }
  return { error };
}

// Backend environment schema — all critical values are required.
// Services will refuse to start if any required variable is missing.
export const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.string().transform((s) => parseInt(s, 10)).default('3000'),

  // Logging — pino level for the shared logger config (#119).
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),

  // Fees — default basis points applied when a merchant has no custom fee rule.
  FEES_DEFAULT_BPS: z.string().transform((s) => parseInt(s, 10)).default('100'),

  // Auth
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_EXPIRES_IN: z.string().default('24h'),
  // Admin API key for privileged endpoints (optional)
  ADMIN_API_KEY: z.string().min(32, 'ADMIN_API_KEY must be at least 32 characters').optional(),
  GOOGLE_CLIENT_ID: z.string().min(1, 'GOOGLE_CLIENT_ID is required'),

  // Inter-service auth — shared secret presented in the `x-service-token` header
  // on internal (service-to-service) calls. Required so services fail fast
  // rather than silently trusting an unauthenticated network.
  INTER_SERVICE_SECRET: z
    .string()
    .min(16, 'INTER_SERVICE_SECRET must be at least 16 characters'),

  // CORS — comma-separated origins (parsed to string[] in validateEnv)
  ALLOWED_ORIGINS: z.string().optional(),

  // Database — required; services crash fast if not provided
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

  // Connection pool — limits concurrent DB connections and prevents
  // connection exhaustion under burst traffic. Pool timeout ensures
  // a stalled query does not block the entire service indefinitely.
  // Values are applied as ?connection_limit=N&pool_timeout=10 on the
  // connection URL; pg.Pool.max is set to the same size for adapter-
  // based clients (api-gateway). Default of 10 matches pg.Pool's own
  // built-in default and is safe for most workloads.
  DATABASE_POOL_SIZE: z.string().transform((s) => parseInt(s, 10)).default('10'),
  DATABASE_POOL_TIMEOUT: z.string().transform((s) => parseInt(s, 10)).default('10'),

  // Redis — optional, falls back to localhost
  REDIS_URL: z.string().default('redis://localhost:6379'),
  REDIS_MAX_RETRIES: z.string().transform((s) => parseInt(s, 10)).default('3'),

  // Stellar
  STELLAR_RPC_URL: z.string().url().default('https://soroban-testnet.stellar.org'),
  STELLAR_NETWORK_PASSPHRASE: z.string().default('Test SDF Network ; September 2015'),
  STELLAR_HORIZON_URL: z.string().url().default('https://horizon-testnet.stellar.org'),

  // Contract addresses — required; no silent fallbacks in code
  SETTLEMENT_CONTRACT_ID: z.string().min(1, 'SETTLEMENT_CONTRACT_ID is required'),
  GOVERNANCE_CONTRACT_ID: z.string().min(1, 'GOVERNANCE_CONTRACT_ID is required'),
  ADMIN_ADDRESS: z.string().min(1, 'ADMIN_ADDRESS is required'),
  ADMIN_SECRET: z.string().min(1, 'ADMIN_SECRET is required'),

  // Multi-contract indexing — comma-separated contract IDs; falls back to
  // SETTLEMENT_CONTRACT_ID for backward compatibility.
  CONTRACT_IDS: z.string().optional(),
  CONTRACT_NAMES: z.string().optional(),

  // Service URLs (used by gateway to proxy requests)
  FX_ENGINE_URL: z.string().url().default('http://localhost:3002'),
  SETTLEMENT_ENGINE_URL: z.string().url().default('http://localhost:3001'),
  INDEXER_URL: z.string().url().default('http://localhost:3003'),

  // FX Engine — live rate fetching and caching
  RATES_API_URL: z.string().url().default(
    'https://api.coingecko.com/api/v3/simple/price?ids=usd-coin,tether-eurt&vs_currencies=ngn'
  ),
  RATES_REFRESH_INTERVAL_MS: z.string().transform((s) => parseInt(s, 10)).default('60000'),
  RATES_CACHE_TTL_MS: z.string().transform((s) => parseInt(s, 10)).default('60000'),

  // FX Engine — slippage tolerance (basis points; 100 bps = 1%)
  DEFAULT_SLIPPAGE_BPS: z.string().transform((s) => parseInt(s, 10)).default('50'),
  MAX_SLIPPAGE_BPS:     z.string().transform((s) => parseInt(s, 10)).default('500'),

  // Indexer — lag warning threshold (number of ledgers behind the Stellar tip)
  INDEXER_LAG_WARN_THRESHOLD: z.string().transform((s) => parseInt(s, 10)).default('10'),

  // Indexer — Event retention policy
  EVENT_RETENTION_DAYS: z.string().transform((s) => parseInt(s, 10)).default('30'),
});

export type Env = Omit<z.infer<typeof EnvSchema>, 'ALLOWED_ORIGINS' | 'CONTRACT_IDS'> & {
  ALLOWED_ORIGINS: string[];
  CONTRACT_IDS: string[];
};

export function validateEnv(env: Record<string, unknown>): Env {
  const { origins, error: originsError } = resolveAllowedOrigins(env);
  if (originsError) {
    throw new Error(`\n[BettaPay] Invalid or missing environment variables:\n  ALLOWED_ORIGINS: ${originsError}\n`);
  }

  try {
    const parsed = EnvSchema.parse(env);

    const contractIds = (parsed.CONTRACT_IDS ?? parsed.SETTLEMENT_CONTRACT_ID)
      .split(',')
      .map((id) => id.trim())
      .filter((id) => id.length > 0);

    if (contractIds.length === 0) {
      throw new Error('\n[BettaPay] Invalid or missing environment variables:\n  CONTRACT_IDS: at least one contract ID must be provided\n');
    }

    return { ...parsed, ALLOWED_ORIGINS: origins, CONTRACT_IDS: contractIds };
  } catch (error) {
    if (error instanceof z.ZodError) {
      const message = error.errors.map((e) => `  ${e.path.join('.')}: ${e.message}`).join('\n');
      throw new Error(`\n[BettaPay] Invalid or missing environment variables:\n${message}\n`);
    }
    throw error;
  }
}
