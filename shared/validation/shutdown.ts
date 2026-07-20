/**
 * @bettapay/validation — shared graceful shutdown helper
 *
 * Every BettaPay service previously hand-rolled its own shutdown routine
 * (API Gateway, FX Engine, Settlement Engine, Indexer) with subtle,
 * inconsistent behaviour: only the settlement engine enforced a force-exit
 * timeout, the indexer never closed Redis/Prisma in the right order, and the
 * gateway never closed its BullMQ/Redis resources at all.
 *
 * This module centralises that logic. A single `gracefulShutdown(signal,
 * options)` function closes every managed resource in a deterministic order
 * and guarantees that a hung close cannot block process termination forever
 * (a configurable force-exit timeout fires `process.exit(1)`).
 *
 * Resource close order (mirrors the project's operational requirements):
 *   server (fastify) → BullMQ workers → BullMQ queues → Redis → Prisma
 *
 * `Promise.allSettled` is used *within* each phase so that a failure to close
 * one worker/queue still lets the others attempt to close, and so the overall
 * shutdown is reported as failed only after every resource has been given a
 * chance to release.
 *
 * The helper is intentionally dependency-free: it relies only on structural
 * typing (an object exposing the expected `close` / `$disconnect` / `quit`
 * methods) so it can be reused by services without forcing a hard dependency
 * on fastify / bullmq / ioredis / @prisma/client inside `@bettapay/validation`.
 */

/** A logger compatible with `fastify.log` (and the default console fallback). */
export interface ShutdownLogger {
  info: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
}

/** Structural view of a Fastify server. */
export interface ShutdownFastify {
  close: (options?: { timeout?: number }) => Promise<void>;
  log?: ShutdownLogger;
}

/** Structural view of a Prisma client. */
export interface ShutdownPrisma {
  $disconnect: () => Promise<void>;
}

/** Structural view of an ioredis (or compatible) client. */
export interface ShutdownRedis {
  quit: () => Promise<unknown>;
}

/** Structural view of a BullMQ Worker. */
export interface ShutdownWorker {
  close: () => Promise<void>;
}

/** Structural view of a BullMQ Queue. */
export interface ShutdownQueue {
  close: () => Promise<void>;
}

export interface GracefulShutdownBullMq {
  /** A single worker or an array of workers. All are closed in array order. */
  worker?: ShutdownWorker | ShutdownWorker[];
  /** A single queue or an array of queues. All are closed in array order. */
  queues?: ShutdownQueue | ShutdownQueue[];
}

export interface GracefulShutdownOptions {
  /** The HTTP server. Closed first so no new connections are accepted. */
  fastify: ShutdownFastify;
  /** Optional Prisma client, disconnected last. */
  prisma?: ShutdownPrisma;
  /** Optional Redis client, quit after BullMQ resources. */
  redis?: ShutdownRedis;
  /** Optional BullMQ workers/queues. */
  bullmq?: GracefulShutdownBullMq;
  /**
   * Force-exit timeout in milliseconds. If the shutdown sequence has not
   * finished within this window a `process.exit(1)` is forced.
   * Defaults to 30000 (30s), matching the settlement engine pattern.
   */
  timeoutMs?: number;
  /**
   * Optional logger. When omitted a console-based logger tagged `[shutdown]`
   * is used so the helper is safe to call in any context.
   */
  logger?: ShutdownLogger;
}

/** Default force-exit timeout — 30s, matching the settlement engine. */
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 30_000;

function toArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function formatMessage(msg: unknown): string {
  if (typeof msg === 'string') return msg;
  if (msg instanceof Error) return msg.message;
  try {
    return JSON.stringify(msg);
  } catch {
    return String(msg);
  }
}

function createDefaultLogger(): ShutdownLogger {
  return {
    info: (...args: unknown[]) => console.info('[shutdown]', ...args.map(formatMessage)),
    error: (...args: unknown[]) => console.error('[shutdown]', ...args.map(formatMessage)),
    warn: (...args: unknown[]) => console.warn('[shutdown]', ...args.map(formatMessage)),
  };
}

/**
 * Perform a graceful shutdown for the given signal.
 *
 * Resources are released in the canonical order (server → workers → queues →
 * redis → prisma). Each phase uses `Promise.allSettled` so a single failing
 * resource never prevents the others from being released. Once every managed
 * resource has been given a chance to close the process exits:
 *
 *   - `process.exit(0)` when every resource closed successfully, or
 *   - `process.exit(1)` when at least one resource failed to close, or when an
 *     unexpected error occurred.
 *
 * A force-exit timer (default 30s) guarantees the process cannot hang forever
 * if a resource close never settles; it fires `process.exit(1)`.
 */
export async function gracefulShutdown(
  signal: string,
  options: GracefulShutdownOptions,
): Promise<void> {
  const logger = options.logger ?? createDefaultLogger();
  const timeoutMs = options.timeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;

  let settled = false;

  const forceExit = setTimeout(() => {
    if (settled) return;
    logger.error(`Graceful shutdown timed out after ${timeoutMs}ms, forcing exit`);
    process.exit(1);
  }, timeoutMs);

  try {
    logger.info(`Received ${signal}, shutting down gracefully...`);

    // Phase 1 — server: stop accepting new connections.
    const serverResults = await Promise.allSettled([options.fastify.close()]);

    // Phase 2 — BullMQ workers (close all, even if some fail).
    const workers = toArray(options.bullmq?.worker);
    const workerResults = await Promise.allSettled(workers.map((w) => w.close()));

    // Phase 3 — BullMQ queues.
    const queues = toArray(options.bullmq?.queues);
    const queueResults = await Promise.allSettled(queues.map((q) => q.close()));

    // Phase 4 — Redis.
    const redisResults: PromiseSettledResult<unknown>[] = options.redis
      ? await Promise.allSettled([options.redis.quit()])
      : [];

    // Phase 5 — Prisma.
    const prismaResults: PromiseSettledResult<unknown>[] = options.prisma
      ? await Promise.allSettled([options.prisma.$disconnect()])
      : [];

    const results = [
      ...serverResults,
      ...workerResults,
      ...queueResults,
      ...redisResults,
      ...prismaResults,
    ];

    const failures = results.filter(
      (r): r is PromiseRejectedResult => r.status === 'rejected',
    );

    clearTimeout(forceExit);

    if (failures.length > 0) {
      for (const failure of failures) {
        logger.error(failure.reason, 'Resource failed to close during shutdown');
      }
      logger.error({ signal }, 'Graceful shutdown completed with errors');
      settled = true;
      process.exit(1);
      return;
    }

    logger.info({ signal }, 'Graceful shutdown completed successfully');
    settled = true;
    process.exit(0);
  } catch (error) {
    clearTimeout(forceExit);
    logger.error(error, `Error during graceful shutdown (${signal})`);
    settled = true;
    process.exit(1);
  }
}

/**
 * Wire the shared graceful-shutdown routine into the current process.
 *
 * Registers `SIGTERM` and `SIGINT` handlers that call `gracefulShutdown` with
 * the supplied options. A re-entrancy guard ensures a second signal (while a
 * shutdown is already in flight) is ignored, mirroring the settlement
 * engine's original behaviour.
 *
 * @returns a `deregister` function that removes the installed signal handlers.
 */
export function registerGracefulShutdown(
  options: GracefulShutdownOptions,
): () => void {
  let shuttingDown = false;

  const handler = (signal: string): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    void gracefulShutdown(signal, options);
  };

  const onSigterm = (): void => handler('SIGTERM');
  const onSigint = (): void => handler('SIGINT');

  process.on('SIGTERM', onSigterm);
  process.on('SIGINT', onSigint);

  return () => {
    process.removeListener('SIGTERM', onSigterm);
    process.removeListener('SIGINT', onSigint);
  };
}
