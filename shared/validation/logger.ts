/**
 * Structured logging configuration (Issue #119)
 *
 * A single shared Pino configuration used by every service so log level,
 * PII redaction, serialization, and formatting are consistent across the mesh:
 *  - level from `LOG_LEVEL` (default `info`)
 *  - redaction of sensitive fields (secret, token, secretHash, password, authorization)
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
  '*.secret',
  '*.token',
  '*.secretHash',
  '*.password',
  'req.headers.authorization',
  'req.headers["x-service-token"]',
  'headers.authorization',
  'headers["x-service-token"]',
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

/**
 * Last-resort process guards so a missed await or stray throw produces a
 * structured fatal log instead of silently killing the container. Nothing is
 * registered until this is called.
 */
export function installCrashHandlers(log: FastifyBaseLogger): void {
  process.on('unhandledRejection', (reason: unknown) => {
    log.fatal(
      { err: reason instanceof Error ? reason : new Error(String(reason)), errorClass: 'fatal' as const },
      'Unhandled promise rejection — exiting for supervisor restart',
    );
    process.exitCode = 1;
  });
  process.on('uncaughtException', (err: Error) => {
    log.fatal({ err, errorClass: 'fatal' as const }, 'Uncaught exception — exiting');
    process.exit(1);
  });
}
