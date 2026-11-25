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

  // Walk retry links in one database round-trip. A chain is eligible only
  // when its terminal attempt has completed or failed; cycles are excluded.
  const chains = await prisma.$queryRaw<Array<{ id: string; root_id: string; depth: number; terminal: boolean }>>`
    WITH RECURSIVE roots AS (
      SELECT id FROM "Settlement"
      WHERE "initiatedAt" <= ${cutoffDate} AND "supersededById" IS NOT NULL
      ORDER BY "initiatedAt", id
      LIMIT ${SUPERSEDED_BATCH_SIZE}
    ), chain AS (
      SELECT s.id, s."supersededById", s.status, s.id AS root_id,
             0 AS depth, ARRAY[s.id]::text[] AS path, false AS cycle
      FROM "Settlement" s JOIN roots r ON r.id = s.id
      UNION ALL
      SELECT next.id, next."supersededById", next.status, chain.root_id,
             chain.depth + 1, chain.path || next.id,
             next.id = ANY(chain.path)
      FROM chain JOIN "Settlement" next ON next.id = chain."supersededById"
      WHERE NOT chain.cycle
    ), eligible AS (
      SELECT root_id FROM chain GROUP BY root_id
      HAVING bool_or(cycle) = false
         AND bool_or("supersededById" IS NULL AND status::text IN ('completed', 'failed'))
    )
    SELECT chain.id, chain.root_id, chain.depth,
           (chain."supersededById" IS NULL) AS terminal
    FROM chain JOIN eligible USING (root_id)
  `;

  if (chains.length === 0) return 0;
  const ids = [...new Set(chains.map((row) => row.id))];
  // Preserve original completion timestamps. The cleanup marker is applied
  // only to rows without a completedAt timestamp.
  const archived = await prisma.settlement.updateMany({
    where: { id: { in: ids }, completedAt: null },
    data: { completedAt: new Date() },
  });

  log?.info({ archivedCount: archived.count, chainCount: new Set(chains.map((row) => row.root_id)).size },
    'Archived old superseded settlement chains');
  return archived.count;
}

/** Number of retry links, with cycle protection and one DB round-trip. */
export async function countRetryChainDepth(prisma: PrismaClient, settlementId: string): Promise<number> {
  const rows = await prisma.$queryRaw<Array<{ depth: number }>>`
    WITH RECURSIVE chain AS (
      SELECT id, "supersededById", 0 AS depth, ARRAY[id]::text[] AS path
      FROM "Settlement" WHERE id = ${settlementId}
      UNION ALL
      SELECT next.id, next."supersededById", chain.depth + 1, chain.path || next.id
      FROM chain JOIN "Settlement" next ON next.id = chain."supersededById"
      WHERE NOT (next.id = ANY(chain.path))
    )
    SELECT COALESCE(MAX(depth), 0)::integer AS depth FROM chain
  `;
  return rows[0]?.depth ?? 0;
}
