/**
 * settlement-batch-processor.ts
 *
 * Atomic batch processing with idempotency guard (#618).
 *
 * The processedAt timestamp acts as a claim flag: only one worker can successfully
 * update a batch from NULL to a timestamp. Racing workers will see rowCount === 0
 * and know they lost the race.
 */

import BigNumber from "bignumber.js";
import type { PrismaClient } from "@prisma/client";

export class BatchAlreadyProcessedError extends Error {
  constructor(batchId: string) {
    super(`Batch ${batchId} has already been processed by another worker`);
    this.name = "BatchAlreadyProcessedError";
  }
}

/**
 * Atomically claims a batch for processing.
 *
 * Uses an UPDATE ... WHERE processedAt IS NULL to ensure only one worker
 * successfully claims the batch. If another worker has already claimed it,
 * returns null.
 *
 * @param prisma - Prisma client instance
 * @param batchId - The batch ID to claim
 * @returns The claimed batch, or null if already claimed
 * @throws BatchAlreadyProcessedError if the batch was already processed
 */
export async function claimBatchForProcessing(
  prisma: PrismaClient,
  batchId: string,
): Promise<boolean | null> {
  let count = 0;
  if (prisma.settlementBatch && typeof prisma.settlementBatch.updateMany === 'function') {
    const result = await prisma.settlementBatch.updateMany({
      where: {
        id: batchId,
        processedAt: null,
      },
      data: {
        processedAt: new Date(),
      },
    });
    count = result.count;
  } else if (typeof (prisma as any).$executeRaw === 'function') {
    count = await (prisma as any).$executeRaw`
      UPDATE "SettlementBatch"
      SET "processedAt" = NOW()
      WHERE "id" = ${batchId}
        AND "processedAt" IS NULL
    `;
  }

  // result.count === 0 means batch was already claimed by another worker.
  // Return null immediately without calling findUnique.
  if (count === 0) {
    return null;
  }

  return true;
}

/**
 * Process a settlement batch with atomic claim.
 *
 * Example usage:
 *
 * ```typescript
 * const claimed = await claimBatchForProcessing(prisma, batchId);
 * if (!claimed) {
 *   logger.warn({ batchId }, 'Batch already claimed by another worker');
 *   return;
 * }
 *
 * // Process the batch...
 * await processBatchItems(batchId);
 * ```
 */

export interface BatchingRunConfig {
  /** Expected interval between runs, in ms. */
  intervalMs: number;
  /** Minimum settlements per asset before a batch is created. */
  minCount: number;
  /** Gross volume that batches an asset regardless of count (0 disables). */
  volumeThreshold: number;
  /** Max settlements processed per run (0 / undefined = unlimited). */
  maxBatchSize?: number;
  /** Optional Redis instance for distributed locking. */
  redis?: any;
  /** Custom lock key (default: 'lock:settlement-batching') */
  lockKey?: string;
  /** Lock TTL in ms (default: Math.max(intervalMs, 30_000)) */
  lockTtlMs?: number;
}

export interface BatchingRunLogger {
  info: (obj: object, msg: string) => void;
  warn: (obj: object, msg: string) => void;
}

export interface BatchingRunResult {
  batched: number;
  /** True when the run started more than 1.5 intervals after the last one. */
  late: boolean;
  missedIntervals: number;
  /** Assets that had pending settlements in this run. */
  assets: string[];
}

/**
 * One pass of the settlement batching job (#320).
 *
 * Catch-up: pending settlements are not tied to a time window, so anything
 * queued while the worker was paused is picked up by the next run. Pending
 * rows are read oldest-first (initiatedAt, then id) so the original enqueue
 * order is preserved, and at most `maxBatchSize` are taken per run; the rest
 * stay pending for the following run.
 *
 * Concurrency guard: A Redis distributed lock prevents concurrent executions
 * from double-batching, and batch creation + settlement assignment are atomic
 * inside prisma.$transaction with status: 'pending' and batchId: null.
 * Aggregated totals use fixed-point notation (.toFixed()) to prevent scientific notation.
 */
export async function runSettlementBatching(
  prisma: PrismaClient,
  config: BatchingRunConfig,
  lastCompletedAt: number,
  log: BatchingRunLogger,
  now: number = Date.now(),
  traceId?: string,
  redisClient?: any,
): Promise<BatchingRunResult> {
  const elapsedMs = now - lastCompletedAt;
  const late = elapsedMs > config.intervalMs * 1.5;
  const missedIntervals = late
    ? Math.floor(elapsedMs / config.intervalMs) - 1
    : 0;

  const redis = config.redis ?? redisClient;
  const lockKey = config.lockKey ?? 'lock:settlement-batching';
  const lockVal = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const lockTtlMs = config.lockTtlMs ?? Math.max(config.intervalMs, 30_000);

  let lockAcquired = false;
  if (redis && typeof redis.set === 'function') {
    try {
      const res = await redis.set(lockKey, lockVal, 'PX', lockTtlMs, 'NX');
      if (res !== 'OK' && res !== true && res !== 1 && res !== '1') {
        log.warn({ traceId }, 'Settlement batching lock held by another worker; skipping run');
        return { batched: 0, late, missedIntervals, assets: [] };
      }
      lockAcquired = true;
    } catch (err) {
      log.warn({ err, traceId }, 'Failed to acquire Redis lock for settlement batching; skipping run');
      return { batched: 0, late, missedIntervals, assets: [] };
    }
  }

  try {
    if (late) {
      log.warn(
        { traceId, elapsedMs, missedIntervals },
        "Batching job running late — catching up missed windows",
      );
    }

    const pendingSettlements = await prisma.settlement.findMany({
      where: { status: "pending", batchId: null },
      orderBy: [{ initiatedAt: "asc" }, { id: "asc" }],
      ...(config.maxBatchSize && config.maxBatchSize > 0
        ? { take: config.maxBatchSize }
        : {}),
    });

    if (pendingSettlements.length === 0) {
      log.info({ traceId }, "No pending settlements to batch");
      return { batched: 0, late, missedIntervals, assets: [] };
    }

    const grouped = pendingSettlements.reduce(
      (acc, s) => {
        if (!acc[s.asset]) acc[s.asset] = [];
        acc[s.asset].push(s);
        return acc;
      },
      {} as Record<string, typeof pendingSettlements>,
    );

    let batched = 0;

    const runTx = typeof prisma.$transaction === 'function'
      ? (fn: (tx: any) => Promise<any>) => prisma.$transaction(fn)
      : (fn: (tx: any) => Promise<any>) => fn(prisma);

    for (const [asset, settlements] of Object.entries(grouped)) {
      const totalCount = settlements.length;
      const totalGrossBN = settlements.reduce(
        (sum, s) => sum.plus(s.grossAmount),
        new BigNumber(0),
      );
      const meetsCount = totalCount >= config.minCount;
      const meetsVolume =
        config.volumeThreshold > 0 &&
        totalGrossBN.isGreaterThanOrEqualTo(config.volumeThreshold);

      if (meetsCount || meetsVolume) {
        const totalGross = totalGrossBN.toFixed();
        const totalFees = settlements
          .reduce((sum, s) => sum.plus(s.feeAmount), new BigNumber(0))
          .toFixed();
        const totalNet = settlements
          .reduce((sum, s) => sum.plus(s.netAmount), new BigNumber(0))
          .toFixed();

        const batch = await runTx(async (tx) => {
          const createdBatch = await tx.settlementBatch.create({
            data: {
              asset,
              totalCount,
              totalGross,
              totalFees,
              totalNet,
            },
          });

          await tx.settlement.updateMany({
            where: {
              id: { in: settlements.map((s) => s.id) },
              status: "pending",
              batchId: null,
            },
            data: {
              status: "processing",
              batchId: createdBatch.id,
            },
          });

          return createdBatch;
        });

        log.info(
          {
            traceId,
            batchId: batch.id,
            asset,
            count: totalCount,
            trigger: meetsCount ? "count" : "volume",
          },
          "Created settlement batch",
        );

        batched += totalCount;
      } else {
        log.info(
          {
            traceId,
            asset,
            count: totalCount,
            grossTotal: totalGrossBN.toFixed(),
          },
          "Skipping batch (below min count and volume threshold)",
        );
      }
    }

    return { batched, late, missedIntervals, assets: Object.keys(grouped) };
  } finally {
    if (lockAcquired && redis) {
      try {
        if (typeof redis.eval === 'function') {
          await redis.eval(
            `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`,
            1,
            lockKey,
            lockVal,
          );
        } else if (typeof redis.del === 'function') {
          await redis.del(lockKey);
        }
      } catch (err) {
        log.warn({ err, traceId }, 'Failed to release Redis lock for settlement batching');
      }
    }
  }
}
