export interface MinimalGauge {
  set(value: number): void;
  set(labels: Record<string, string | number>, value: number): void;
}

export interface MinimalRegistry {
  getSingleMetric(name: string): unknown;
  registerMetric?(metric: unknown): void;
  Gauge?: any;
}

export interface PoolStatsProvider {
  totalCount?: number;
  idleCount?: number;
  waitingCount?: number;
  activeCount?: number;
}

export type PoolOrStatsGetter =
  | PoolStatsProvider
  | (() => PoolStatsProvider | null | undefined);

// ── Alert threshold (#520) ────────────────────────────────────────────────────
//
// Healthy pool utilisation range: 0 – 80 % of totalCount in active use.
// Above 80 % the pool is under pressure and response latency will increase.
// Above 95 % the pool is near-exhausted and new requests will queue or fail.
//
// The threshold is configurable so operators can tighten it for smaller pools
// (e.g. 10-connection staging) without changing code.

/** Fraction of total pool connections that is considered high utilisation. */
export const POOL_ALERT_THRESHOLD_RATIO = 0.8;

export interface PoolAlertLogger {
  warn: (obj: object, msg?: string) => void;
}

/**
 * Emits a structured warning when active connections exceed the alert threshold.
 *
 * @param activeCount  Number of connections currently in use.
 * @param totalCount   Maximum pool size (max connections configured).
 * @param logger       Logger to emit the warning through.
 * @param thresholdRatio  Fraction of totalCount that triggers the alert (default 0.8).
 */
export function checkPoolAlertThreshold(
  activeCount: number,
  totalCount: number,
  logger: PoolAlertLogger,
  thresholdRatio = POOL_ALERT_THRESHOLD_RATIO,
): void {
  if (totalCount <= 0) return;
  const utilisation = activeCount / totalCount;
  if (utilisation >= thresholdRatio) {
    logger.warn(
      {
        activeCount,
        totalCount,
        utilisationPct: Math.round(utilisation * 100),
        thresholdPct: Math.round(thresholdRatio * 100),
      },
      'Prisma pool utilisation above alert threshold — DB latency may increase',
    );
  }
}

let activeInterval: NodeJS.Timeout | null = null;

export function registerPrismaPoolMetrics(registry: any, promClientModule?: any) {
  if (!registry) return null;

  const existingUsed = typeof registry.getSingleMetric === 'function' ? (registry.getSingleMetric('prisma_pool_used') as MinimalGauge) : null;
  const existingIdle = typeof registry.getSingleMetric === 'function' ? (registry.getSingleMetric('prisma_pool_idle') as MinimalGauge) : null;
  const existingWaiting = typeof registry.getSingleMetric === 'function' ? (registry.getSingleMetric('prisma_pool_waiting') as MinimalGauge) : null;

  if (existingUsed && existingIdle && existingWaiting) {
    return { usedGauge: existingUsed, idleGauge: existingIdle, waitingGauge: existingWaiting };
  }

  const GaugeClass = promClientModule?.Gauge || registry?.Gauge;
  if (!GaugeClass) {
    return { usedGauge: existingUsed, idleGauge: existingIdle, waitingGauge: existingWaiting };
  }

  const usedGauge =
    existingUsed ||
    new GaugeClass({
      name: 'prisma_pool_used',
      help: 'Number of active PostgreSQL connection pool connections in use',
      registers: [registry],
    });

  const idleGauge =
    existingIdle ||
    new GaugeClass({
      name: 'prisma_pool_idle',
      help: 'Number of idle PostgreSQL connection pool connections',
      registers: [registry],
    });

  const waitingGauge =
    existingWaiting ||
    new GaugeClass({
      name: 'prisma_pool_waiting',
      help: 'Number of requests waiting for a PostgreSQL connection',
      registers: [registry],
    });

  return { usedGauge, idleGauge, waitingGauge };
}

export function updatePrismaPoolMetrics(
  poolOrGetter: PoolOrStatsGetter,
  registry: any,
  logger?: { warn: (obj: object, msg?: string) => void },
  promClientModule?: any
): void {
  try {
    const stats = typeof poolOrGetter === 'function' ? poolOrGetter() : poolOrGetter;
    if (!stats) return;

    const totalCount = typeof stats.totalCount === 'number' ? stats.totalCount : 0;
    const idleCount = typeof stats.idleCount === 'number' ? stats.idleCount : 0;
    const waitingCount = typeof stats.waitingCount === 'number' ? stats.waitingCount : 0;
    const activeCount =
      typeof stats.activeCount === 'number'
        ? stats.activeCount
        : Math.max(0, totalCount - idleCount);

    const metrics = registerPrismaPoolMetrics(registry, promClientModule);
    if (!metrics) return;

    if (metrics.usedGauge) metrics.usedGauge.set(activeCount);
    if (metrics.idleGauge) metrics.idleGauge.set(idleCount);
    if (metrics.waitingGauge) metrics.waitingGauge.set(waitingCount);

    // #520 — alert when pool utilisation exceeds the healthy range (> 80 %).
    if (logger && totalCount > 0) {
      checkPoolAlertThreshold(activeCount, totalCount, logger);
    }
  } catch (error) {
    if (logger) {
      logger.warn({ error }, 'Failed to collect Prisma pool metrics');
    }
  }
}

export function startPrismaPoolMetricsCollector(
  poolOrGetter: PoolOrStatsGetter,
  registry: any,
  intervalMs = 10000,
  logger?: { warn: (obj: object, msg?: string) => void },
  promClientModule?: any
): { stop: () => void } {
  if (activeInterval) {
    clearInterval(activeInterval);
    activeInterval = null;
  }

  registerPrismaPoolMetrics(registry, promClientModule);
  updatePrismaPoolMetrics(poolOrGetter, registry, logger, promClientModule);

  const timer = setInterval(() => {
    updatePrismaPoolMetrics(poolOrGetter, registry, logger, promClientModule);
  }, intervalMs);

  if (timer.unref) {
    timer.unref();
  }

  activeInterval = timer;

  return {
    stop: () => {
      clearInterval(timer);
      if (activeInterval === timer) {
        activeInterval = null;
      }
    },
  };
}
