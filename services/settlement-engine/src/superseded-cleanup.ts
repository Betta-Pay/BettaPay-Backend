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

export const SUPERSEDED_RETENTION_DAYS = 7;
export const SUPERSEDED_BATCH_SIZE = 100;

export interface CleanupLogger {
  info: (obj: Record<string, unknown>, msg?: string) => void;
  warn?: (obj: Record<string, unknown>, msg?: string) => void;
  error?: (obj: Record<string, unknown>, msg?: string) => void;
}

/**
 * Mark superseded settlement chains as archived.
 * Only archives chains where:
 * 1. The root settlement (first in chain) is older than retention period
 * 2. The current settlement (last in chain) is in a terminal state
 */
export async function archiveSupersededChains(
  prisma: PrismaClient,
  log?: CleanupLogger | null
): Promise<number> {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - SUPERSEDED_RETENTION_DAYS);

  // Find root settlements that are old enough and have completed chains
  const rootsToArchive = await prisma.settlement.findMany({
    where: {
      // Settlement itself is old
      initiatedAt: { lte: cutoffDate },
      // And has actually been superseded (has a next settlement)
      supersededById: { not: null },
      // And the superseding settlement is complete/failed
      supersededBy: {
        status: { in: ['completed', 'failed'] },
      },
    },
    select: { id: true },
    take: SUPERSEDED_BATCH_SIZE,
  });

  if (rootsToArchive.length === 0) {
    return 0;
  }

  const rootIds: string[] = rootsToArchive.map((r: { id: string }) => r.id);

  // Mark all settlements in these chains as archived (soft-delete marker)
  const archived = await prisma.settlement.updateMany({
    where: {
      OR: [
        { id: { in: rootIds } },
        // Also archive any settlement superseded by these roots
        { supersededById: { in: rootIds } },
      ],
    },
    data: {
      completedAt: cutoffDate,
    },
  });

  if (log) {
    log.info(
      {
        archivedCount: archived.count,
        cutoffDate: cutoffDate.toISOString(),
        retentionDays: SUPERSEDED_RETENTION_DAYS,
      },
      'Archived old superseded settlement chains'
    );
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
  settlementId: string
): Promise<number> {
  let current: { supersededById: string | null } | null = await prisma.settlement.findUnique({
    where: { id: settlementId },
    select: { supersededById: true },
  });

  let depth = 0;
  const visited = new Set<string>();

  while (current?.supersededById && !visited.has(current.supersededById)) {
    visited.add(current.supersededById);
    depth++;

    current = await prisma.settlement.findUnique({
      where: { id: current.supersededById },
      select: { supersededById: true },
    });

    if (!current) break;
  }

  return depth;
}
