import type { FastifyLoggerInstance } from 'fastify';
import type { Queue } from 'bullmq';
import type { PrismaClient } from '@prisma/client';

const REAP_BATCH = 200;
const REAPER_INTERVAL_MS = 5 * 60 * 1000;
const STUCK_AFTER_MS = 30 * 60 * 1000;

export async function reapStuckSettlements(
  prisma: PrismaClient,
  queue: Queue,
  stuckBefore = new Date(Date.now() - STUCK_AFTER_MS),
): Promise<number> {
  let reapedCount = 0;

  for (;;) {
    const stuck = await prisma.settlement.findMany({
      where: { status: 'processing', initiatedAt: { lt: stuckBefore } },
      select: { id: true },
      orderBy: { id: 'asc' },
      take: REAP_BATCH,
    });
    if (stuck.length === 0) break;

    for (const row of stuck) {
      await prisma.settlement.update({
        where: { id: row.id },
        data: { status: 'failed' },
      });
      await queue.add('process-settlement', { id: row.id });
      reapedCount++;
    }

    if (stuck.length < REAP_BATCH) break;
  }

  return reapedCount;
}

export function startSettlementReaper(
  prisma: PrismaClient,
  queue: Queue,
  logger: FastifyLoggerInstance,
): () => Promise<void> {
  let inFlight: Promise<void> | undefined;

  const interval = setInterval(() => {
    if (inFlight) {
      logger.warn({ intervalMs: REAPER_INTERVAL_MS }, 'Skipping settlement reaper tick while a prior run is still active');
      return;
    }

    const stuckBefore = new Date(Date.now() - STUCK_AFTER_MS);
    inFlight = reapStuckSettlements(prisma, queue, stuckBefore)
      .then((reapedCount) => {
        if (reapedCount > 0) {
          logger.info({ reapedCount, stuckBefore: stuckBefore.toISOString() }, 'Reaped stuck settlements');
        }
      })
      .catch((err) => {
        logger.error({ err }, 'Settlement reaper failed');
      })
      .finally(() => {
        inFlight = undefined;
      });
  }, REAPER_INTERVAL_MS);

  return async () => {
    clearInterval(interval);
    await inFlight;
  };
}
