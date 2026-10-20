import test from 'node:test';
import assert from 'node:assert/strict';
import {
  registerPrismaPoolMetrics,
  updatePrismaPoolMetrics,
  startPrismaPoolMetricsCollector,
  checkPoolAlertThreshold,
  POOL_ALERT_THRESHOLD_RATIO,
} from './prisma-pool-metrics.js';

function createMockGauge() {
  let val = 0;
  return {
    set: (v: number) => { val = v; },
    getVal: () => val,
  };
}

function createMockRegistry() {
  const metrics: Record<string, any> = {};
  return {
    metricsStore: metrics,
    getSingleMetric: (name: string) => metrics[name] || null,
    Gauge: function GaugeMock(opts: { name: string; help: string }) {
      const g = createMockGauge();
      metrics[opts.name] = g;
      return g;
    },
  };
}

test('registerPrismaPoolMetrics: registers prisma_pool gauges without duplication', () => {
  const registry = createMockRegistry();
  const metrics1 = registerPrismaPoolMetrics(registry);
  const metrics2 = registerPrismaPoolMetrics(registry);

  assert.equal(metrics1?.usedGauge, metrics2?.usedGauge);
  assert.equal(metrics1?.idleGauge, metrics2?.idleGauge);
  assert.equal(metrics1?.waitingGauge, metrics2?.waitingGauge);
});

test('updatePrismaPoolMetrics: updates gauge values from pool statistics', () => {
  const registry = createMockRegistry();
  const mockPool = {
    totalCount: 10,
    idleCount: 7,
    waitingCount: 2,
  };

  updatePrismaPoolMetrics(mockPool, registry);

  assert.equal(registry.metricsStore['prisma_pool_used'].getVal(), 3);
  assert.equal(registry.metricsStore['prisma_pool_idle'].getVal(), 7);
  assert.equal(registry.metricsStore['prisma_pool_waiting'].getVal(), 2);
});

test('startPrismaPoolMetricsCollector: starts periodic updates and handles stop() cleanly', async () => {
  const registry = createMockRegistry();
  let poolStats = { totalCount: 5, idleCount: 5, waitingCount: 0 };

  const collector = startPrismaPoolMetricsCollector(() => poolStats, registry, 50);

  assert.equal(registry.metricsStore['prisma_pool_used'].getVal(), 0);

  poolStats = { totalCount: 5, idleCount: 2, waitingCount: 1 };

  await new Promise((resolve) => setTimeout(resolve, 100));

  assert.equal(registry.metricsStore['prisma_pool_used'].getVal(), 3);
  assert.equal(registry.metricsStore['prisma_pool_idle'].getVal(), 2);
  assert.equal(registry.metricsStore['prisma_pool_waiting'].getVal(), 1);

  collector.stop();
});

test('updatePrismaPoolMetrics: handles failing pool getter gracefully without throwing', () => {
  const registry = createMockRegistry();
  let warnCalled = false;

  const logger = {
    warn: () => {
      warnCalled = true;
    },
  };

  const failingGetter = () => {
    throw new Error('Database pool unavailable');
  };

  assert.doesNotThrow(() => {
    updatePrismaPoolMetrics(failingGetter, registry, logger);
  });

  assert.equal(warnCalled, true, 'Logger warning should be emitted on error');
});

// ── #520: alert threshold tests ───────────────────────────────────────────────

test('checkPoolAlertThreshold: fires warning when utilisation >= 80%', () => {
  const warnings: Array<{ obj: object; msg?: string }> = [];
  const logger = { warn: (obj: object, msg?: string) => warnings.push({ obj, msg }) };

  // 8 of 10 active = 80% — exactly at threshold.
  checkPoolAlertThreshold(8, 10, logger);

  assert.equal(warnings.length, 1, 'one warning emitted at 80% utilisation');
  assert.equal(warnings[0].msg, 'Prisma pool utilisation above alert threshold — DB latency may increase');
  assert.equal((warnings[0].obj as any).utilisationPct, 80);
});

test('checkPoolAlertThreshold: fires warning above 80% (near-exhausted pool)', () => {
  const warnings: Array<{ obj: object; msg?: string }> = [];
  const logger = { warn: (obj: object, msg?: string) => warnings.push({ obj, msg }) };

  checkPoolAlertThreshold(9, 10, logger); // 90%

  assert.equal(warnings.length, 1);
  assert.equal((warnings[0].obj as any).utilisationPct, 90);
  assert.equal((warnings[0].obj as any).activeCount, 9);
  assert.equal((warnings[0].obj as any).totalCount, 10);
});

test('checkPoolAlertThreshold: no warning when utilisation < 80% (healthy range)', () => {
  const warnings: Array<unknown> = [];
  const logger = { warn: (...args: unknown[]) => warnings.push(args) };

  checkPoolAlertThreshold(7, 10, logger); // 70% — below threshold

  assert.equal(warnings.length, 0, 'no warning in healthy range (< 80%)');
});

test('checkPoolAlertThreshold: respects custom threshold ratio', () => {
  const warnings: Array<unknown> = [];
  const logger = { warn: (...args: unknown[]) => warnings.push(args) };

  // Custom 50% threshold — 6 of 10 is 60%, above it.
  checkPoolAlertThreshold(6, 10, logger, 0.5);
  assert.equal(warnings.length, 1, 'fires with custom lower threshold');

  warnings.length = 0;

  // 4 of 10 = 40% — below 50% custom threshold.
  checkPoolAlertThreshold(4, 10, logger, 0.5);
  assert.equal(warnings.length, 0, 'no warning below custom threshold');
});

test('checkPoolAlertThreshold: skips check when totalCount is 0', () => {
  const warnings: Array<unknown> = [];
  const logger = { warn: (...args: unknown[]) => warnings.push(args) };

  checkPoolAlertThreshold(5, 0, logger); // would be division-by-zero

  assert.equal(warnings.length, 0, 'no warning when totalCount is 0 (pool not configured)');
});

test('updatePrismaPoolMetrics: emits alert warning when pool is over threshold', () => {
  const registry = createMockRegistry();
  const warnMessages: string[] = [];
  const logger = {
    warn: (_obj: object, msg?: string) => { if (msg) warnMessages.push(msg); },
  };

  // 9 of 10 active = 90% — above the 80% default threshold.
  const highLoad = { totalCount: 10, idleCount: 1, waitingCount: 0 };
  updatePrismaPoolMetrics(highLoad, registry, logger);

  assert.ok(
    warnMessages.some((m) => m.includes('utilisation above alert threshold')),
    'alert warning emitted when pool usage exceeds threshold',
  );
});

test('updatePrismaPoolMetrics: no alert warning when pool is in healthy range', () => {
  const registry = createMockRegistry();
  const warnMessages: string[] = [];
  const logger = {
    warn: (_obj: object, msg?: string) => { if (msg) warnMessages.push(msg); },
  };

  // 5 of 10 active = 50% — healthy range.
  const healthy = { totalCount: 10, idleCount: 5, waitingCount: 0 };
  updatePrismaPoolMetrics(healthy, registry, logger);

  assert.ok(
    !warnMessages.some((m) => m.includes('utilisation above alert threshold')),
    'no alert in healthy range',
  );
});

test('POOL_ALERT_THRESHOLD_RATIO: exported constant is 0.8 (80%)', () => {
  assert.equal(POOL_ALERT_THRESHOLD_RATIO, 0.8);
});

// ── Issue #898: Prisma pool saturation tests ──────────────────────────────────

test('Issue #898: saturation boundary tests just below (79%), at (80%), and above (81%) threshold', () => {
  const registry = createMockRegistry();
  const warnings: Array<{ obj: any; msg?: string }> = [];
  const logger = {
    warn: (obj: object, msg?: string) => warnings.push({ obj, msg }),
  };

  const totalCount = 100;

  // 1. Just below threshold: 79 active / 100 total (79% utilisation, 21 idle, 3 waiting)
  const belowUsage = { totalCount, idleCount: 21, waitingCount: 3, activeCount: 79 };
  updatePrismaPoolMetrics(belowUsage, registry, logger);

  // Assert gauge values reflect injected pool usage
  assert.equal(registry.metricsStore['prisma_pool_used'].getVal(), 79);
  assert.equal(registry.metricsStore['prisma_pool_idle'].getVal(), 21);
  assert.equal(registry.metricsStore['prisma_pool_waiting'].getVal(), 3);
  // Assert normal usage emits no alert
  assert.equal(warnings.length, 0, 'saturation at 79% (just below 80%) must not trigger alert');

  // 2. Exactly at threshold: 80 active / 100 total (80% utilisation, 20 idle, 5 waiting)
  const atUsage = { totalCount, idleCount: 20, waitingCount: 5, activeCount: 80 };
  updatePrismaPoolMetrics(atUsage, registry, logger);

  // Assert gauge values reflect injected pool usage
  assert.equal(registry.metricsStore['prisma_pool_used'].getVal(), 80);
  assert.equal(registry.metricsStore['prisma_pool_idle'].getVal(), 20);
  assert.equal(registry.metricsStore['prisma_pool_waiting'].getVal(), 5);
  // Assert crossing/reaching threshold emits expected signal
  assert.equal(warnings.length, 1, 'saturation at 80% (boundary) must trigger alert');
  assert.equal(warnings[0].msg, 'Prisma pool utilisation above alert threshold — DB latency may increase');
  assert.equal(warnings[0].obj.activeCount, 80);
  assert.equal(warnings[0].obj.totalCount, 100);
  assert.equal(warnings[0].obj.utilisationPct, 80);
  assert.equal(warnings[0].obj.thresholdPct, 80);

  // 3. Just above threshold: 81 active / 100 total (81% utilisation, 19 idle, 8 waiting)
  const aboveUsage = { totalCount, idleCount: 19, waitingCount: 8, activeCount: 81 };
  updatePrismaPoolMetrics(aboveUsage, registry, logger);

  // Assert gauge values reflect injected pool usage
  assert.equal(registry.metricsStore['prisma_pool_used'].getVal(), 81);
  assert.equal(registry.metricsStore['prisma_pool_idle'].getVal(), 19);
  assert.equal(registry.metricsStore['prisma_pool_waiting'].getVal(), 8);
  // Assert alert signal emitted
  assert.equal(warnings.length, 2, 'saturation at 81% (above threshold) must trigger alert');
  assert.equal(warnings[1].obj.activeCount, 81);
  assert.equal(warnings[1].obj.utilisationPct, 81);
});

test('Issue #898: steady-state normal usage emits no alerts over repeated updates', () => {
  const registry = createMockRegistry();
  const warnings: Array<{ obj: any; msg?: string }> = [];
  const logger = {
    warn: (obj: object, msg?: string) => warnings.push({ obj, msg }),
  };

  const normalStates = [
    { totalCount: 20, idleCount: 18, waitingCount: 0, activeCount: 2 },  // 10%
    { totalCount: 20, idleCount: 14, waitingCount: 0, activeCount: 6 },  // 30%
    { totalCount: 20, idleCount: 10, waitingCount: 0, activeCount: 10 }, // 50%
    { totalCount: 20, idleCount: 6, waitingCount: 1, activeCount: 14 },  // 70%
  ];

  for (const state of normalStates) {
    updatePrismaPoolMetrics(state, registry, logger);
    assert.equal(registry.metricsStore['prisma_pool_used'].getVal(), state.activeCount);
    assert.equal(registry.metricsStore['prisma_pool_idle'].getVal(), state.idleCount);
    assert.equal(registry.metricsStore['prisma_pool_waiting'].getVal(), state.waitingCount);
  }

  assert.equal(warnings.length, 0, 'steady-state normal usage below threshold must emit 0 alerts');
});

test('Issue #898: custom saturation threshold ratio asserts alert fires only when ratio is crossed', () => {
  const warnings: Array<{ obj: any; msg?: string }> = [];
  const logger = {
    warn: (obj: object, msg?: string) => warnings.push({ obj, msg }),
  };

  // Custom 60% threshold
  const customThreshold = 0.6;

  // Below custom threshold: 59% (59/100)
  checkPoolAlertThreshold(59, 100, logger, customThreshold);
  assert.equal(warnings.length, 0);

  // At custom threshold: 60% (60/100)
  checkPoolAlertThreshold(60, 100, logger, customThreshold);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].obj.utilisationPct, 60);
  assert.equal(warnings[0].obj.thresholdPct, 60);

  // Above custom threshold: 61% (61/100)
  checkPoolAlertThreshold(61, 100, logger, customThreshold);
  assert.equal(warnings.length, 2);
  assert.equal(warnings[1].obj.utilisationPct, 61);
});

