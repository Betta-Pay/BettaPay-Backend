/**
 * Structured logging configuration (Issue #119)
 *
 * A single shared Pino configuration used by every service so log level,
 * PII redaction, serialization, and formatting are consistent across the mesh:
 *  - level from `LOG_LEVEL` (default `info`)
 *  - redaction of sensitive fields (secret, token, secretHash, password, authorization,
 *    signingSecret, apiKey, cookie, set-cookie)
 *  - compact `req`/`res` serializers
 *  - pretty-printing in development, JSON in production
 */

import { createRequire } from 'module';
import type { FastifyBaseLogger } from 'fastify';

/** Fields that must never appear in logs, matched at top level and one level deep. */
const REDACT_PATHS = [
  'secret',
  'token',
  'secretHash',
  'password',
  'authorization',
  // Webhook signing secrets, API keys and HTTP cookies (#1081).
  'signingSecret',
  'apiKey',
  'cookie',
  '["set-cookie"]',
  '*.secret',
  '*.token',
  '*.secretHash',
  '*.password',
  '*.signingSecret',
  '*.apiKey',
  '*.cookie',
  '*["set-cookie"]',
  '*.*.signingSecret',
  '*.*.apiKey',
  'req.headers.authorization',
  'req.headers["x-service-token"]',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'res.headers["set-cookie"]',
  'headers.authorization',
  'headers["x-service-token"]',
  'headers.cookie',
  'headers["set-cookie"]',
  'headers["x-api-key"]',
];

export interface LoggerConfigOptions {
  /** Explicit level; defaults to `LOG_LEVEL` env then `info`. */
  level?: string;
  /** Force pretty-printing; defaults to true outside production. */
  pretty?: boolean;
}

/**
 * Returns a pino-pretty transport config, but only if `pino-pretty` is actually
 * installed — otherwise falls back to plain JSON so a missing dev dependency can
 * never crash a service at startup.
 */
function prettyTransport(): { target: string; options: Record<string, unknown> } | undefined {
  try {
    const require = createRequire(import.meta.url);
    require.resolve('pino-pretty');
    return {
      target: 'pino-pretty',
      options: { colorize: true, translateTime: 'SYS:standard', ignore: 'pid,hostname' },
    };
  } catch {
    return undefined;
  }
}

/**
 * Build the Fastify/Pino logger options. Pass the result as Fastify's `logger`
 * option (alongside `genReqId`).
 */
export function createLoggerOptions(options: LoggerConfigOptions = {}) {
  const level = options.level || process.env.LOG_LEVEL || 'info';
  const pretty = options.pretty ?? process.env.NODE_ENV !== 'production';

  return {
    level,
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    serializers: {
      // Compact request/response logging to cut verbosity vs. Fastify defaults.
      req(request: { method: string; url: string; id: string; ip?: string }) {
        return { method: request.method, url: request.url, requestId: request.id, remoteAddress: request.ip };
      },
      res(reply: { statusCode: number }) {
        return { statusCode: reply.statusCode };
      },
    },
    transport: pretty ? prettyTransport() : undefined,
  };
}

// Single source of truth for last-resort process guards lives in
// crash-handlers.ts; re-exported here so existing `@bettapay/validation`
// imports keep working (#1080).
export { installCrashHandlers } from './crash-handlers.js';
export type { CrashHandlerLogger } from './crash-handlers.js';

/**
 * Flushes a Pino logger's buffered output, giving up after `timeoutMs` so a
 * wedged destination can never block process exit. Loggers without `flush`
 * resolve immediately.
 */
export function flushLogger(
  log: object,
  timeoutMs = 500,
): Promise<void> {
  const flush = (log as { flush?: unknown }).flush;
  if (typeof flush !== 'function') return Promise.resolve();

  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    try {
      (flush as (cb?: (err?: Error) => void) => void).call(log, done);
    } catch {
      done();
    }
  });
}
