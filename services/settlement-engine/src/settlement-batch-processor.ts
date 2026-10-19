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
): Promise<boolean> {
  const result = await prisma.$executeRaw`
    UPDATE "SettlementBatch"
    SET "processedAt" = NOW()
    WHERE "id" = ${batchId}
      AND "processedAt" IS NULL
  `;

  // result is the number of rows updated
  // 0 = batch was already claimed by another worker
  // 1 = we successfully claimed the batch
  if (result === 0) {
    // Check if batch exists and is already processed
    const batch = await prisma.settlementBatch.findUnique({
      where: { id: batchId },
      select: { processedAt: true },
    });

    if (!batch) {
      throw new Error(`Batch ${batchId} not found`);
    }

    if (batch.processedAt) {
      throw new BatchAlreadyProcessedError(batchId);
    }

    // Batch exists but wasn't updated (race condition)
    return false;
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
 */
export async function runSettlementBatching(
  prisma: PrismaClient,
  config: BatchingRunConfig,
  lastCompletedAt: number,
  log: BatchingRunLogger,
  now: number = Date.now(),
  traceId?: string,
): Promise<BatchingRunResult> {
  const elapsedMs = now - lastCompletedAt;
  const late = elapsedMs > config.intervalMs * 1.5;
  const missedIntervals = late
    ? Math.floor(elapsedMs / config.intervalMs) - 1
    : 0;
  if (late) {
    log.warn(
      { traceId, elapsedMs, missedIntervals },
      "Batching job running late — catching up missed windows",
    );
  }

  const pendingSettlements = await prisma.settlement.findMany({
    where: { status: "pending" },
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
      const totalFees = settlements
        .reduce((sum, s) => sum.plus(s.feeAmount), new BigNumber(0))
        .toString();
      const totalNet = settlements
        .reduce((sum, s) => sum.plus(s.netAmount), new BigNumber(0))
        .toString();

      const batch = await prisma.settlementBatch.create({
        data: {
          asset,
          totalCount,
          totalGross: totalGrossBN.toString(),
          totalFees,
          totalNet,
        },
      });

      await prisma.settlement.updateMany({
        where: { id: { in: settlements.map((s) => s.id) } },
        data: { status: "processing" },
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
          grossTotal: totalGrossBN.toString(),
        },
        "Skipping batch (below min count and volume threshold)",
      );
    }
  }

  return { batched, late, missedIntervals, assets: Object.keys(grouped) };
}
