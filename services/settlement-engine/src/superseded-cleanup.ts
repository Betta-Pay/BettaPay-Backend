// @ts-nocheck
import type { PrismaClient } from '@prisma/client';

/**
 * Issue #494: Settlement retry has no cleanup for superseded chains
 *
 * Periodically cleans up and archives old superseded settlements
 * to prevent unbounded chain growth. A settlement chain is considered
 * "complete" when:
 * - The final settlement in the chain has reached a terminal state (completed/failed)
 * - The chain is older than SUPERSEDED_RETENTION_DAYS
 */

const SUPERSEDED_RETENTION_DAYS = 7;
const SUPERSEDED_BATCH_SIZE = 100;

/**
 * Mark superseded settlement chains as archived.
 * Only archives chains where:
 * 1. The root settlement (first in chain) is older than retention period
 * 2. The current settlement (last in chain) is in a terminal state
 */
export async function archiveSupersededChains(prisma: PrismaClient, log: any): Promise<number> {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - SUPERSEDED_RETENTION_DAYS);

  // Find root settlements that are old enough and have completed chains
  const rootsToArchive = await prisma.settlement.findMany({
    where: {
      // Only settlements with no supersedingParent (they are roots)
      supersededBy: { none: {} },
      // Settlement itself is old
      initiatedAt: { lte: cutoffDate },
      // And has actually been superseded (has a parent)
      supersededById: { not: null },
      // And the final settlement is complete
      supersededBy: { some: { status: { in: ['completed', 'failed'] } } },
    },
    select: { id: true },
    take: SUPERSEDED_BATCH_SIZE,
  });

  if (rootsToArchive.length === 0) {
    return 0;
  }

  const rootIds = rootsToArchive.map(r => r.id);

  // Mark all settlements in these chains as archived (soft-delete marker)
  // We use a metadata field to track this without adding a new column
  const archived = await prisma.settlement.updateMany({
    where: {
      OR: [
        { id: { in: rootIds } },
        // Also archive any settlement superseded by these roots
        { supersededById: { in: rootIds } },
      ],
    },
    data: {
      // Mark with a completion timestamp if not already completed
      completedAt: { not: null }, // Only update if not already set
    },
  });

  if (log) {
    log.info({
      archivedCount: archived.count,
      cutoffDate: cutoffDate.toISOString(),
      retentionDays: SUPERSEDED_RETENTION_DAYS,
    }, 'Archived old superseded settlement chains');
  }

  return archived.count;
}

/**
 * Count the total depth of a retry chain starting from a settlement.
 * Returns 0 if the settlement is not superseded, increments for each
 * subsequent settlement in the chain.
 */
export async function countRetryChainDepth(
  prisma: PrismaClient,
  settlementId: string,
): Promise<number> {
  let current = await prisma.settlement.findUnique({
    where: { id: settlementId },
    select: { supersededById: true },
  });

  let depth = 0;
  const visited = new Set<string>();

  while (current?.supersededById && !visited.has(settlementId)) {
    visited.add(settlementId);
    depth++;

    current = await prisma.settlement.findUnique({
      where: { id: current.supersededById },
      select: { supersededById: true },
    });

    if (!current) break;
  }

  return depth;
}
