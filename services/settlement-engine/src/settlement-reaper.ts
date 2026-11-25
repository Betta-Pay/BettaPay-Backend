import type { FastifyLoggerInstance } from 'fastify';
import type { Queue } from 'bullmq';
import type { PrismaClient } from '@prisma/client';
import * as promClient from 'prom-client';

const REAP_BATCH = 200;
const REAPER_INTERVAL_MS = 5 * 60 * 1000;
const STUCK_AFTER_MS = 30 * 60 * 1000;
export const DEFAULT_MAX_REAPER_RETRIES = Number(
  process.env.SETTLEMENT_REAPER_MAX_RETRIES ??
  process.env.REAPER_MAX_RETRIES ??
  3,
);

export interface MinimalLogger {
  info?: (obj: unknown, msg?: string) => void;
  warn?: (obj: unknown, msg?: string) => void;
  error?: (obj: unknown, msg?: string) => void;
}

export interface ReaperOptions {
  maxRetries?: number;
  logger?: FastifyLoggerInstance | MinimalLogger;
  attemptsMap?: Map<string, number>;
}

// In-memory retry attempts tracker per settlement ID
const reapAttempts = new Map<string, number>();

export function resetReaperAttempts(): void {
  reapAttempts.clear();
}

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
 *
 * Settlements exceeding `maxRetries` are marked with terminal failure (status: 'failed',
 * completedAt set) without being re-enqueued.
 * If queue re-enqueue fails, the DB state is reverted to 'processing' to prevent
 * split-brain.
 */
export async function reapStuckSettlements(
  prisma: PrismaClient,
  queue: Queue,
  stuckBefore = new Date(Date.now() - STUCK_AFTER_MS),
  options?: ReaperOptions | number,
): Promise<number> {
  const opts: ReaperOptions =
    typeof options === 'number' ? { maxRetries: options } : (options ?? {});
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_REAPER_RETRIES;
  const logger = opts.logger;
  const attempts = opts.attemptsMap ?? reapAttempts;

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
      const currentAttempts = attempts.get(row.id) ?? 0;

      // When the settlement has reached or exceeded max reaper attempts,
      // transition to terminal failure with completedAt set and do not re-enqueue.
      if (currentAttempts >= maxRetries) {
        const now = new Date();
        const claimed = await prisma.settlement.updateMany({
          where: { id: row.id, status: 'processing', initiatedAt: { lt: stuckBefore } },
          data: { status: 'failed', completedAt: now },
        });
        if (claimed.count !== 1) continue; // another run already claimed it

        attempts.delete(row.id);
        logger?.warn?.(
          { settlementId: row.id, attempts: currentAttempts, maxRetries },
          'Settlement exceeded max reaper retries — marked terminal failed',
        );
        reapedCount++;
        continue;
      }

      // Claim the row for re-enqueue (without completedAt, as it is retrying)
      const claimed = await prisma.settlement.updateMany({
        where: { id: row.id, status: 'processing', initiatedAt: { lt: stuckBefore } },
        data: { status: 'failed' },
      });
      if (claimed.count !== 1) continue; // another run already reaped it

      try {
        await queue.add('process-settlement', { id: row.id });
        attempts.set(row.id, currentAttempts + 1);
        settlementReapedCounter.inc();
        reapedCount++;
      } catch (queueErr) {
        // Prevent DB/BullMQ split-brain: rollback claim back to processing
        logger?.error?.(
          { err: queueErr, settlementId: row.id },
          'Failed to re-enqueue reaped settlement in BullMQ — reverting status to processing',
        );
        try {
          await prisma.settlement.updateMany({
            where: { id: row.id, status: 'failed' },
            data: { status: 'processing' },
          });
        } catch (rollbackErr) {
          logger?.error?.(
            { err: rollbackErr, settlementId: row.id },
            'Failed to rollback settlement status after BullMQ enqueue error',
          );
        }
      }
    }

    if (stuck.length < REAP_BATCH) break;
  }

  return reapedCount;
}

export function startSettlementReaper(
  prisma: PrismaClient,
  queue: Queue,
  logger: FastifyLoggerInstance,
  options?: ReaperOptions,
): () => Promise<void> {
  let inFlight: Promise<void> | undefined;

  const interval = setInterval(() => {
    if (inFlight) {
      logger.warn({ intervalMs: REAPER_INTERVAL_MS }, 'Skipping settlement reaper tick while a prior run is still active');
      return;
    }

    const stuckBefore = new Date(Date.now() - STUCK_AFTER_MS);
    inFlight = reapStuckSettlements(prisma, queue, stuckBefore, { logger, ...options })
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
