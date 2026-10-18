import type { FastifyLoggerInstance } from 'fastify';
import type { Queue } from 'bullmq';
import type { PrismaClient } from '@prisma/client';
import * as promClient from 'prom-client';

const REAP_BATCH = 200;
const REAPER_INTERVAL_MS = 5 * 60 * 1000;
const STUCK_AFTER_MS = 30 * 60 * 1000;

export const settlementReapedCounter: promClient.Counter<string> =
  (promClient.register.getSingleMetric('settlement_reaped_total') as
    | promClient.Counter<string>
    | undefined) ??
  new promClient.Counter({
    name: 'settlement_reaped_total',
    help: 'Total number of stuck settlements reaped and re-enqueued',
  });

/**
 * Fails and re-enqueues settlements stuck in `processing` past `stuckBefore`.
 *
 * Idempotent and safe under overlapping runs: each row is claimed with a
 * conditional `processing -> failed` update, and only the run whose update
 * actually changed the row enqueues the job and bumps the metric.
 */
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
      const claimed = await prisma.settlement.updateMany({
        where: { id: row.id, status: 'processing', initiatedAt: { lt: stuckBefore } },
        data: { status: 'failed' },
      });
      if (claimed.count !== 1) continue; // another run already reaped it

      await queue.add('process-settlement', { id: row.id });
      settlementReapedCounter.inc();
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
