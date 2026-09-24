import type { PrismaClient } from '@prisma/client';

/**
 * Issue #496: Worker crash mid-process leaves settlement in ambiguous state
 *
 * The reaper periodically scans for settlements stuck in 'processing' state
 * and either finalizes them or fails with retry. This handles the scenario where
 * a worker crashes after transitioning to 'processing' but before completion.
 *
 * Recovery strategy:
 * - If a settlement has been processing > PROCESSING_TIMEOUT_MS, consider it stuck
 * - On recovery, either mark it completed (if possible) or failed (with retry queuing)
 */

export const PROCESSING_STUCK_THRESHOLD_MS = 2 * 30_000; // 60 seconds

export async function reapStuckSettlements(
  prisma: PrismaClient,
  queue: any,
  log: any,
  thresholdMs: number = PROCESSING_STUCK_THRESHOLD_MS,
): Promise<number> {
  const now = new Date();
  const thresholdDate = new Date(now.getTime() - thresholdMs);

  // Find settlements stuck in processing
  const stuck = await prisma.settlement.findMany({
    where: {
      status: 'processing',
      initiatedAt: { lte: thresholdDate },
    },
    select: { id: true, merchantId: true, grossAmount: true, asset: true },
  });

  if (stuck.length === 0) {
    return 0;
  }

  let recovered = 0;

  for (const settlement of stuck) {
    try {
      // Try to recover by marking as failed and re-queuing
      const updated = await prisma.settlement.update({
        where: { id: settlement.id },
        data: { status: 'failed', completedAt: new Date() },
      });

      // Re-queue for retry
      if (queue) {
        await queue.add('process-settlement', {
          id: settlement.id,
          merchantId: settlement.merchantId,
          grossAmount: settlement.grossAmount,
          asset: settlement.asset,
        });
      }

      recovered++;

      if (log) {
        log.warn({
          settlementId: settlement.id,
          merchantId: settlement.merchantId,
          thresholdMs,
        }, 'Recovered stuck settlement: marked failed and re-queued');
      }
    } catch (err) {
      if (log) {
        log.error({
          err,
          settlementId: settlement.id,
          merchantId: settlement.merchantId,
        }, 'Failed to recover stuck settlement');
      }
    }
  }

  return recovered;
}

/**
 * Start the reaper daemon that periodically scans for stuck settlements.
 * Returns a function to stop the reaper.
 */
export function startSettlementReaper(
  prisma: PrismaClient,
  queue: any,
  log: any,
  intervalMs: number = 10_000,
): () => void {
  let timer: NodeJS.Timeout | undefined;

  const run = async () => {
    try {
      const recovered = await reapStuckSettlements(prisma, queue, log);
      if (recovered > 0 && log) {
        log.info({ recovered }, 'Settlement reaper cycle completed');
      }
    } catch (err) {
      if (log) {
        log.error({ err }, 'Settlement reaper cycle failed');
      }
    }
  };

  // Run once immediately
  run().catch(() => {});

  // Then run periodically
  timer = setInterval(run, intervalMs);

  return () => {
    if (timer) clearInterval(timer);
  };
}
