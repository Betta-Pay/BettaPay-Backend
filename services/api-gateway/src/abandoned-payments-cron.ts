/**
 * abandoned-payments-cron.ts
 *
 * A cron job to automatically expire abandoned payments.
 */

import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type { FastifyLoggerInstance } from 'fastify';
import type { Queue } from 'bullmq';
import type { WebhookJobData } from '@bettapay/webhook-delivery';

let cronInterval: NodeJS.Timeout | null = null;
const CRON_BATCH = 200;

export const DEFAULT_ABANDONED_PAYMENTS_CRON_INTERVAL_MS = 60 * 60 * 1000;
export const DEFAULT_PAYMENT_ABANDONMENT_HOURS = 24;
export const ABANDONED_PAYMENTS_CRON_INTERVAL_ENV =
  'ABANDONED_PAYMENTS_CRON_INTERVAL_MS';

/**
 * Lua script for atomic lock release — only deletes the lock if the stored
 * value matches what we wrote, preventing accidental deletion of a lock
 * acquired by another gateway instance.
 */
export const RELEASE_LOCK_SCRIPT = `
  if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("del", KEYS[1])
  else
    return 0
  end
`;

/**
 * Resolves the sweep interval in milliseconds.
 *
 * `ABANDONED_PAYMENTS_CRON_INTERVAL_MS` overrides the default; a missing or
 * invalid value falls back to one hour rather than throwing.
 */
export function getAbandonedPaymentsCronIntervalMs(): number {
  const envVal = process.env[ABANDONED_PAYMENTS_CRON_INTERVAL_ENV];
  if (envVal) {
    const parsed = parseInt(envVal, 10);
    if (!isNaN(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_ABANDONED_PAYMENTS_CRON_INTERVAL_MS;
}

/**
 * Finds payments in 'initiated' status older than the configured timeout
 * and transitions them to 'cancelled'.
 *
 * @param prisma - The Prisma client instance.
 * @param logger - The Fastify logger instance.
 * @param abandonmentHours - The number of hours after which a payment is considered abandoned.
 * @param webhookQueue - Optional BullMQ queue for dispatching webhook notifications.
 * @returns The number of payments that were cancelled.
 */
export async function autoExpireAbandonedPayments(
  prisma: PrismaClient,
  logger: FastifyLoggerInstance,
  abandonmentHours: number = DEFAULT_PAYMENT_ABANDONMENT_HOURS,
  webhookQueue?: Queue<WebhookJobData>,
  redis?: any,
): Promise<number> {
  let safeHours = abandonmentHours;
  if (!Number.isFinite(safeHours)) {
    logger.warn?.({ abandonmentHours }, `Invalid abandonmentHours; falling back to ${DEFAULT_PAYMENT_ABANDONMENT_HOURS}`);
    safeHours = DEFAULT_PAYMENT_ABANDONMENT_HOURS;
  }

  if (safeHours <= 0) {
    logger.info('Payment abandonment is disabled (PAYMENT_ABANDONMENT_HOURS <= 0).');
    return 0;
  }

  let lockAcquired = false;
  const lockKey = 'lock:auto-expire-abandoned-payments';
  const lockVal = randomUUID();
  const lockTtlMs = 5 * 60 * 1000;

  if (redis && typeof redis.set === 'function') {
    try {
      const res = await redis.set(lockKey, lockVal, 'PX', lockTtlMs, 'NX');
      if (res !== 'OK' && res !== true && res !== '1') {
        logger.info('Abandoned payments cron lock held by another instance; skipping run.');
        return 0;
      }
      lockAcquired = true;
    } catch (err) {
      logger.warn?.({ err }, 'Failed to acquire Redis lock for abandoned payments cron');
      return 0;
    }
  }

  const traceId = randomUUID();
  logger.info({ traceId }, 'Starting abandoned payments sweep');

  const cutoff = new Date(Date.now() - safeHours * 60 * 60 * 1000);

  try {
    let cursor: string | undefined;
    let expiredCount = 0;
    let foundPayments = false;

    for (;;) {
      const stalePayments = await prisma.payment.findMany({
        where: {
          status: 'initiated',
          createdAt: { lt: cutoff },
          ...(cursor ? { id: { gt: cursor } } : {}),
        },
        include: { merchant: true },
        orderBy: { id: 'asc' },
        take: CRON_BATCH,
      });

      if (stalePayments.length === 0) break;
      foundPayments = true;

      const ids = stalePayments.map((p) => p.id);
      const result = await prisma.payment.updateMany({
        where: {
          id: { in: ids },
          status: 'initiated',
        },
        data: { status: 'cancelled' },
      });
      expiredCount += result.count;

      // Dispatch webhooks for cancelled payments with a merchant webhook URL.
      // Single Redis round trip per batch via addBulk; delivery payloads are
      // identical to the previous per-payment adds. Best-effort: one bad
      // payload never blocks the rest, and an enqueue failure never blocks
      // expiry.
      if (webhookQueue) {
        const webhookJobs: Array<{ name: string; data: WebhookJobData }> = [];
        for (const payment of stalePayments) {
          try {
            const settings = payment.merchant?.settings as { webhookUrl?: string } | null | undefined;
            const webhookUrl = settings?.webhookUrl;
            if (!webhookUrl) continue;

            webhookJobs.push({
              name: 'deliver',
              data: {
                url: webhookUrl,
                traceId,
                event: {
                  type: 'payment.expired',
                  paymentId: payment.id,
                  merchantId: payment.merchantId,
                  amount: payment.amount.toString(),
                  asset: payment.asset,
                  reason: 'expired',
                },
              },
            });
          } catch (err) {
            logger.warn({ err, paymentId: payment.id }, 'Failed to build webhook job for expired payment');
          }
        }

        if (webhookJobs.length > 0) {
          try {
            await webhookQueue.addBulk(webhookJobs);
          } catch (err) {
            logger.warn({ err, count: webhookJobs.length }, 'Failed to enqueue webhooks for expired payments');
          }
        }
      }

      cursor = stalePayments[stalePayments.length - 1].id;
      if (stalePayments.length < CRON_BATCH) break;
    }

    if (!foundPayments) return 0;

    logger.info({ traceId, expiredCount, cutoff: cutoff.toISOString() }, 'Auto-expired abandoned payments.');
    return expiredCount;
  } catch (error) {
    logger.error({ traceId, err: error }, 'Error during abandoned payment expiration cron job.');
    return 0;
  } finally {
    if (lockAcquired && redis && typeof redis.eval === 'function') {
      await redis.eval(RELEASE_LOCK_SCRIPT, 1, lockKey, lockVal).catch(() => {});
    }
  }
}

export function startAbandonedPaymentsCron(
  prisma: PrismaClient,
  logger: FastifyLoggerInstance,
  abandonmentHours: number = DEFAULT_PAYMENT_ABANDONMENT_HOURS,
  webhookQueue?: Queue<WebhookJobData>,
  redis?: any,
) {
  if (cronInterval) return;

  const validHours = Number.isFinite(abandonmentHours)
    ? abandonmentHours
    : DEFAULT_PAYMENT_ABANDONMENT_HOURS;

  const envVal = process.env[ABANDONED_PAYMENTS_CRON_INTERVAL_ENV];
  const intervalMs = getAbandonedPaymentsCronIntervalMs();
  if (envVal && intervalMs === DEFAULT_ABANDONED_PAYMENTS_CRON_INTERVAL_MS) {
    logger.warn(
      { envVal },
      `Invalid ${ABANDONED_PAYMENTS_CRON_INTERVAL_ENV}; falling back to ${DEFAULT_ABANDONED_PAYMENTS_CRON_INTERVAL_MS}ms`,
    );
  }

  const runJob = () => autoExpireAbandonedPayments(prisma, logger, validHours, webhookQueue, redis).catch(err => logger.error({ err }, 'Abandoned payments cron job failed unexpectedly.'));
  cronInterval = setInterval(runJob, intervalMs);
}

export function stopAbandonedPaymentsCron() {
  if (cronInterval) clearInterval(cronInterval);
  cronInterval = null;
}