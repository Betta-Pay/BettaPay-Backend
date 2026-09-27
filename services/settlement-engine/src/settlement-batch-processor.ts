/**
 * settlement-batch-processor.ts
 *
 * Atomic batch processing with idempotency guard (#618).
 *
 * The processedAt timestamp acts as a claim flag: only one worker can successfully
 * update a batch from NULL to a timestamp. Racing workers will see rowCount === 0
 * and know they lost the race.
 */

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
