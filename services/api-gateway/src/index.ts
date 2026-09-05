// @ts-nocheck
/**
 * API Gateway — BettaPay Backend
 *
 * Unified REST entry point for the BettaPay platform.
 * Handles merchant registration, payment sessions, and settlement requests.
 *
 * Endpoints:
 *   GET    /api/health               — liveness and dependency probe
 *   GET    /api/health/all           — aggregated health across all services
 *   POST   /api/merchants            — register merchant (protected)
 *   GET    /api/merchants/:id        — fetch merchant (protected)
 *   DELETE /api/merchants/:id        — soft-delete merchant (protected)
 *   POST   /api/merchants/:id/restore — restore soft-deleted merchant (protected)
 *   POST   /api/merchants/:id/suspend  — suspend merchant (service-auth, #317)
 *   POST   /api/merchants/:id/unsuspend — unsuspend merchant (service-auth, #317)
 *   PATCH  /api/merchants/:id/settings — update merchant fee rules / settings (protected)
 *   POST   /api/payments             — initiate payment session (protected)
 *   GET    /api/payments             — list payments, merchant-scoped (protected, #553)
 *   GET    /api/payments/:id         — fetch payment session
 *   PATCH  /api/payments/:id/status  — transition payment status (protected)
 *   POST   /api/settlements          — trigger settlement (protected)
 *   GET    /api/deployments          — Soroban contract addresses (testnet)
 *   GET    /api/rates                — proxy to FX engine (timeout-aware)
 *   GET    /api/currencies           — proxy to FX engine (timeout-aware)
 *   GET    /api/quote                — proxy to FX engine (timeout-aware)
 */

import Fastify, {
  type FastifyBaseLogger,
  type FastifyRequest,
  type FastifyReply,
} from "fastify";
import cors from "@fastify/cors";
import fastifyJwt from "@fastify/jwt";
import rateLimit from "@fastify/rate-limit";
import crypto from "crypto";
import zlib from "zlib";
import { Transform } from "stream";
import { z } from "zod";
import {
  validateEnvOrExit,
  type Env,
  getPrismaLogLevels,
  setupPrismaQueryLogging,
  buildPrismaConnectionUrl,
  connectWithRetry,
  registerRequestId,
  createLoggerOptions,
  registerTracing,
  createRedisClient,
  waitForRedis,
  startRedisMemoryMonitor,
  startMetricsServer,
  logFeatureFlags,
  startPrismaPoolMetricsCollector,
  encryptField,
  decryptField,
  encryptSensitiveFields,
  decryptSensitiveFields,
} from "@bettapay/validation";
import * as promClient from "prom-client";
import { createFxClient } from "./clients/fx-client.js";
import {
  createIndexerClient,
  type IndexerClient,
} from "./clients/indexer-client.js";
import { UpstreamReadTimeoutError } from "./upstream-fetch.js";
import {
  WalletChallengeStore,
  WALLET_CHALLENGE_TTL_MS,
} from "./wallet-challenge-store.js";
import {
  createSettlementClient,
  SettlementEngineUnavailableError,
} from "./clients/settlement-client.js";
import {
  CreateMerchantBody,
  CreatePaymentBody,
  CreateSettlementBody,
  CreateSupportedAssetBody,
  UpdateSupportedAssetBody,
  UpdatePaymentStatusBody,
  UpdateSettlementStatusBody,
  UpdateMerchantSettingsBody,
  UpdateMerchantNameBody,
  WalletVerifyBody,
  AuthIpScoreQuery,
  SettlementListQuery,
  PaymentListQuery,
  PaginationQuery,
  BulkCancelPaymentsBody,
  UpdateMerchantKycBody,
  PAYMENT_STATUS_TRANSITIONS,
  SETTLEMENT_STATUS_TRANSITIONS,
  isValidTransition,
  createErrorResponse,
  ErrorCodes,
  registerErrorHandler,
  registerServiceAuth,
  createAuditLogger,
  timingSafeStrEqual,
} from "@bettapay/validation";
import type { Merchant } from "@prisma/client";
import type { ApiResponse, PaginatedResponse } from "@bettapay/shared-types";
import { buildPaginationMeta } from "@bettapay/shared-types";
import { PrismaClient } from "@prisma/client";
import pg from "pg";
import helmet from "@fastify/helmet";
import { PrismaPg } from "@prisma/adapter-pg";
import { fetchUpstream, UpstreamTimeoutError, SsrfRejectedError, validateUpstreamUrl } from "./upstream-fetch.js";
import { Keypair } from "@stellar/stellar-sdk";
import { OAuth2Client } from "google-auth-library";
import { registerGatewayHealthRoutes } from "./health.js";
import {
  startAbandonedPaymentsCron,
  stopAbandonedPaymentsCron,
} from "./abandoned-payments-cron.js";
import {
  startIdempotencyKeyCleanupCron,
  stopIdempotencyKeyCleanupCron,
} from "./idempotency-key-cleanup-cron.js";
import {
  createWebhookQueue,
  type WebhookJobData,
} from "@bettapay/webhook-delivery";
import { Queue } from "bullmq";
import { readServiceVersion } from "@bettapay/validation";

declare module "fastify" {
  export interface FastifyInstance {
    authenticate: (
      request: FastifyRequest,
      reply: FastifyReply,
    ) => Promise<void>;
  }
}

const IDEMPOTENCY_KEY_MAX_LEN = 255;
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// Caps decompressed request bodies. Fastify's own bodyLimit only sees the
// compressed (on-the-wire) byte count, so a small gzip payload can otherwise
// decompress to many times its transmitted size before bodyLimit ever applies.
const MAX_DECOMPRESSED_BODY_BYTES = 1_048_576;

class DecompressedSizeLimitError extends Error {
  statusCode = 413;
  code = "DECOMPRESSED_BODY_TOO_LARGE";
  constructor() {
    super("Decompressed request body exceeds the maximum allowed size");
  }
}

class InvalidGzipStreamError extends Error {
  statusCode = 400;
  code = "INVALID_GZIP_STREAM";
  constructor() {
    super("Request body is not a valid gzip stream");
  }
}

// Wraps a gunzip stream with a byte counter so an oversized decompressed
// payload is rejected (413) before it is buffered into memory, and any
// decompression failure surfaces as a 400 rather than a hung connection.
function createLimitedGunzipStream(maxBytes: number): {
  input: zlib.Gunzip;
  output: Transform;
} {
  const gunzip = zlib.createGunzip();
  let received = 0;

  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      received += chunk.length;
      if (received > maxBytes) {
        callback(new DecompressedSizeLimitError());
        return;
      }
      callback(null, chunk);
    },
  });

  gunzip.on("error", () => {
    limiter.destroy(new InvalidGzipStreamError());
  });

  gunzip.pipe(limiter);

  return { input: gunzip, output: limiter };
}

function readIdempotencyKey(request: FastifyRequest): string | null {
  const raw = request.headers["idempotency-key"];
  if (!raw) return null;
  const key = Array.isArray(raw) ? raw[0] : raw;
  return (key as string).trim() || null;
}

const isProduction = process.env.NODE_ENV === "production";

const env = validateEnvOrExit(process.env);
const PORT = Number(process.env.PORT ?? "3000");
const startTime = Date.now();
const SERVICE_VERSION = readServiceVersion(import.meta.url);

// --- Request lifecycle timeouts ---------------------------------------------

// REQUEST_TIMEOUT_MS bounds how long a single request may run. If a handler
// (e.g. a slow DB query or a hung upstream service) exceeds it, the per-request
// hook below replies 408 Request Timeout so the client connection is released
// instead of being held open and exhausting the connection pool.
//
// CONNECTION_TIMEOUT_MS is the socket-level backstop (set 1s higher). It closes
// any connection the request timeout did not already finish.
//
// IMPORTANT: keep both values BELOW any upstream load balancer / reverse proxy
// idle timeout (commonly 60s) so this gateway returns a clean 408 rather than
// the load balancer cutting the connection first.
const REQUEST_TIMEOUT_MS = 30_000;
const CONNECTION_TIMEOUT_MS = 31_000;

// --- App Factory & Configuration Options ------------------------------------
export interface AppOptions {
  prisma?: PrismaClient;
  indexerClient?: ReturnType<typeof createIndexerClient>;
  settlementClient?: ReturnType<typeof createSettlementClient>;
  fxClient?: ReturnType<typeof createFxClient>;
  redis?: ReturnType<typeof createRedisClient>;
  logger?: any;
  fetchImpl?: typeof fetch;
  interServiceSecret?: string | string[];
}

export interface MerchantJwtPayload {
  merchantId?: string;
  ownerId?: string;
  jti?: string;
  iat?: number;
  exp?: number;
}

let defaultPrisma: PrismaClient | null = null;
let sharedPgPool: pg.Pool | null = null;
export function getDefaultPrisma(): PrismaClient {
  if (!defaultPrisma) {
    sharedPgPool = new pg.Pool({
      connectionString: buildPrismaConnectionUrl(
        env.DATABASE_URL,
        env.DATABASE_POOL_SIZE,
        env.DATABASE_POOL_TIMEOUT,
      ),
      max: env.DATABASE_POOL_SIZE,
      connectionTimeoutMillis: env.DATABASE_POOL_TIMEOUT * 1000,
    });
    const adapter = new PrismaPg(sharedPgPool);
    defaultPrisma = new PrismaClient({ adapter, log: getPrismaLogLevels() });
    startPrismaPoolMetricsCollector(
      sharedPgPool,
      promClient.register,
      10000,
      undefined,
      promClient,
    );
  }
  return defaultPrisma;
}

// Set by buildApp() when it creates the app's Redis client — shutdown()/start()
// (defined after buildApp, at module scope) need it but don't have their own
// handle on the instance buildApp created internally.
let sharedRedis: ReturnType<typeof createRedisClient> | null = null;

// --- Response logging hooks -------------------------------------------------
const SENSITIVE_FIELDS = new Set([
  "token",
  "secret",
  "secretHash",
  "password",
  "privateKey",
  "secretKey",
]);
const CONTROL_CHARS_EXCEPT_NEWLINES_AND_TABS =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

function sanitizeString(value: string): string {
  return value
    .trim()
    .replace(CONTROL_CHARS_EXCEPT_NEWLINES_AND_TABS, "")
    .normalize("NFC");
}

export function sanitizeInput(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") {
    return sanitizeString(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeInput(item, seen));
  }

  if (value && typeof value === "object") {
    if (seen.has(value)) return value;
    seen.add(value);

    const record = value as Record<string, unknown>;
    for (const [key, nestedValue] of Object.entries(record)) {
      record[key] = sanitizeInput(nestedValue, seen);
    }
  }

  return value;
}

export const QUERY_PARAM_CONTROL_CHARS_REGEX =
  /[\u0000-\u0008\u000A-\u001F\u007F]/g;

export function sanitizeParamString(value: string): string {
  return value.replace(QUERY_PARAM_CONTROL_CHARS_REGEX, "");
}

export function sanitizeParamsValue(
  value: unknown,
  seen = new WeakSet<object>(),
): unknown {
  if (typeof value === "string") {
    return sanitizeParamString(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeParamsValue(item, seen));
  }

  if (value && typeof value === "object") {
    if (seen.has(value)) return value;
    seen.add(value);

    const record = value as Record<string, unknown>;
    for (const [key, nestedValue] of Object.entries(record)) {
      record[key] = sanitizeParamsValue(nestedValue, seen);
    }
  }

  return value;
}

function redactValue(value: any): any {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(redactValue);
  if (typeof value === "object") return redactObject(value);
  return value;
}

function redactObject(obj: Record<string, any>) {
  const out: Record<string, any> = {};
  for (const k of Object.keys(obj)) {
    try {
      if (SENSITIVE_FIELDS.has(k)) {
        out[k] = "[REDACTED]";
      } else {
        out[k] = redactValue(obj[k]);
      }
    } catch (e) {
      out[k] = "[REDACTION_ERROR]";
    }
  }
  return out;
}

function hashSecret(secret: string): string {
  return crypto.createHash("sha256").update(secret).digest("hex");
}

export function normalizeAndValidateEmail(
  rawEmail: unknown,
): { email: string; domain: string } | null {
  if (typeof rawEmail !== "string") return null;

  const trimmed = rawEmail.trim().replace(/[\uFF0E\u3002\uFF61]/g, ".");
  if (!trimmed || trimmed.length > 320) return null;

  const parsed = z.string().email().safeParse(trimmed);
  if (!parsed.success) return null;

  const normalized = trimmed.toLowerCase();
  const parts = normalized.split("@");
  if (parts.length !== 2) return null;

  const [localPart, domainPart] = parts;
  if (!localPart || !domainPart) return null;

  if (
    domainPart.startsWith(".") ||
    domainPart.endsWith(".") ||
    domainPart.includes("..")
  ) {
    return null;
  }

  return { email: normalized, domain: domainPart };
}

export function buildApp(opts: AppOptions = {}) {
  const fastify = Fastify({
    logger:
      opts.logger !== undefined
        ? opts.logger
        : createLoggerOptions({ level: env.LOG_LEVEL }),
    requestTimeout: REQUEST_TIMEOUT_MS,
    connectionTimeout: CONNECTION_TIMEOUT_MS,
    bodyLimit: 1_048_576,
  });

  registerRequestId(fastify);
  registerErrorHandler(fastify);
  registerTracing(fastify);
  registerServiceAuth(fastify, opts.interServiceSecret ?? env.INTER_SERVICE_SECRET);

  // Centralized query and path parameter sanitization preHandler hook:
  // Recursively strips unsafe ASCII control characters (0x00-0x1F except \t, 0x7F)
  fastify.addHook("preHandler", async (request: FastifyRequest) => {
    if (request.query && typeof request.query === "object") {
      sanitizeParamsValue(request.query);
    }
    if (request.params && typeof request.params === "object") {
      sanitizeParamsValue(request.params);
    }
  });

  // Transparent field-level decryption before sending API responses:
  fastify.addHook("preSerialization", async (_request, _reply, payload) => {
    return decryptSensitiveFields(payload);
  });

  // Guards against decompression bombs: Fastify's own bodyLimit only checks
  // the compressed (on-the-wire) size, so a small gzip payload could otherwise
  // decompress to well beyond the intended cap before anything notices.
  fastify.addHook("preParsing", async (request, _reply, payload) => {
    const contentEncoding = request.headers["content-encoding"];
    if (!contentEncoding || contentEncoding === "identity") {
      return payload;
    }
    if (contentEncoding !== "gzip") {
      return payload;
    }

    // The decompressed size no longer matches the original (compressed)
    // Content-Length, so drop it — otherwise Fastify's own body reader
    // rejects the request with FST_ERR_CTP_INVALID_CONTENT_LENGTH.
    delete request.headers["content-length"];

    const { input, output } = createLimitedGunzipStream(
      MAX_DECOMPRESSED_BODY_BYTES,
    );
    payload.pipe(input);
    return output;
  });

  const prisma = opts.prisma ?? getDefaultPrisma();
  const indexerClient =
    opts.indexerClient ??
    createIndexerClient({
      baseUrl: env.INDEXER_URL,
      serviceToken: env.INTER_SERVICE_SECRET,
      logger: fastify.log,
      timeoutMs: env.READ_TIMEOUT_MS,
    });
  const settlementClient =
    opts.settlementClient ??
    createSettlementClient({
      baseUrl: env.SETTLEMENT_ENGINE_URL,
      serviceToken: env.INTER_SERVICE_SECRET,
      logger: fastify.log,
      timeoutMs: env.WRITE_TIMEOUT_MS,
    });
  const fxClient =
    opts.fxClient ??
    createFxClient({
      baseUrl: env.FX_ENGINE_URL,
      serviceToken: env.INTER_SERVICE_SECRET,
      logger: fastify.log,
      timeoutMs: env.READ_TIMEOUT_MS,
    });
  const logAuditEvent = createAuditLogger(
    prisma as unknown as Parameters<typeof createAuditLogger>[0],
    fastify.log,
  );

  // Setup plugins
  fastify.register(helmet, {
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: { policy: "require-corp" },
    crossOriginOpenerPolicy: { policy: "same-origin" },
    crossOriginResourcePolicy: { policy: "same-origin" },
    referrerPolicy: { policy: "strict-origin-when-cross-origin" },
    hsts: { maxAge: 31536000 },
  });

  fastify.addHook("onSend", async (_request, reply, _payload) => {
    if (!reply.getHeader("permissions-policy")) {
      reply.header(
        "Permissions-Policy",
        "geolocation=(), microphone=(), camera=()",
      );
    }
  });

  fastify.register(cors, {
    origin: env.ALLOWED_ORIGINS,
    credentials: true,
  });

  fastify.register(fastifyJwt, {
    secret: env.JWT_SECRET,
    sign: {
      expiresIn: env.JWT_EXPIRES_IN,
    },
  });

  // Rate limiting: global default and route overrides
  const isRateLimitDisabled = () =>
    process.env.RATE_LIMIT_ENABLED === 'false' || process.env.RATE_LIMIT_ENABLED === '0';

  fastify.register(rateLimit, {
    max: 1000,
    timeWindow: "1 minute",
    skip: () => isRateLimitDisabled(),
    addHeaders: {
      "x-ratelimit-limit": true,
      "x-ratelimit-remaining": true,
      "x-ratelimit-reset": true,
      "retry-after": true,
    },
  });

  // Exposes standard X-RateLimit-* response headers on every rate-limited
  // route. The installed @fastify/rate-limit version tracks hit counts in a
  // store that's private to its own onRequest hook, with no read-only "peek"
  // API, so we mirror it with our own counter built from the same
  // `createRateLimit` helper and the route's own (global or overridden) limit
  // config. One `checkRateLimit` instance is cached per route so its counter
  // persists (and accumulates) across requests exactly like the real one —
  // both increment exactly once per request against the same max/window, so
  // they always agree on the numbers. Routes opted out via
  // `config: { rateLimit: false }` (e.g. health checks) are skipped.
  const rateLimitCheckers = new WeakMap<
    object,
    ReturnType<typeof fastify.createRateLimit>
  >();

  function parseWindowToSeconds(window: string | number | undefined): number {
    if (typeof window === 'number') {
      return Math.max(1, Math.floor(window / 1000));
    }
    if (!window || typeof window !== 'string') {
      return 60;
    }
    const str = window.trim().toLowerCase();
    if (str.includes('minute') || str.includes('m')) {
      const num = parseInt(str, 10);
      return (isNaN(num) ? 1 : num) * 60;
    }
    if (str.includes('hour') || str.includes('h')) {
      const num = parseInt(str, 10);
      return (isNaN(num) ? 1 : num) * 3600;
    }
    if (str.includes('second') || str.includes('s')) {
      const num = parseInt(str, 10);
      return isNaN(num) ? 1 : num;
    }
    const num = parseInt(str, 10);
    return isNaN(num) ? 60 : Math.max(1, Math.floor(num / 1000));
  }

  fastify.addHook(
    "onSend",
    async (request: FastifyRequest, reply: FastifyReply, payload) => {
      const routeConfig = request.routeOptions?.config as
        | { rateLimit?: false | Record<string, unknown> }
        | undefined;
      if (!routeConfig || routeConfig.rateLimit === false) {
        return payload;
      }

      let checkRateLimit = rateLimitCheckers.get(routeConfig);
      if (!checkRateLimit) {
        checkRateLimit = fastify.createRateLimit(
          typeof routeConfig.rateLimit === "object"
            ? routeConfig.rateLimit
            : {},
        );
        rateLimitCheckers.set(routeConfig, checkRateLimit);
      }

      const result = (await checkRateLimit(request)) as {
        max?: number;
        remaining?: number;
        ttlInSeconds?: number;
      };

      const max =
        typeof result.max === "number"
          ? result.max
          : typeof routeConfig.rateLimit === "object" &&
              typeof (routeConfig.rateLimit as any).max === "number"
            ? (routeConfig.rateLimit as any).max
            : 1000;
      const windowStr =
        (typeof routeConfig.rateLimit === "object" &&
          (routeConfig.rateLimit as any).timeWindow) ||
        "1 minute";
      const windowSeconds = parseWindowToSeconds(windowStr);

      const disabled = isRateLimitDisabled();
      const remaining = disabled ? max : (result.remaining ?? 0);
      const ttl = result.ttlInSeconds ?? windowSeconds;

      reply.header("X-RateLimit-Limit", max);
      reply.header("X-RateLimit-Remaining", remaining);
      reply.header(
        "X-RateLimit-Reset",
        Math.ceil(Date.now() / 1000) + ttl,
      );
      reply.header("X-RateLimit-Policy", `${max};w=${windowSeconds}`);

      return payload;
    },
  );

  // --- Same-origin enforcement --------------------------------------------------
  // Reject cross-origin mutations that lack an explicit CORS preflight.
  // State-changing requests without an Origin header must include an
  // `x-csrf-check` header to prove the caller is aware of the mutation.
  // GET/HEAD/OPTIONS are exempt since they cannot cause state changes.
  const ALLOWED_ORIGINS_SET = new Set(
    env.ALLOWED_ORIGINS.map((o) => o.toLowerCase()),
  );

  fastify.addHook(
    "onRequest",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const method = request.method;
      if (method === "GET" || method === "HEAD" || method === "OPTIONS") return;

      const origin = request.headers.origin;
      if (origin) {
        const normalised = origin.trim().replace(/\/+$/, "").toLowerCase();
        const isAllowed = [...ALLOWED_ORIGINS_SET].some((allowed) =>
          timingSafeStrEqual(normalised, allowed),
        );

        if (!isAllowed) {
          request.log.warn(
            { origin, method, url: request.url },
            "Rejected cross-origin mutation",
          );
          return reply
            .code(403)
            .send(
              createErrorResponse(
                ErrorCodes.INVALID_ORIGIN,
                "Request origin is not allowed",
              ),
            );
        }
      } else {
        const csrfCheck = request.headers["x-csrf-check"];
        if (!csrfCheck) {
          request.log.warn(
            { method, url: request.url },
            "Rejected mutation without Origin or CSRF header",
          );
          return reply
            .code(403)
            .send(
              createErrorResponse(
                ErrorCodes.INVALID_ORIGIN,
                "Missing Origin or x-csrf-check header",
              ),
            );
        }
      }
    },
  );

  // Request body logging for mutation endpoints
  async function logRequestBody(request: FastifyRequest, reply: FastifyReply) {
    if (request.body && typeof request.body === "object") {
      const cloned = JSON.parse(JSON.stringify(request.body));
      for (const key of SENSITIVE_FIELDS) {
        if (key in cloned) {
          cloned[key] = "[REDACTED]";
        }
      }
      const logLevel = isProduction ? "debug" : "info";
      request.log[logLevel](
        { requestId: request.id, body: cloned },
        "incoming request body",
      );
    }
  }

  // Authentication hook — verifies the JWT, rejects revoked tokens (jti
  // blocklist), and keeps the per-merchant session index fresh.
  fastify.decorate(
    "authenticate",
    async function (request: FastifyRequest, reply: FastifyReply) {
      try {
        await request.jwtVerify();
        const payload = request.user as MerchantJwtPayload;
        if (payload.jti && (await isJtiRevoked(payload.jti))) {
          return reply
            .code(401)
            .send(createErrorResponse(ErrorCodes.UNAUTHORIZED, "Unauthorized"));
        }
      } catch (err) {
        request.log.error(err);
        return reply
          .code(401)
          .send(createErrorResponse(ErrorCodes.UNAUTHORIZED, "Unauthorized"));
      }

      const jti = (request.user as any)?.jti;
      const merchantId = (request.user as any)?.merchantId;
      if (!jti || !merchantId) {
        return;
      }

      try {
        const ok = await updateSessionLastUsed(jti, merchantId);
        if (!ok) {
          request.log.warn(
            { jti, merchantId },
            "[Auth] JWT session missing or revoked",
          );
          return reply
            .code(401)
            .send(createErrorResponse(ErrorCodes.UNAUTHORIZED, "Unauthorized"));
        }
      } catch (err: any) {
        request.log.error(
          { err, jti, merchantId },
          "[Auth] Session validation failed",
        );
        return reply
          .code(503)
          .send(
            createErrorResponse(
              ErrorCodes.INTERNAL_ERROR,
              "Authentication service unavailable",
            ),
          );
      }
    },
  );

  // Per-merchant concurrent request limiting via Redis.
  // Uses INCR with a TTL so that abandoned connections (e.g. dropped before
  // onResponse fires) are automatically cleaned up after 30 seconds.
  const MERCHANT_CONCURRENCY_TTL_SEC = 30;
  const merchantMaxConcurrency = env.MERCHANT_MAX_CONCURRENCY;

  fastify.addHook(
    "preHandler",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const merchantId = (request.user as any)?.merchantId;
      if (!merchantId) return;

      const key = `concurrency:${merchantId}`;
      try {
        const count = await redis.incr(key);
        if (count === 1) {
          await redis.expire(key, MERCHANT_CONCURRENCY_TTL_SEC);
        }
        if (count > merchantMaxConcurrency) {
          await redis.decr(key);
          return reply
            .code(429)
            .header("Retry-After", "1")
            .send(
              createErrorResponse(
                ErrorCodes.CONCURRENCY_EXCEEDED,
                "Too many concurrent requests",
              ),
            );
        }
      } catch (err) {
        request.log.error(
          { err, merchantId },
          "Concurrency limiter Redis error — allowing request through",
        );
      }
    },
  );

  fastify.addHook(
    "onResponse",
    async (request: FastifyRequest, _reply: FastifyReply) => {
      const merchantId = (request.user as any)?.merchantId;
      if (!merchantId) return;

      const key = `concurrency:${merchantId}`;
      try {
        await redis.decr(key);
      } catch (err) {
        request.log.error(
          { err, merchantId },
          "Concurrency limiter Redis DECR error",
        );
      }
    },
  );

  fastify.addHook("preHandler", async (request) => {
    if (request.body !== undefined) {
      request.body = sanitizeInput(request.body);
    }
  });

  // Zod validation runs inside route handlers after this global preHandler, so
  // schemas receive trimmed, control-character-free, NFC-normalized strings.

  // Routes
  registerGatewayHealthRoutes({
    fastify,
    prisma,
    env: {
      FX_ENGINE_URL: env.FX_ENGINE_URL,
      SETTLEMENT_ENGINE_URL: env.SETTLEMENT_ENGINE_URL,
      INDEXER_URL: env.INDEXER_URL,
    },
    startTime,
    serviceVersion: SERVICE_VERSION,
    fetchImpl: opts.fetchImpl,
  });

  // --- Wallet Auth Challenge Store ----------------------------------------------
  // #386 — exponential backoff retry strategy
  const redis = createRedisClient(env.REDIS_URL, fastify.log);
  sharedRedis = redis;

  // Release the Redis connection when the app closes so tests (and workers)
  // don't leak sockets and hang the process.
  fastify.addHook("onClose", async () => {
    await redis.quit().catch(() => {});
    redis.disconnect();
  });

  // --- Auth IP reputation, token refresh & nonce replay (#task.md) -------------
  // IPs accumulate a score in Redis on failed auth attempts and decay on
  // success. Above the threshold the IP is blocked with a 5-minute Retry-After.
  const AUTH_IP_THRESHOLD = parseInt(
    process.env.AUTH_IP_THRESHOLD || "20",
    10,
  );
  const AUTH_IP_SCORE_TTL_SECONDS = 15 * 60;
  const AUTH_IP_RETRY_AFTER_SECONDS = 300;
  const REFRESH_RATE_LIMIT_MAX = 10;
  const REFRESH_RATE_LIMIT_SECONDS = 60;
  const NONCE_TTL_SECONDS = 5 * 60;

  function authIpScoreKey(ip: string): string {
    return "auth_ip_score:" + ip;
  }

  function revokedJtiKey(jti: string): string {
    return "revoked_jti:" + jti;
  }

  function usedNonceKey(nonce: string): string {
    return "used_nonce:" + nonce;
  }

  function refreshRateKey(merchantId: string): string {
    return "auth_refresh_rate:" + merchantId;
  }

  async function getAuthIpScore(ip: string): Promise<number> {
    try {
      return Number((await redis.get(authIpScoreKey(ip))) ?? "0");
    } catch (err) {
      fastify.log.warn(
        { err: (err as Error).message, ip },
        "Failed to read auth IP score from Redis — treating as 0",
      );
      return 0;
    }
  }

  async function updateAuthIpScore(ip: string, delta: number): Promise<number> {
    // Best-effort: auth-IP scoring is advisory. If Redis is unavailable we log
    // and carry on rather than turning an auth validation failure into a 500.
    const key = authIpScoreKey(ip);
    try {
      if (delta > 0) {
        const score = await redis.incrby(key, delta);
        await redis.expire(key, AUTH_IP_SCORE_TTL_SECONDS);
        return score;
      }
      const current = Number((await redis.get(key)) ?? "0");
      const next = Math.max(0, current + delta);
      if (next === 0) await redis.del(key);
      else await redis.set(key, String(next), "EX", AUTH_IP_SCORE_TTL_SECONDS);
      return next;
    } catch (err) {
      fastify.log.warn(
        { err: (err as Error).message, ip },
        "Failed to update auth IP score in Redis",
      );
      return 0;
    }
  }

  async function enforceAuthIpReputation(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    let score = 0;
    try {
      score = await getAuthIpScore(request.ip);
    } catch (err) {
      // Redis is unavailable — cannot verify reputation, so allow the request.
      request.log.warn(
        { err: (err as Error).message, ip: request.ip },
        "Auth IP reputation check skipped (Redis unavailable)",
      );
    }
    if (score >= AUTH_IP_THRESHOLD) {
      await reply
        .header("Retry-After", String(AUTH_IP_RETRY_AFTER_SECONDS))
        .code(429)
        .send(
          createErrorResponse(
            ErrorCodes.RATE_LIMITED,
            "Too many failed authentication attempts",
          ),
        );
    }
  }

  async function recordAuthIpFailure(
    request: FastifyRequest,
  ): Promise<void> {
    await updateAuthIpScore(request.ip, 1);
  }

  async function recordAuthIpSuccess(
    request: FastifyRequest,
  ): Promise<void> {
    await updateAuthIpScore(request.ip, -1);
  }

  async function isJtiRevoked(jti: string): Promise<boolean> {
    return (await redis.exists(revokedJtiKey(jti))) === 1;
  }

  async function revokeJti(jti: string, ttlSeconds: number): Promise<void> {
    await redis.set(revokedJtiKey(jti), "1", "EX", ttlSeconds);
  }

  async function incrementRefreshRate(merchantId: string): Promise<number> {
    const rateKey = refreshRateKey(merchantId);
    const count = await redis.incr(rateKey);
    if (count === 1) await redis.expire(rateKey, REFRESH_RATE_LIMIT_SECONDS);
    return count;
  }

  async function markNonceUsed(nonce: string): Promise<boolean> {
    return (
      (await redis.set(
        usedNonceKey(nonce),
        "1",
        "EX",
        NONCE_TTL_SECONDS,
        "NX",
      )) === "OK"
    );
  }

  function decodeWalletSignature(signature: string): Buffer {
    const trimmed = signature.trim();
    if (/^[0-9a-f]+$/i.test(trimmed) && trimmed.length % 2 === 0) {
      return Buffer.from(trimmed, "hex");
    }
    return Buffer.from(trimmed, "base64");
  }

  function verifyWalletSignature(
    address: string,
    challenge: string,
    signature: string,
  ): boolean {
    try {
      return Keypair.fromPublicKey(address).verify(
        Buffer.from(challenge, "utf8"),
        decodeWalletSignature(signature),
      );
    } catch (err) {
      return false;
    }
  }


  // Signs a merchant JWT with a fresh jti and registers the matching session in
  // Redis so the authenticate hook can keep the session index fresh and the
  // refresh flow can revoke the old token.
  async function signMerchantJwt(
    merchantId: string,
    ownerId: string,
  ): Promise<string> {
    const jti = await createAuthSession(merchantId, "unknown");
    return fastify.jwt.sign({ merchantId, ownerId, jti });
  }

  const GOOGLE_AUTH_GRACE_PERIOD_MS = 30_000;
  const GOOGLE_AUTH_LOCKOUT_KEY_PREFIX = "auth_fail:google:";
  const SESSION_KEY_PREFIX = "session:";
  const SESSION_INDEX_PREFIX = "sessions:";
  const SESSION_LIMIT_PER_MERCHANT = 10;

  async function getSessionMetadata(jti: string) {
    const sessionRaw = await redis.get(`${SESSION_KEY_PREFIX}${jti}`);
    if (!sessionRaw) return null;
    return JSON.parse(sessionRaw) as {
      merchantId: string;
      deviceInfo: string;
      createdAt: string;
      lastUsedAt: string;
    };
  }

  async function updateSessionLastUsed(jti: string, merchantId: string) {
    const session = await getSessionMetadata(jti);
    if (!session || session.merchantId !== merchantId) return false;
    session.lastUsedAt = new Date().toISOString();
    await Promise.all([
      redis.set(`${SESSION_KEY_PREFIX}${jti}`, JSON.stringify(session)),
      redis.zadd(
        `${SESSION_INDEX_PREFIX}${merchantId}`,
        Date.parse(session.lastUsedAt),
        jti,
      ),
    ]);
    return true;
  }

  async function createAuthSession(merchantId: string, deviceInfo: string) {
    const jti = crypto.randomBytes(16).toString("hex");
    const session = {
      merchantId,
      deviceInfo,
      createdAt: new Date().toISOString(),
      lastUsedAt: new Date().toISOString(),
    };
    const indexKey = `${SESSION_INDEX_PREFIX}${merchantId}`;

    await redis.set(`${SESSION_KEY_PREFIX}${jti}`, JSON.stringify(session));
    await redis.zadd(indexKey, Date.parse(session.lastUsedAt), jti);

    const totalSessions = await redis.zcard(indexKey);
    if (totalSessions > SESSION_LIMIT_PER_MERCHANT) {
      const toRemove = await redis.zrange(
        indexKey,
        0,
        totalSessions - SESSION_LIMIT_PER_MERCHANT - 1,
      );
      if (toRemove.length > 0) {
        await Promise.all(
          toRemove.map((oldJti) => redis.del(`${SESSION_KEY_PREFIX}${oldJti}`)),
        );
        await redis.zrem(indexKey, ...toRemove);
      }
    }

    return jti;
  }

  async function listAuthSessions(merchantId: string) {
    const indexKey = `${SESSION_INDEX_PREFIX}${merchantId}`;
    const jtis = await redis.zrange(indexKey, 0, -1);
    const sessions = await Promise.all(
      jtis.map(async (jti) => {
        const metadata = await getSessionMetadata(jti);
        return metadata ? { jti, ...metadata } : null;
      }),
    );
    return sessions.filter(
      (
        session,
      ): session is {
        jti: string;
        merchantId: string;
        deviceInfo: string;
        createdAt: string;
        lastUsedAt: string;
      } => Boolean(session),
    );
  }

  async function revokeAuthSession(merchantId: string, jti: string) {
    const metadata = await getSessionMetadata(jti);
    if (!metadata || metadata.merchantId !== merchantId) return false;
    await Promise.all([
      redis.del(`${SESSION_KEY_PREFIX}${jti}`),
      redis.zrem(`${SESSION_INDEX_PREFIX}${merchantId}`, jti),
    ]);
    return true;
  }

  async function getGoogleAuthLockoutCount(email: string) {
    return parseInt(
      (await redis.get(`${GOOGLE_AUTH_LOCKOUT_KEY_PREFIX}${email}`)) || "0",
      10,
    );
  }

  async function incrementGoogleAuthLockout(email: string) {
    const lockoutKey = `${GOOGLE_AUTH_LOCKOUT_KEY_PREFIX}${email}`;
    const count = await redis.incr(lockoutKey);
    await redis.expire(lockoutKey, env.AUTH_LOCKOUT_MINUTES * 60);
    return count;
  }

  async function resetGoogleAuthLockout(email: string) {
    await redis
      .del(`${GOOGLE_AUTH_LOCKOUT_KEY_PREFIX}${email}`)
      .catch(() => {});
  }

  fastify.post('/api/auth/refresh', {
    preHandler: [enforceAuthIpReputation]
  }, async (request, reply) => {
  try {
    await request.jwtVerify();
  } catch (err) {
    request.log.error(err);
    await recordAuthIpFailure(request);
    return reply.code(401).send(createErrorResponse(ErrorCodes.UNAUTHORIZED, 'Unauthorized'));
  }

  const payload = request.user as MerchantJwtPayload;
  if (!payload.merchantId || !payload.ownerId || !payload.jti || !payload.exp) {
    await recordAuthIpFailure(request);
    return reply.code(401).send(createErrorResponse(ErrorCodes.UNAUTHORIZED, 'Unauthorized'));
  }

  if (await isJtiRevoked(payload.jti)) {
    await recordAuthIpFailure(request);
    return reply.code(401).send(createErrorResponse(ErrorCodes.UNAUTHORIZED, 'Unauthorized'));
  }

  const remainingLifetime = payload.exp - Math.floor(Date.now() / 1000);
  if (remainingLifetime <= 0) {
    await recordAuthIpFailure(request);
    return reply.code(401).send(createErrorResponse(ErrorCodes.UNAUTHORIZED, 'Unauthorized'));
  }

  const refreshCount = await incrementRefreshRate(payload.merchantId);
  if (refreshCount > REFRESH_RATE_LIMIT_MAX) {
    return reply
      .header('Retry-After', String(REFRESH_RATE_LIMIT_SECONDS))
      .code(429)
      .send(createErrorResponse(ErrorCodes.RATE_LIMITED, 'Too many token refresh requests'));
  }

  await revokeJti(payload.jti, remainingLifetime);
  await recordAuthIpSuccess(request);

  return reply.send({
    token: await signMerchantJwt(payload.merchantId, payload.ownerId),
  });
});

fastify.post<{ Body: z.infer<typeof WalletVerifyBody> }>('/api/auth/wallet/verify', {
  preHandler: [enforceAuthIpReputation],
  config: { rateLimit: { max: 30, timeWindow: '1 minute' } }
}, async (request, reply) => {
  let d: z.infer<typeof WalletVerifyBody>;
  try {
    d = WalletVerifyBody.parse(request.body);
  } catch (err) {
    await recordAuthIpFailure(request);
    throw err;
  }

  // Atomically claim the server-issued challenge for this address. This is the
  // replay control: a captured, already-verified signed challenge finds
  // nothing here on a second attempt (#469).
  let stored;
  try {
    stored = await consumeWalletChallenge(redis, d.address);
  } catch (err) {
    request.log.error({ err }, 'Failed to read wallet challenge from Redis');
    return reply.code(503).send({ error: 'Authentication service unavailable' });
  }

  if (!stored) {
    await recordAuthIpFailure(request);
    return reply
      .code(409)
      .send(createErrorResponse(ErrorCodes.INVALID_REQUEST, 'Challenge expired or already used'));
  }

  if (stored.address !== d.address || Date.now() > stored.expiresAt) {
    await recordAuthIpFailure(request);
    return reply
      .code(409)
      .send(createErrorResponse(ErrorCodes.INVALID_REQUEST, 'Challenge expired or already used'));
  }

  // If the client echoed a challenge, it must be the one we issued.
  if (d.challenge && d.challenge !== stored.challenge) {
    await recordAuthIpFailure(request);
    return reply
      .code(409)
      .send(createErrorResponse(ErrorCodes.INVALID_REQUEST, 'Challenge does not match the one issued'));
  }

  // Verify against the *stored* challenge string, never the client-supplied one.
  if (!verifyWalletSignature(d.address, stored.challenge, d.signature)) {
    await recordAuthIpFailure(request);
    return reply.code(401).send(createErrorResponse(ErrorCodes.UNAUTHORIZED, 'Invalid wallet signature'));
  }

  // Defence in depth: also burn the raw nonce (challenge consume already made
  // replay impossible, but a used-nonce record survives a challenge-store flush).
  await markNonceUsed(stored.nonce).catch(() => {});

  await recordAuthIpSuccess(request);

  const merchant = await prisma.merchant.findFirst({
    where: {
      deletedAt: null,
      OR: [{ id: d.address }, { ownerId: d.address }],
    },
  });

  const response: Record<string, unknown> = { success: true, address: d.address };
  if (merchant) {
    response.token = await signMerchantJwt(merchant.id, merchant.ownerId);
  }

  return reply.send(response);
});

fastify.get('/api/admin/auth/ip-score', {
  preValidation: [fastify.authenticate]
}, async (request, reply) => {
  const payload = request.user as MerchantJwtPayload;
  if (payload.merchantId !== env.ADMIN_ADDRESS) {
    return reply.code(403).send(createErrorResponse(ErrorCodes.FORBIDDEN, 'Forbidden'));
  }

  const { ip } = AuthIpScoreQuery.parse(request.query ?? {});
  return { ip, score: await getAuthIpScore(ip) };
});

  // Wallet auth challenges are stored in Redis under a TTL (#554), so they
  // expire on their own, are visible to every gateway instance, and are
  // consumed by the first verification attempt.
  const walletChallenges = new WalletChallengeStore(redis, {
    ttlMs: WALLET_CHALLENGE_TTL_MS,
  });

  interface WalletChallengeRouteBody {
    address?: unknown;
  }

  const WalletChallengeBody = z.object({
    address: z.string().min(1, "address is required"),
  });

  fastify.post<{ Body: WalletChallengeRouteBody }>(
    "/api/auth/challenge",
    async (request, reply) => {
      const d = WalletChallengeBody.parse(request.body);

      let issued;
      try {
        issued = await walletChallenges.issue(d.address);
      } catch (err) {
        request.log.error(
          { err, address: d.address },
          "[Auth] Unable to store wallet challenge",
        );
        return reply
          .code(503)
          .send(
            createErrorResponse(
              ErrorCodes.INTERNAL_ERROR,
              "Authentication service unavailable",
            ),
          );
      }

      return reply.send({
        challenge: issued.challenge,
        expiresAt: new Date(issued.expiresAt).toISOString(),
      });
    },
  );

  interface WalletVerifyRouteBody {
    address?: unknown;
    signature?: unknown;
  }

  const LegacyWalletVerifyBody = z.object({
    address: z.string().min(1, "address is required"),
    signature: z.string().min(1, "signature is required"),
  });

  fastify.post<{ Body: WalletVerifyRouteBody }>(
    "/api/auth/verify",
    async (request, reply) => {
      const d = LegacyWalletVerifyBody.parse(request.body);

      // Consuming is atomic: the challenge is gone whatever happens next, so
      // it is single-use and a signature cannot be guessed at repeatedly
      // against one outstanding challenge (#554).
      let consumed;
      try {
        consumed = await walletChallenges.consume(d.address);
      } catch (err) {
        request.log.error(
          { err, address: d.address },
          "[Auth] Unable to read wallet challenge",
        );
        return reply
          .code(503)
          .send(
            createErrorResponse(
              ErrorCodes.INTERNAL_ERROR,
              "Authentication service unavailable",
            ),
          );
      }

      if (consumed.status === "not_found") {
        return reply
          .code(400)
          .send(
            createErrorResponse(
              ErrorCodes.INVALID_REQUEST,
              "Challenge not found or expired",
            ),
          );
      }

      if (consumed.status === "expired") {
        return reply
          .code(400)
          .send(
            createErrorResponse(
              ErrorCodes.INVALID_REQUEST,
              "Challenge expired",
            ),
          );
      }

      const challengeInfo = consumed.challenge;

      try {
        const keypair = Keypair.fromPublicKey(d.address);
        const isValid = keypair.verify(
          Buffer.from(challengeInfo.challenge),
          Buffer.from(d.signature, "hex"),
        );
        if (!isValid) {
          return reply
            .code(401)
            .send(
              createErrorResponse(ErrorCodes.UNAUTHORIZED, "Invalid signature"),
            );
        }
      } catch (err) {
        return reply
          .code(401)
          .send(
            createErrorResponse(ErrorCodes.UNAUTHORIZED, "Invalid signature"),
          );
      }

      let merchant;
      try {
        merchant = await prisma.merchant.upsert({
          where: { id: d.address },
          update: {},
          create: {
            id: d.address,
            name: `Merchant ${d.address.substring(0, 6)}`,
            ownerId: `owner-${d.address.substring(0, 6)}`,
            settings: {},
          },
        });
      } catch (err: any) {
        if (err.code === "P2002") {
          merchant = await prisma.merchant.findUnique({
            where: { id: d.address },
          });
        } else {
          throw err;
        }
      }

      if (!merchant) {
        return reply
          .code(500)
          .send(
            createErrorResponse(
              ErrorCodes.INTERNAL_ERROR,
              "Failed to upsert merchant",
            ),
          );
      }

      const token = fastify.jwt.sign({
        merchantId: merchant.id,
        ownerId: merchant.ownerId,
      });
      return reply.send({ token });
    },
  );

  interface GoogleAuthRouteBody {
    token?: unknown;
  }

  const GoogleAuthBody = z.object({
    token: z.string().min(1, "token is required"),
  });

  fastify.post<{ Body: GoogleAuthRouteBody }>(
    "/api/auth/google",
    async (request, reply) => {
      const d = GoogleAuthBody.parse(request.body);

      try {
        const client = new OAuth2Client();
        const ticket = await client.verifyIdToken({
          idToken: d.token,
          audience: process.env.GOOGLE_CLIENT_ID,
        });
        const payload = ticket.getPayload();
        if (!payload) {
          return reply
            .code(401)
            .send(
              createErrorResponse(
                ErrorCodes.UNAUTHORIZED,
                "Google token verification failed: invalid token payload",
              ),
            );
        }
        const rawEmail = payload.email;
        if (!rawEmail) {
          return reply
            .code(400)
            .send(
              createErrorResponse(
                ErrorCodes.INVALID_REQUEST,
                "Email missing in Google token payload",
              ),
            );
        }

        const validated = normalizeAndValidateEmail(rawEmail);
        if (!validated) {
          return reply
            .code(400)
            .send(
              createErrorResponse(
                ErrorCodes.INVALID_REQUEST,
                "Invalid Google email address format",
              ),
            );
        }

        const { email, domain } = validated;

        const lockoutCount = await getGoogleAuthLockoutCount(email);
        if (lockoutCount >= env.AUTH_MAX_FAILED_ATTEMPTS) {
          request.log.warn(
            { email, lockoutCount },
            "[Auth] Google OAuth locked out due to too many failed attempts",
          );
          return reply
            .code(429)
            .send(
              createErrorResponse(
                ErrorCodes.UNAUTHORIZED,
                "Too many failed attempts. Try again later.",
              ),
            );
        }

        if (env.ALLOWED_EMAIL_DOMAINS.length > 0) {
          if (!domain || !env.ALLOWED_EMAIL_DOMAINS.includes(domain)) {
            await incrementGoogleAuthLockout(email);
            request.log.info(
              { email, domain },
              "[Auth] Google OAuth rejected: email domain not allowed",
            );
            return reply
              .code(403)
              .send(
                createErrorResponse(
                  ErrorCodes.INVALID_ORIGIN,
                  "Email domain not allowed",
                  { domain },
                ),
              );
          }
        }

        const tokenExpired =
          typeof payload.exp === "number" && Date.now() / 1000 > payload.exp;
        const tokenAgeMs = tokenExpired ? Date.now() - payload.exp * 1000 : 0;
        if (tokenExpired && tokenAgeMs > GOOGLE_AUTH_GRACE_PERIOD_MS) {
          await incrementGoogleAuthLockout(email);
          request.log.warn(
            { email, expiredMs: tokenAgeMs },
            "[Auth] Google OAuth rejected: token expired",
          );
          return reply
            .code(401)
            .send(
              createErrorResponse(
                ErrorCodes.UNAUTHORIZED,
                "Google token expired",
              ),
            );
        }

        if (tokenExpired) {
          request.log.warn(
            { email, expiredMs: tokenAgeMs },
            "[Auth] Google OAuth accepted with expired token within grace period",
          );
        }

        request.log.info({ email }, "[Auth] Google OAuth accepted");

        await resetGoogleAuthLockout(email);

        let merchant = await prisma.merchant.findFirst({
          where: { ownerId: email, deletedAt: null },
        });
        if (!merchant) {
          const merchantId = `google_${crypto.randomBytes(8).toString("hex")}`;
          merchant = await prisma.merchant.create({
            data: {
              id: merchantId,
              name: email.split("@")[0] + " Merchant",
              ownerId: email,
              settings: {},
            },
          });
        }

        const deviceInfo = `${request.ip || "unknown"} ${request.headers["user-agent"] ?? "unknown"}`;
        const jti = await createAuthSession(merchant.id, deviceInfo);
        const jwtToken = fastify.jwt.sign(
          { merchantId: merchant.id, ownerId: merchant.ownerId },
          { jti },
        );
        return reply.send({ token: jwtToken });
      } catch (err: any) {
        request.log.error({ err }, "[Auth] Google OAuth failed");
        return reply
          .code(401)
          .send(
            createErrorResponse(
              ErrorCodes.UNAUTHORIZED,
              "Google token verification failed",
            ),
          );
      }
    },
  );

  fastify.post<{ Params: { id: string } }>(
    "/api/webhooks/:id/test",
    { preValidation: [fastify.authenticate] },
    async (request, reply) => {
      const { id } = request.params;
      const payload = request.user as MerchantJwtPayload;

      const existing = await prisma.webhookSubscription.findUnique({
        where: { id },
      });

      if (!existing) {
        return reply
          .code(404)
          .send(createErrorResponse(ErrorCodes.NOT_FOUND, "Webhook subscription not found"));
      }

      if (existing.merchantId !== payload.merchantId) {
        return reply
          .code(403)
          .send(createErrorResponse(ErrorCodes.FORBIDDEN, "Forbidden"));
      }

      try {
        const testResult = await indexerClient.testWebhook(
          id,
          payload.merchantId,
          request.headers as Record<string, string | string[] | undefined>
        );
        if (!testResult) {
          return reply
            .code(503)
            .send(createErrorResponse(ErrorCodes.INTERNAL_ERROR, "Indexer service unavailable"));
        }
        return reply.send(testResult);
      } catch (err) {
        if (err instanceof Error && err.message === 'NOT_FOUND') {
          return reply
            .code(404)
            .send(createErrorResponse(ErrorCodes.NOT_FOUND, "Webhook subscription not found in indexer"));
        }
        request.log.error({ err, id }, "Failed to test webhook");
        return reply
          .code(500)
          .send(createErrorResponse(ErrorCodes.INTERNAL_ERROR, "Failed to test webhook"));
      }
    },
  );

  fastify.get(
    "/api/auth/sessions",
    {
      preValidation: [fastify.authenticate],
    },
    async (request, reply) => {
      const merchantId = (request.user as any)?.merchantId;
      if (!merchantId) {
        return reply
          .code(401)
          .send(createErrorResponse(ErrorCodes.UNAUTHORIZED, "Unauthorized"));
      }

      const sessions = await listAuthSessions(merchantId);
      return reply.send({ data: { sessions } });
    },
  );

  fastify.delete<{ Params: { jti: string } }>(
    "/api/auth/sessions/:jti",
    {
      preValidation: [fastify.authenticate],
    },
    async (request, reply) => {
      const merchantId = (request.user as any)?.merchantId;
      const { jti } = request.params;

      if (!merchantId) {
        return reply
          .code(401)
          .send(createErrorResponse(ErrorCodes.UNAUTHORIZED, "Unauthorized"));
      }

      const revoked = await revokeAuthSession(merchantId, jti);
      if (!revoked) {
        return reply
          .code(404)
          .send(createErrorResponse(ErrorCodes.NOT_FOUND, "Session not found"));
      }

      return reply.send({ status: "revoked" });
    },
  );

  // Logout revokes the caller's own access token immediately: its jti is added
  // to the Redis blocklist (TTL = the token's remaining lifetime) and its
  // session record is dropped, so the authenticate hook rejects any further
  // use of that token well before its natural expiry (#478).
  fastify.post(
    "/api/auth/logout",
    {
      preValidation: [fastify.authenticate],
    },
    async (request, reply) => {
      const payload = request.user as MerchantJwtPayload;
      const jti = payload.jti;
      const merchantId = payload.merchantId;

      if (!jti || !merchantId) {
        return reply
          .code(401)
          .send(createErrorResponse(ErrorCodes.UNAUTHORIZED, "Unauthorized"));
      }

      const remainingLifetime =
        (payload.exp ?? 0) - Math.floor(Date.now() / 1000);
      if (remainingLifetime > 0) {
        await revokeJti(jti, remainingLifetime);
      }
      await revokeAuthSession(merchantId, jti);

      return reply.send({ status: "logged_out" });
    },
  );

  // Merchants
  fastify.post<{ Body: z.infer<typeof CreateMerchantBody> }>(
    "/api/merchants",
    {
      preValidation: [fastify.authenticate],
      preHandler: [logRequestBody],
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const d = CreateMerchantBody.parse(request.body);
      const secret = d.secret || crypto.randomBytes(24).toString("hex");
      const secretHash = encryptField(hashSecret(secret));
      const merchant = await prisma.$transaction(async (tx) => {
        const created = await tx.merchant.create({
          data: {
            id: d.id,
            name: d.name,
            ownerId: d.ownerId,
            settings: (d.settings as any) ?? {},
            secretHash,
          },
        });
        await logAuditEvent(
          "merchant.created",
          "merchant",
          created.id,
          { before: null, after: created },
          request,
          tx as unknown as Parameters<typeof logAuditEvent>[5],
        );
        return created;
      });
      if (!d.secret) {
        fastify.log.warn(
          { merchantId: merchant.id },
          "Auto-generated merchant secret returned in response. This will only be shown once.",
        );
      }
      const { secretHash: _hash, ...safeMerchant } = merchant;
      return reply.code(201).send({ data: { merchant: safeMerchant, secret } });
    },
  );

  fastify.get<{ Params: { id: string } }>(
    "/api/merchants/:id",
    {
      preValidation: [fastify.authenticate],
    },
    async (request, reply): Promise<ApiResponse<Merchant>> => {
      const { id } = request.params;
      const merchant = await prisma.merchant.findFirst({
        where: { id, deletedAt: null },
      });
      if (!merchant) {
        reply.code(404);
        return {
          error: createErrorResponse(
            ErrorCodes.NOT_FOUND,
            "Merchant not found",
          ),
        };
      }
      return { data: merchant };
    },
  );

  fastify.delete<{ Params: { id: string } }>(
    "/api/merchants/:id",
    {
      preValidation: [fastify.authenticate],
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const { id } = request.params;
      const merchant = await prisma.merchant.findFirst({
        where: { id, deletedAt: null },
      });
      if (!merchant)
        return reply
          .code(404)
          .send(
            createErrorResponse(ErrorCodes.NOT_FOUND, "Merchant not found"),
          );

      await prisma.$transaction(async (tx) => {
        const updated = await tx.merchant.update({
          where: { id },
          data: { deletedAt: new Date() },
        });
        await logAuditEvent(
          "merchant.deleted",
          "merchant",
          updated.id,
          { before: merchant, after: updated },
          request,
          tx as unknown as Parameters<typeof logAuditEvent>[5],
        );

        // Best-effort cascade: cancel initiated payments
        try {
          const initiatedPayments = await tx.payment.findMany({
            where: { merchantId: id, status: "initiated" },
          });
          for (const payment of initiatedPayments) {
            const cancelled = await tx.payment.update({
              where: { id: payment.id },
              data: { status: "cancelled" },
            });
            await logAuditEvent(
              "payment.status.changed",
              "payment",
              payment.id,
              { before: payment, after: cancelled },
              request,
              tx as unknown as Parameters<typeof logAuditEvent>[5],
            );
          }
        } catch (err) {
          request.log.error(
            { err, merchantId: id },
            "Failed to cancel initiated payments during merchant soft-delete",
          );
        }

        // Best-effort cascade: fail pending settlements
        try {
          const pendingSettlements = await tx.settlement.findMany({
            where: { merchantId: id, status: "pending" },
          });
          for (const settlement of pendingSettlements) {
            const failed = await tx.settlement.update({
              where: { id: settlement.id },
              data: { status: "failed", completedAt: new Date() },
            });
            await logAuditEvent(
              "settlement.status.changed",
              "settlement",
              settlement.id,
              { before: settlement, after: failed },
              request,
              tx as unknown as Parameters<typeof logAuditEvent>[5],
            );
          }
        } catch (err) {
          request.log.error(
            { err, merchantId: id },
            "Failed to fail pending settlements during merchant soft-delete",
          );
        }
      });

      return reply.code(200).send({ success: true });
    },
  );

  fastify.post<{ Params: { id: string } }>(
    "/api/merchants/:id/restore",
    {
      preValidation: [fastify.authenticate],
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const { id } = request.params;
      const merchant = await prisma.merchant.findUnique({ where: { id } });
      if (!merchant)
        return reply
          .code(404)
          .send(
            createErrorResponse(ErrorCodes.NOT_FOUND, "Merchant not found"),
          );
      if (!merchant.deletedAt) {
        return reply
          .code(400)
          .send(
            createErrorResponse(
              ErrorCodes.INVALID_REQUEST,
              "Merchant is not soft-deleted",
            ),
          );
      }

      const restored = await prisma.merchant.update({
        where: { id },
        data: { deletedAt: null },
      });

      return reply.code(200).send({ success: true, merchant: restored });
    },
  );

  // #317 — Merchant account suspension without data deletion. A suspended
  // merchant stays readable (GET endpoints still work) but cannot create new
  // payments or settlements. Suspension/unsuspension is a service-to-service
  // operation, so it is guarded by service-auth (x-service-token).
  const suspendMerchant = async (id: string, status: "suspended" | "active", request: any) => {
    const merchant = await prisma.merchant.findFirst({
      where: { id, deletedAt: null },
    });
    if (!merchant)
      return {
        code: 404 as const,
        body: createErrorResponse(ErrorCodes.NOT_FOUND, "Merchant not found"),
      };

    const conflictMessage =
      status === "suspended"
        ? "Merchant is already suspended"
        : "Merchant is already active";
    if (merchant.status === status)
      return {
        code: 409 as const,
        body: createErrorResponse(ErrorCodes.INVALID_REQUEST, conflictMessage),
      };

    await prisma.$transaction(async (tx) => {
      const updated = await tx.merchant.update({
        where: { id },
        data: { status },
      });
      await logAuditEvent(
        status === "suspended" ? "merchant.suspended" : "merchant.unsuspended",
        "merchant",
        updated.id,
        { before: merchant, after: updated },
        request,
        tx as unknown as Parameters<typeof logAuditEvent>[5],
      );
    });

    const updated = await prisma.merchant.findUnique({ where: { id } });
    const { secretHash: _hash, ...safeMerchant } = updated!;
    return { code: 200 as const, body: { data: safeMerchant } };
  };

  fastify.post<{ Params: { id: string } }>(
    "/api/merchants/:id/suspend",
    {
      preValidation: [fastify.serviceAuth],
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const { id } = request.params;
      const result = await suspendMerchant(id, "suspended", request);
      return reply.code(result.code).send(result.body);
    },
  );

  fastify.post<{ Params: { id: string } }>(
    "/api/merchants/:id/unsuspend",
    {
      preValidation: [fastify.serviceAuth],
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const { id } = request.params;
      const result = await suspendMerchant(id, "active", request);
      return reply.code(result.code).send(result.body);
    },
  );

  // Update per-merchant settings (fee rules, tier). Merges into existing settings so
  // a partial update does not wipe unrelated keys. The settlement engine reads
  // settings.feeBps from here when computing fees.
  fastify.patch<{
    Params: { id: string };
    Body: z.infer<typeof UpdateMerchantSettingsBody>;
  }>(
    "/api/merchants/:id/settings",
    {
      preValidation: [fastify.authenticate],
      preHandler: [logRequestBody],
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const d = UpdateMerchantSettingsBody.parse(request.body);

      // Reject attempts to set kycStatus via the merchant settings endpoint
      if ("kycStatus" in (request.body as Record<string, unknown>)) {
        return reply
          .code(403)
          .send(
            createErrorResponse(
              ErrorCodes.UNAUTHORIZED,
              "kycStatus cannot be updated via this endpoint",
            ),
          );
      }

      const { id } = request.params;
      const merchant = await prisma.merchant.findFirst({
        where: { id, deletedAt: null },
      });
      if (!merchant)
        return reply
          .code(404)
          .send(
            createErrorResponse(ErrorCodes.NOT_FOUND, "Merchant not found"),
          );

      const currentSettings = (merchant.settings ?? {}) as Record<
        string,
        unknown
      >;
      const nextSettings = { ...currentSettings, ...d };

      const updated = await prisma.$transaction(async (tx) => {
        const merchantUpdate = await tx.merchant.update({
          where: { id },
          data: { settings: nextSettings as object },
        });
        await logAuditEvent(
          "merchant.updated",
          "merchant",
          merchantUpdate.id,
          { before: merchant, after: merchantUpdate },
          request,
          tx as unknown as Parameters<typeof logAuditEvent>[5],
        );
        return merchantUpdate;
      });

      return reply.code(200).send({ data: { merchant: updated } });
    },
  );

  // Admin-only: update merchant KYC status
  fastify.patch<{
    Params: { id: string };
    Body: z.infer<typeof UpdateMerchantKycBody>;
  }>(
    "/api/admin/merchants/:id/kyc",
    {
      preValidation: [fastify.serviceAuth],
      preHandler: [logRequestBody],
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const d = UpdateMerchantKycBody.parse(request.body);
      const { id } = request.params;

      const merchant = await prisma.merchant.findFirst({
        where: { id, deletedAt: null },
      });
      if (!merchant)
        return reply
          .code(404)
          .send(
            createErrorResponse(ErrorCodes.NOT_FOUND, "Merchant not found"),
          );

      const updated = await prisma.$transaction(async (tx) => {
        const merchantUpdate = await tx.merchant.update({
          where: { id },
          data: { kycStatus: d.kycStatus },
        });
        await logAuditEvent(
          "merchant.kyc.updated",
          "merchant",
          merchantUpdate.id,
          {
            before: { kycStatus: merchant.kycStatus },
            after: { kycStatus: merchantUpdate.kycStatus },
          },
          request,
          tx as unknown as Parameters<typeof logAuditEvent>[5],
        );
        return merchantUpdate;
      });

      return reply.code(200).send({ data: { merchant: updated } });
    },
  );

  // Payments
  fastify.post<{ Body: z.infer<typeof CreatePaymentBody> }>(
    "/api/payments",
    {
      preValidation: [fastify.authenticate],
      preHandler: [logRequestBody],
      config: { rateLimit: { max: 300, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      // ── 1. Parse and validate request body ──────────────────────────────────────
      const d = CreatePaymentBody.parse(request.body);

      // ── 1b. Merchant must exist, be active (not soft-deleted) and not suspended ──
      const merchant = await prisma.merchant.findFirst({
        where: { id: d.merchantId, deletedAt: null },
      });
      if (!merchant) {
        return reply
          .code(404)
          .send(createErrorResponse(ErrorCodes.NOT_FOUND, "Merchant not found"));
      }
      if (merchant.status === "suspended") {
        return reply
          .code(403)
          .send(
            createErrorResponse(
              ErrorCodes.MERCHANT_SUSPENDED,
              "Merchant is suspended",
            ),
          );
      }

      // ── 2. Read and validate optional Idempotency-Key header ────────────────────
      const idempotencyKey = readIdempotencyKey(request);

      if (
        idempotencyKey !== null &&
        idempotencyKey.length > IDEMPOTENCY_KEY_MAX_LEN
      ) {
        return reply
          .code(400)
          .send(
            createErrorResponse(
              ErrorCodes.VALIDATION_ERROR,
              "Idempotency-Key must not exceed 255 characters",
            ),
          );
      }

      // ── 3. Idempotency check: look for a non-expired record with the same key ───
      if (idempotencyKey !== null) {
        const now = new Date();
        const existing = await prisma.payment.findFirst({
          where: {
            idempotencyKey,
            idempotencyKeyExpiresAt: { gt: now },
          },
        });

        if (existing) {
          request.log.info(
            { idempotencyKey, paymentId: existing.id },
            "Idempotency hit — returning cached payment",
          );
          return reply.code(200).send({ data: existing });
        }
      }

      // ── 4. Create the payment (with idempotency fields when a key was supplied) ──
      const idempotencyKeyExpiresAt = idempotencyKey
        ? new Date(Date.now() + IDEMPOTENCY_TTL_MS)
        : null;

      let fxQuote: Awaited<ReturnType<typeof fxClient.getQuote>> = null;
      if (d.convertTo) {
        try {
          fxQuote = await fxClient.getQuote(
            { from: d.asset, to: d.convertTo, amount: d.amount },
            request.headers,
          );
        } catch (err) {
          if (err instanceof UpstreamReadTimeoutError) {
            request.log.warn(
              { service: err.service, endpoint: err.endpoint },
              "fx-service read timeout — no cached quote available, returning 503",
            );
            return reply
              .code(503)
              .header("Retry-After", "5")
              .send(
                createErrorResponse(
                  ErrorCodes.GATEWAY_TIMEOUT,
                  "FX service temporarily unavailable, please retry",
                ),
              );
          }
          throw err;
        }
      }

      const payment = await prisma.$transaction(async (tx) => {
        const created = await tx.payment.create({
          data: {
            id: "pay_" + crypto.randomUUID().replace(/-/g, ""),
            merchantId: d.merchantId,
            payerId: d.payerId,
            amount: d.amount,
            asset: d.asset,
            reference: d.reference,
            status: "initiated",
            idempotencyKey: idempotencyKey ?? undefined,
            idempotencyKeyExpiresAt: idempotencyKeyExpiresAt ?? undefined,
          },
        });
        await logAuditEvent(
          "payment.created",
          "payment",
          created.id,
          { before: null, after: created },
          request,
          tx as unknown as Parameters<typeof logAuditEvent>[5],
        );
        return created;
      });

      request.log.info(
        { idempotencyKey, paymentId: payment.id },
        idempotencyKey
          ? "Idempotency miss — payment created"
          : "Payment created (no idempotency key)",
      );

      if (d.convertTo) {
        return reply.code(201).send({ data: { ...payment, fxQuote } });
      }

      return reply.code(201).send({ data: payment });
    },
  );

  // Payments listing — merchant-scoped and paginated, mirroring /api/settlements.
  //
  // Authorization: service-to-service callers (x-service-token) may pass
  // merchantId to filter across merchants. Merchant-authenticated callers
  // (JWT) are always scoped to their own merchantId.
  //
  // Optional bulk event enrichment (?includeEvents=true, #553): the naive
  // approach of enriching each payment individually calls the indexer once
  // per payment, so listing latency scales with page size. Instead this
  // batches the lookup by the *unique* merchantIds present on the page —
  // for the common merchant-scoped case that's a single indexer call no
  // matter how many payments are returned — and reuses each result across
  // every payment for that merchant.
  fastify.get<{
    Querystring: z.infer<typeof PaymentListQuery> & { merchantId?: string };
  }>(
    "/api/payments",
    {
      preValidation: async (request: FastifyRequest, reply: FastifyReply) => {
        if (request.headers["x-service-token"]) {
          await fastify.serviceAuth(request, reply);
          return;
        }
        await fastify.authenticate(request, reply);
      },
      config: { rateLimit: { max: 100, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const query = PaymentListQuery.parse(request.query);
      const { status, from, to, limit, page, includeEvents } = query;
      const requestedMerchantId = (request.query as { merchantId?: string })
        .merchantId;

      const isServiceAuth = Boolean(request.headers["x-service-token"]);
      const scopedMerchantId = isServiceAuth
        ? requestedMerchantId
        : (request.user as { merchantId?: string } | undefined)?.merchantId;

      const where: any = {};
      if (scopedMerchantId) {
        where.merchantId = scopedMerchantId;
      }
      if (status) {
        where.status = status;
      }
      if (from || to) {
        where.createdAt = {};
        if (from) where.createdAt.gte = new Date(from);
        if (to) where.createdAt.lte = new Date(to);
      }

      const [records, total] = await Promise.all([
        prisma.payment.findMany({
          where,
          orderBy: { createdAt: "desc" },
          take: limit,
          skip: (page - 1) * limit,
        }),
        prisma.payment.count({ where }),
      ]);

      if (!includeEvents || records.length === 0) {
        return reply.send({
          data: records,
          pagination: buildPaginationMeta(page, limit, total),
        });
      }

      // One indexer call per unique merchantId on the page, not per payment.
      const uniqueMerchantIds = [
        ...new Set(records.map((p: { merchantId: string }) => p.merchantId)),
      ];
      const eventsByMerchant = new Map(
        await Promise.all(
          uniqueMerchantIds.map(async (merchantId) => {
            const events = await indexerClient.getPaymentEvents(
              merchantId,
              request.headers,
            );
            return [merchantId, events] as const;
          }),
        ),
      );

      const data = records.map((payment: { merchantId: string }) => ({
        ...payment,
        events: eventsByMerchant.get(payment.merchantId) ?? null,
      }));

      return reply.send({
        data,
        pagination: buildPaginationMeta(page, limit, total),
      });
    },
  );

  fastify.get<{
    Params: { id: string };
    Querystring: { includeEvents?: string };
  }>("/api/payments/:id", async (request, reply) => {
    const { id } = request.params;
    const payment = await prisma.payment.findUnique({ where: { id } });
    if (!payment)
      return reply
        .code(404)
        .send(createErrorResponse(ErrorCodes.NOT_FOUND, "Payment not found"));

    // Optional on-chain event enrichment (?includeEvents=true). The indexer is an
    // enrichment source only: if it is unavailable, `events` is null and the
    // payment is still returned so the endpoint never fails on indexer issues.
    if (request.query.includeEvents === "true") {
      // Forward tracing headers so the indexer call is part of the same trace (#118).
      const events = await indexerClient.getPaymentEvents(
        payment.merchantId,
        request.headers,
      );
      return { data: { ...payment, events } };
    }

    return { data: payment };
  });

  // Enforce valid status transitions. The DB enum and Prisma allow any status, so
  // this route is the single place that guards the payment state machine.
  fastify.patch<{
    Params: { id: string };
    Body: z.infer<typeof UpdatePaymentStatusBody>;
  }>(
    "/api/payments/:id/status",
    {
      preValidation: [fastify.authenticate],
      preHandler: [logRequestBody],
      config: { rateLimit: { max: 300, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const d = UpdatePaymentStatusBody.parse(request.body);

      const { id } = request.params;
      const payment = await prisma.payment.findUnique({ where: { id } });
      if (!payment)
        return reply
          .code(404)
          .send(createErrorResponse(ErrorCodes.NOT_FOUND, "Payment not found"));

      const allowed = PAYMENT_STATUS_TRANSITIONS[payment.status] ?? [];
      if (
        !isValidTransition(PAYMENT_STATUS_TRANSITIONS, payment.status, d.status)
      ) {
        return reply.code(422).send(
          createErrorResponse(
            ErrorCodes.VALIDATION_ERROR,
            "Invalid status transition",
            {
              from: payment.status,
              to: d.status,
              allowedTransitions: allowed,
            },
          ),
        );
      }

      const updated = await prisma.$transaction(async (tx) => {
        const paymentUpdate = await tx.payment.update({
          where: { id },
          data: { status: d.status },
        });
        await logAuditEvent(
          "payment.status.changed",
          "payment",
          paymentUpdate.id,
          { before: payment, after: paymentUpdate },
          request,
          tx as unknown as Parameters<typeof logAuditEvent>[5],
        );
        return paymentUpdate;
      });
      return reply.send({ data: updated });
    },
  );

  // Bulk-cancel initiated payments belonging to the authenticated merchant.
  fastify.post<{ Body: z.infer<typeof BulkCancelPaymentsBody> }>(
    "/api/payments/bulk-cancel",
    {
      preValidation: [fastify.authenticate],
      preHandler: [logRequestBody],
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const d = BulkCancelPaymentsBody.parse(request.body);
      const merchantId = (request.user as any).merchantId as string;

      // Deduplicate IDs
      const uniqueIds = [...new Set(d.paymentIds)];

      const payments = await prisma.payment.findMany({
        where: { id: { in: uniqueIds } },
      });

      const paymentMap = new Map(payments.map((p) => [p.id, p]));

      const cancelledIds: string[] = [];
      const skippedIds: string[] = [];
      const errors: { id: string; reason: string }[] = [];

      for (const id of uniqueIds) {
        const payment = paymentMap.get(id);
        if (!payment) {
          skippedIds.push(id);
          continue;
        }
        if (payment.merchantId !== merchantId) {
          skippedIds.push(id);
          continue;
        }
        if (payment.status !== "initiated") {
          skippedIds.push(id);
          continue;
        }
        cancelledIds.push(id);
      }

      if (cancelledIds.length > 0) {
        await prisma.$transaction(async (tx) => {
          for (const id of cancelledIds) {
            const before = paymentMap.get(id)!;
            const updated = await tx.payment.update({
              where: { id },
              data: { status: "cancelled" },
            });
            await logAuditEvent(
              "payment.status.changed",
              "payment",
              id,
              { before, after: updated },
              request,
              tx as unknown as Parameters<typeof logAuditEvent>[5],
            );
          }
        });
      }

      return reply.code(200).send({
        cancelled: cancelledIds.length,
        skipped: skippedIds.length,
        errors: errors.length,
        cancelledIds,
        skippedIds,
      });
    },
  );

  fastify.patch<{
    Params: { id: string };
    Body: z.infer<typeof UpdateSettlementStatusBody>;
  }>(
    "/api/settlements/:id/status",
    {
      preValidation: [fastify.authenticate],
      preHandler: [logRequestBody],
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      let d;
      try {
        d = UpdateSettlementStatusBody.parse(request.body);
      } catch (error) {
        return reply
          .code(400)
          .send(
            createErrorResponse(
              ErrorCodes.VALIDATION_ERROR,
              "Invalid request body",
              error,
            ),
          );
      }

      const { id } = request.params;
      const settlement = await prisma.settlement.findUnique({ where: { id } });
      if (!settlement)
        return reply
          .code(404)
          .send(
            createErrorResponse(ErrorCodes.NOT_FOUND, "Settlement not found"),
          );

      const allowed = SETTLEMENT_STATUS_TRANSITIONS[settlement.status] ?? [];
      if (
        !isValidTransition(
          SETTLEMENT_STATUS_TRANSITIONS,
          settlement.status,
          d.status,
        )
      ) {
        return reply.code(422).send(
          createErrorResponse(
            ErrorCodes.VALIDATION_ERROR,
            "Invalid status transition",
            {
              from: settlement.status,
              to: d.status,
              allowedTransitions: allowed,
            },
          ),
        );
      }

      const updated = await prisma.$transaction(async (tx) => {
        const settlementUpdate = await tx.settlement.update({
          where: { id },
          data: {
            status: d.status,
            ...(d.status === "completed" || d.status === "failed"
              ? { completedAt: new Date() }
              : {}),
          },
        });
        await logAuditEvent(
          "settlement.status.changed",
          "settlement",
          settlementUpdate.id,
          { before: settlement, after: settlementUpdate },
          request,
          tx as unknown as Parameters<typeof logAuditEvent>[5],
        );
        return settlementUpdate;
      });
      return reply.send({ data: updated });
    },
  );

  // Settlements
  //
  // Authorization: service-to-service callers (x-service-token) may pass
  // merchantId to filter across merchants. Merchant-authenticated callers
  // (JWT) are always scoped to their own merchantId — the query parameter is
  // ignored for them so one merchant can never read another's settlements.
  fastify.get<{
    Querystring: z.infer<typeof SettlementListQuery> & { merchantId?: string };
  }>(
    "/api/settlements",
    {
      preValidation: async (request: FastifyRequest, reply: FastifyReply) => {
        if (request.headers["x-service-token"]) {
          await fastify.serviceAuth(request, reply);
          return;
        }
        await fastify.authenticate(request, reply);
      },
      config: { rateLimit: { max: 100, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const query = SettlementListQuery.parse(request.query);
      const { status, from, to, limit, page } = query;
      const requestedMerchantId = (request.query as { merchantId?: string })
        .merchantId;

      const isServiceAuth = Boolean(request.headers["x-service-token"]);
      const scopedMerchantId = isServiceAuth
        ? requestedMerchantId
        : (request.user as { merchantId?: string } | undefined)?.merchantId;

      const { startDate, endDate, includeDeleted } = query as any;
      const where: any = {};
      if (scopedMerchantId) {
        where.merchantId = scopedMerchantId;
      }
      if (status) {
        where.status = status;
      }
      const effectiveFrom = startDate ?? from;
      const effectiveTo = endDate ?? to;
      if (effectiveFrom || effectiveTo) {
        where.initiatedAt = {};
        if (effectiveFrom) {
          where.initiatedAt.gte = new Date(effectiveFrom);
        }
        if (effectiveTo) {
          where.initiatedAt.lte = new Date(effectiveTo);
        }
      }

      // When includeDeleted is false, exclude settlements belonging to soft-deleted merchants.
      // Service-auth callers (preValidation: [fastify.serviceAuth]) always see everything.
      if (!includeDeleted) {
        where.merchant = { deletedAt: null };
      }

      const [records, total] = await Promise.all([
        prisma.settlement.findMany({
          where,
          orderBy: { initiatedAt: "desc" },
          take: limit,
          skip: (page - 1) * limit,
        }),
        prisma.settlement.count({ where }),
      ]);

      return {
        data: records,
        pagination: buildPaginationMeta(page, limit, total),
      };
    },
  );

  fastify.post<{ Body: z.infer<typeof CreateSettlementBody> }>(
    "/api/settlements",
    {
      preValidation: [fastify.authenticate],
      preHandler: [logRequestBody],
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const d = CreateSettlementBody.parse(request.body);
      const merchant = await prisma.merchant.findUnique({
        where: { id: d.merchantId },
      });

      if (!merchant) {
        return reply
          .code(404)
          .send(
            createErrorResponse(ErrorCodes.NOT_FOUND, "Merchant not found"),
          );
      }

      // #317 — suspended merchants cannot create new settlements
      if (merchant.status === "suspended") {
        return reply
          .code(403)
          .send(
            createErrorResponse(
              ErrorCodes.MERCHANT_SUSPENDED,
              "Merchant is suspended",
            ),
          );
      }

      const settings = merchant.settings as
        | {
            webhookUrl?: string;
            minSettlementAmount?: string;
            maxSettlementAmount?: string;
            dailySettlementLimit?: string;
          }
        | null
        | undefined;

      // Normalize to items array (backward compatibility: single amount/asset becomes single-item batch)
      const items =
        d.items ||
        (d.amount && d.asset ? [{ amount: d.amount, asset: d.asset }] : []);

      // #319 — Validate each asset against SupportedAsset table
      for (const item of items) {
        const supportedAsset = await prisma.supportedAsset.findUnique({
          where: { code: item.asset },
        });

        if (!supportedAsset || !supportedAsset.isActive) {
          return reply
            .code(422)
            .send(
              createErrorResponse(
                ErrorCodes.VALIDATION_ERROR,
                `Asset ${item.asset} is not supported`,
                { asset: item.asset },
              ),
            );
        }
      }

      // Validate each settlement item against merchant limits
      for (const item of items) {
        const amount = parseFloat(item.amount);

        // Check minimum settlement amount
        if (settings?.minSettlementAmount) {
          const minAmount = parseFloat(settings.minSettlementAmount);
          if (amount < minAmount) {
            return reply.code(422).send(
              createErrorResponse(
                ErrorCodes.VALIDATION_ERROR,
                `Settlement amount ${item.amount} is below minimum ${settings.minSettlementAmount}`,
                {
                  amount: item.amount,
                  minSettlementAmount: settings.minSettlementAmount,
                },
              ),
            );
          }
        }

        // Check maximum settlement amount
        if (settings?.maxSettlementAmount) {
          const maxAmount = parseFloat(settings.maxSettlementAmount);
          if (amount > maxAmount) {
            return reply.code(422).send(
              createErrorResponse(
                ErrorCodes.VALIDATION_ERROR,
                `Settlement amount ${item.amount} exceeds maximum ${settings.maxSettlementAmount}`,
                {
                  amount: item.amount,
                  maxSettlementAmount: settings.maxSettlementAmount,
                },
              ),
            );
          }
        }
      }

      // Check daily settlement limit (aggregate all assets)
      if (settings?.dailySettlementLimit) {
        const startTimeMs = Date.now();

        // The daily window boundary is derived from the database's own clock
        // (date_trunc('day', now())) and the aggregate is filtered on the
        // authoritative "initiatedAt" column, rather than a JS Date computed
        // from the gateway's wall clock. A process restart or server clock
        // skew therefore cannot shift, bypass, or curtail the window (#472).
        const aggregateResult = await prisma.$queryRaw<
          [{ sum: string | null }]
        >`
        SELECT COALESCE(SUM(CAST("totalAmount" AS DECIMAL)), 0)::text as sum
        FROM "Settlement"
        WHERE "merchantId" = ${d.merchantId}
        AND "initiatedAt" >= date_trunc('day', now())
      `;

        const currentDailyTotal = aggregateResult?.[0]?.sum
          ? parseFloat(aggregateResult[0].sum)
          : 0;
        const queryDurationMs = Date.now() - startTimeMs;
        request.log.debug(
          { queryDurationMs, merchantId: d.merchantId },
          "Daily settlement aggregate query",
        );

        const requestTotal = items.reduce(
          (sum: number, item: any) => sum + parseFloat(item.amount),
          0,
        );
        const newDailyTotal = currentDailyTotal + requestTotal;
        const dailyLimit = parseFloat(settings.dailySettlementLimit);

        if (newDailyTotal > dailyLimit) {
          return reply.code(422).send(
            createErrorResponse(
              ErrorCodes.VALIDATION_ERROR,
              `Daily settlement limit exceeded. Current: ${currentDailyTotal}, Requested: ${requestTotal}, Limit: ${settings.dailySettlementLimit}`,
              {
                currentDailyTotal: currentDailyTotal.toString(),
                requestedAmount: requestTotal.toString(),
                dailySettlementLimit: settings.dailySettlementLimit,
              },
            ),
          );
        }
      }

      try {
        const settlementResponse = await settlementClient.createSettlement(
          d,
          request.headers,
        );
        return reply
          .code(settlementResponse.status)
          .type(settlementResponse.contentType)
          .send(settlementResponse.body);
      } catch (err) {
        if (err instanceof SettlementEngineUnavailableError) {
          request.log.warn(
            { err },
            "settlement-engine unavailable during settlement creation",
          );
          return reply
            .code(504)
            .send(
              createErrorResponse(
                ErrorCodes.GATEWAY_TIMEOUT,
                "Settlement engine unavailable",
              ),
            );
        }
        throw err;
      }
    },
  );

  fastify.get(
    "/api/admin/audit-log",
    {
      preValidation: [fastify.serviceAuth],
      config: { rateLimit: { max: 100, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const { page, limit } = PaginationQuery.parse(request.query ?? {});
      const query = request.query as Record<string, string | undefined>;
      const where: Record<string, unknown> = {};

      if (query.entityType) {
        where.entityType = query.entityType;
      }
      if (query.action) {
        where.action = query.action;
      }
      if (query.startDate || query.endDate) {
        where.createdAt = {};
        if (query.startDate) {
          (where.createdAt as Record<string, Date>).gte = new Date(
            query.startDate,
          );
        }
        if (query.endDate) {
          (where.createdAt as Record<string, Date>).lte = new Date(
            query.endDate,
          );
        }
      }

      const [rows, total] = await Promise.all([
        prisma.auditLog.findMany({
          where,
          orderBy: { createdAt: "desc" },
          take: limit,
          skip: (page - 1) * limit,
        }),
        prisma.auditLog.count({ where }),
      ]);

      return reply.send({
        data: rows,
        pagination: buildPaginationMeta(page, limit, total),
      });
    },
  );

  fastify.get("/api/deployments", async (request, reply) => {
    return {
      data: {
        network: env.STELLAR_NETWORK_PASSPHRASE,
        contracts: [
          {
            name: "Settlement contract",
            contractId: env.SETTLEMENT_CONTRACT_ID,
            explorerUrl: `https://lab.stellar.org/r/testnet/contract/${env.SETTLEMENT_CONTRACT_ID}`,
          },
          {
            name: "Governance contract",
            contractId: env.GOVERNANCE_CONTRACT_ID,
            explorerUrl: `https://lab.stellar.org/r/testnet/contract/${env.GOVERNANCE_CONTRACT_ID}`,
          },
        ],
        updatedAt: new Date().toISOString(),
      },
    };
  });

  async function proxyFxUpstream(
    request: FastifyRequest,
    reply: FastifyReply,
    path: string,
  ) {
    if (path.startsWith('//') || path.includes('://')) {
      return reply
        .code(400)
        .send(
          createErrorResponse(
            ErrorCodes.VALIDATION_ERROR,
            "Invalid upstream path",
          ),
        );
    }

    let targetUrl: string;
    try {
      targetUrl = new URL(path, env.FX_ENGINE_URL).toString();
      validateUpstreamUrl(targetUrl);
    } catch (err) {
      if (err instanceof SsrfRejectedError) {
        request.log.warn({ path, err: err.message }, "SSRF attempt rejected");
        return reply
          .code(403)
          .send(
            createErrorResponse(
              ErrorCodes.FORBIDDEN,
              "Request to internal host is not allowed",
            ),
          );
      }
      throw err;
    }

    try {
      const response = await fetchUpstream(request, targetUrl, {}, request.log);
      const body = await response.text();
      const contentType =
        response.headers.get("content-type") ?? "application/json";
      return reply.code(response.status).type(contentType).send(body);
    } catch (err) {
      if (err instanceof UpstreamTimeoutError) {
        return reply
          .code(504)
          .send(
            createErrorResponse(ErrorCodes.GATEWAY_TIMEOUT, "Gateway Timeout"),
          );
      }
      throw err;
    }
  }

  fastify.get("/api/rates", async (request, reply) =>
    proxyFxUpstream(request, reply, "/api/rates"),
  );
  fastify.get("/api/currencies", async (request, reply) =>
    proxyFxUpstream(request, reply, "/api/currencies"),
  );

  // ============================================================================
  // SUPPORTED ASSETS (#319)
  // ============================================================================

  // GET /api/assets — list all supported assets
  fastify.get("/api/assets", async (request, reply) => {
    try {
      const assets = await prisma.supportedAsset.findMany({
        where: { isActive: true },
        select: {
          code: true,
          contractId: true,
          decimals: true,
          name: true,
          isActive: true,
        },
      });

      return { data: assets };
    } catch (error) {
      request.log.error({ error }, "Failed to fetch supported assets");
      return reply
        .code(500)
        .send(
          createErrorResponse(
            ErrorCodes.INTERNAL_ERROR,
            "Internal server error",
          ),
        );
    }
  });

  // POST /api/admin/assets — admin endpoint to add new asset
  fastify.post(
    "/api/admin/assets",
    {
      preValidation: [fastify.serviceAuth],
    },
    async (request, reply) => {
      const body = CreateSupportedAssetBody.parse(request.body);

      try {
        const asset = await prisma.supportedAsset.create({
          data: body,
        });

        await logAuditEvent(
          "asset.created",
          "SupportedAsset",
          asset.code,
          { before: null, after: asset },
          request,
        );

        return reply.code(201).send({ data: asset });
      } catch (error: any) {
        if (error.code === "P2002") {
          return reply
            .code(409)
            .send(
              createErrorResponse(
                ErrorCodes.INVALID_REQUEST,
                "Asset code already exists",
              ),
            );
        }
        request.log.error({ error }, "Failed to create supported asset");
        return reply
          .code(500)
          .send(
            createErrorResponse(
              ErrorCodes.INTERNAL_ERROR,
              "Internal server error",
            ),
          );
      }
    },
  );

  // PATCH /api/admin/assets/:code — admin endpoint to update asset
  fastify.patch(
    "/api/admin/assets/:code",
    {
      preValidation: [fastify.serviceAuth],
    },
    async (request, reply) => {
      const { code } = request.params as { code: string };
      const body = UpdateSupportedAssetBody.parse(request.body);

      try {
        const before = await prisma.supportedAsset.findUnique({
          where: { code },
        });

        const asset = await prisma.supportedAsset.update({
          where: { code },
          data: body,
        });

        await logAuditEvent(
          "asset.updated",
          "SupportedAsset",
          asset.code,
          { before, after: asset },
          request,
        );

        return { data: asset };
      } catch (error: any) {
        if (error.code === "P2025") {
          return reply
            .code(404)
            .send(createErrorResponse(ErrorCodes.NOT_FOUND, "Asset not found"));
        }
        request.log.error({ error }, "Failed to update supported asset");
        return reply
          .code(500)
          .send(
            createErrorResponse(
              ErrorCodes.INTERNAL_ERROR,
              "Internal server error",
            ),
          );
      }
    },
  );

  // DELETE /api/admin/assets/:code — admin endpoint to delete asset
  fastify.delete(
    "/api/admin/assets/:code",
    {
      preValidation: [fastify.serviceAuth],
    },
    async (request, reply) => {
      const { code } = request.params as { code: string };

      try {
        const before = await prisma.supportedAsset.delete({
          where: { code },
        });

        await logAuditEvent(
          "asset.deleted",
          "SupportedAsset",
          code,
          { before, after: null },
          request,
        );

        return reply.code(204).send();
      } catch (error: any) {
        if (error.code === "P2025") {
          return reply
            .code(404)
            .send(createErrorResponse(ErrorCodes.NOT_FOUND, "Asset not found"));
        }
        request.log.error({ error }, "Failed to delete supported asset");
        return reply
          .code(500)
          .send(
            createErrorResponse(
              ErrorCodes.INTERNAL_ERROR,
              "Internal server error",
            ),
          );
      }
    },
  );

  fastify.get("/api/quote", async (request, reply) => {
    const query = new URLSearchParams(
      request.query as Record<string, string>,
    ).toString();
    const path = query ? `/api/quote?${query}` : "/api/quote";
    return proxyFxUpstream(request, reply, path);
  });

  return fastify;
}

// ─── Warmup ─────────────────────────────────────────────────────────────────

interface DownstreamService {
  name: string;
  healthUrl: string;
}

function getDownstreamServices(env: Env): DownstreamService[] {
  return [
    { name: "fx-engine", healthUrl: `${env.FX_ENGINE_URL}/api/health` },
    { name: "indexer", healthUrl: `${env.INDEXER_URL}/api/health` },
  ];
}

/**
 * Make best-effort warmup requests to downstream services so their caches,
 * connection pools, and health state are ready before the gateway accepts
 * traffic. Each call carries a unique x-trace-id so operators can correlate
 * startup events across services.
 *
 * Errors are logged but never thrown — a downstream that is still warming up
 * should not prevent the gateway from starting.
 */
async function warmupDownstreamServices(
  env: Env,
  logger: FastifyBaseLogger,
): Promise<void> {
  const services = getDownstreamServices(env);

  await Promise.allSettled(
    services.map(async (svc) => {
      const traceId = crypto.randomUUID();
      const startTime = Date.now();

      try {
        const response = await fetch(svc.healthUrl, {
          headers: { "x-trace-id": traceId },
          signal: AbortSignal.timeout(5_000),
        });
        const durationMs = Date.now() - startTime;
        logger.info(
          {
            traceId,
            targetService: svc.name,
            statusCode: response.status,
            durationMs,
          },
          "Warmup completed",
        );
      } catch (err) {
        const durationMs = Date.now() - startTime;
        logger.warn(
          { traceId, targetService: svc.name, durationMs, err },
          "Warmup failed — downstream may not be ready",
        );
      }
    }),
  );
}

// Graceful shutdown
let mainApp: ReturnType<typeof Fastify> | null = null;
let metricsServer: ReturnType<typeof startMetricsServer> | null = null;
let shuttingDown = false;

async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;

  const app = mainApp!;
  app.log.info(`Received ${signal}, shutting down gracefully...`);

  try {
    await app.close();
    if (metricsServer) {
      await new Promise<void>((resolve) =>
        metricsServer!.close(() => resolve()),
      );
    }
    await getDefaultPrisma().$disconnect();
    stopAbandonedPaymentsCron();
    stopIdempotencyKeyCleanupCron();
    process.exit(0);
  } catch (err) {
    app.log.error(err, "Error during shutdown");
    process.exit(1);
  }
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

const start = async () => {
  try {
    const app = mainApp!;
    const prisma = getDefaultPrisma();
    const redis = sharedRedis!;

    // #391 — wait for dependencies before accepting traffic
    await connectWithRetry(prisma, app.log);
    await waitForRedis(redis, app.log);

    // #314 — warmup downstream services with unique trace IDs
    await warmupDownstreamServices(env, app.log);

    // #387 — Redis memory monitoring
    startRedisMemoryMonitor(redis, app.log);

    if (process.env.NODE_ENV !== "test") {
      const webhookQueue = createWebhookQueue("gateway-expired-webhooks", {
        url: env.REDIS_URL,
      });
      startAbandonedPaymentsCron(
        prisma,
        app.log,
        (env as any).PAYMENT_ABANDONMENT_HOURS ?? 24,
        webhookQueue,
      );
      startIdempotencyKeyCleanupCron(prisma, app.log, { redis });
    }
    await app.listen({ port: PORT, host: "0.0.0.0" });
  } catch (err) {
    if (mainApp) mainApp.log.error(err);
    else console.error(err);
    process.exit(1);
  }
};

const isDirectRun = Boolean(
  process.argv[1] &&
  (process.argv[1].endsWith("index.ts") ||
    process.argv[1].endsWith("index.js")),
);
if (isDirectRun) {
  mainApp = buildApp();

  // Served on its own port (see startMetricsServer), not the application
  // port — keeps the scrape endpoint unauthenticated without exposing it
  // alongside application traffic. Started only for the real server process,
  // not when buildApp() is called directly by tests.
  promClient.collectDefaultMetrics();
  metricsServer = startMetricsServer({
    appPort: PORT,
    contentType: promClient.register.contentType,
    getMetrics: () => promClient.register.metrics(),
    log: mainApp.log,
  });

  logFeatureFlags(mainApp.log);
  start();
}
