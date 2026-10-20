/**
 * Structured startup health check reporting (Issue #383)
 *
 * Runs dependency checks (Prisma, Redis, BullMQ), measures latency, and logs
 * a single structured report at startup. Fatal exit on critical failures.
 */

import type { FastifyInstance } from 'fastify';

export interface StartupCheckResult {
  name: string;
  status: 'ok' | 'fail' | 'skip';
  durationMs: number;
  error?: string;
}

export interface StartupReport {
  service: string;
  version: string;
  uptime: number;
  checks: StartupCheckResult[];
  overallStatus: 'healthy' | 'unhealthy';
}

async function timedCheck(
  name: string,
  fn: () => Promise<void>,
  critical: boolean,
): Promise<StartupCheckResult> {
  const start = Date.now();
  try {
    await fn();
    return { name, status: 'ok', durationMs: Date.now() - start };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return {
      name,
      status: critical ? 'fail' : 'ok',
      durationMs: Date.now() - start,
      error,
    };
  }
}

export interface ReadReplicaCheckOptions {
  /**
   * When true, missing DATABASE_READ_REPLICA_URL in production triggers fail-fast (critical error).
   * When false (default), it emits an explicit warning and reports degraded.
   */
  failFast?: boolean;
}

/**
 * Startup check for database read-replica configuration (#838).
 *
 * In production, checks that DATABASE_READ_REPLICA_URL is set so read queries
 * are properly offloaded to the replica. If unset, emits an explicit warning
 * or triggers fail-fast exit.
 * In development and test environments, an unset value is acceptable and leaves
 * startup behavior unchanged.
 */
export function createReadReplicaStartupCheck(
  env: { NODE_ENV?: string; DATABASE_READ_REPLICA_URL?: string } = process.env,
  logger?: FastifyInstance['log'],
  options: ReadReplicaCheckOptions = {},
): { name: string; fn: () => Promise<void>; critical: boolean } {
  const isCritical = options.failFast ?? false;
  return {
    name: 'read-replica',
    critical: isCritical,
    fn: async () => {
      const nodeEnv = env.NODE_ENV ?? process.env.NODE_ENV ?? 'development';
      const replicaUrl = env.DATABASE_READ_REPLICA_URL ?? process.env.DATABASE_READ_REPLICA_URL;

      if (nodeEnv === 'production' && !replicaUrl) {
        const message =
          'DATABASE_READ_REPLICA_URL is unset in production — read queries will route to primary database';
        if (logger) {
          logger.warn(
            { hint: 'Set DATABASE_READ_REPLICA_URL to offload read queries to a replica' },
            message,
          );
        }
        throw new Error(message);
      }
    },
  };
}

export interface RunStartupChecksOptions {
  service: string;
  version: string;
  logger: FastifyInstance['log'];
  checks: Array<{ name: string; fn: () => Promise<void>; critical: boolean }>;
  /** Optional env object for startup evaluation. Defaults to process.env. */
  env?: { NODE_ENV?: string; DATABASE_READ_REPLICA_URL?: string };
  /**
   * When true in production, missing DATABASE_READ_REPLICA_URL causes fail-fast exit.
   * Defaults to false (explicit warning).
   */
  readReplicaFailFast?: boolean;
}

export async function runStartupChecks(options: RunStartupChecksOptions): Promise<StartupReport> {
  const { service, version, logger, checks } = options;
  const startTime = Date.now();

  const allChecks = [...checks];
  if (
    allChecks.some((c) => c.name === 'prisma') &&
    !allChecks.some((c) => c.name === 'read-replica')
  ) {
    const checkEnv = options.env ?? process.env;
    const failFast = options.readReplicaFailFast ?? false;
    allChecks.push(createReadReplicaStartupCheck(checkEnv, logger, { failFast }));
  }

  const results: StartupCheckResult[] = [];
  let hasCriticalFailure = false;

  for (const check of allChecks) {
    const result = await timedCheck(check.name, check.fn, check.critical);
    results.push(result);

    if (result.status === 'fail') {
      hasCriticalFailure = true;
      logger.fatal(
        { check: result.name, durationMs: result.durationMs, error: result.error },
        `Startup check failed: ${result.name}`,
      );
    } else if (result.error) {
      logger.warn(
        { check: result.name, durationMs: result.durationMs, error: result.error },
        `Startup check degraded: ${result.name}`,
      );
    } else {
      logger.info(
        { check: result.name, durationMs: result.durationMs },
        `Startup check passed: ${result.name}`,
      );
    }
  }

  const report: StartupReport = {
    service,
    version,
    uptime: Date.now() - startTime,
    checks: results,
    overallStatus: hasCriticalFailure ? 'unhealthy' : 'healthy',
  };

  logger.info(report, 'Startup health report');

  if (hasCriticalFailure) {
    logger.fatal('Critical startup checks failed — exiting');
    process.exit(1);
  }

  return report;
}
