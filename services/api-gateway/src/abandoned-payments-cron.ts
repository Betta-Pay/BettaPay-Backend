/**
 * abandoned-payments-cron.ts
 *
 * A cron job to automatically expire abandoned payments.
 */

import type { PrismaClient } from '@prisma/client';
import type { FastifyLoggerInstance } from 'fastify';
import type { Queue } from 'bullmq';
import type { WebhookJobData } from '@bettapay/webhook-delivery';

let cronInterval: NodeJS.Timeout | null = null;
let isCronRunning = false;

export interface CronOptions {
  intervalMs?: number;
  jitterMs?: number;
  redis?: any;
}

export function getCronIntervalMs(opts?: CronOptions): number {
  if (opts?.intervalMs && opts.intervalMs > 0) return opts.intervalMs;
  const envVal = process.env.ABANDONED_PAYMENTS_CRON_INTERVAL_MS;
  if (envVal) {
    const parsed = parseInt(envVal, 10);
    if (!isNaN(parsed) && parsed > 0) return parsed;
  }
  return 60 * 60 * 1000;
}

/**
 * Finds payments in 'initiated' status older than the configured timeout
 * and transitions them to 'cancelled'.
 *
 * @param prisma - The Prisma client instance.
 * @param logger - The Fastify logger instance.
 * @param abandonmentHours - The number of hours after which a payment is considered abandoned.
 * @param webhookQueue - Optional BullMQ queue for dispatching webhook notifications.
 * @param redis - Optional Redis client for distributed locking across gateway instances.
 * @returns The number of payments that were cancelled.
 */
/**
 * Lua script for atomic lock release.
 * Only deletes the lock if the stored value matches what we wrote,
 * preventing accidental deletion of a lock acquired by another instance.
 */
const RELEASE_LOCK_SCRIPT = `
  if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("del", KEYS[1])
  else
    return 0
  end
`;

export async function autoExpireAbandonedPayments(
  prisma: PrismaClient,
  logger: FastifyLoggerInstance,
  abandonmentHours: number,
  webhookQueue?: Queue<WebhookJobData>,
  redis?: any,
): Promise<number> {
  if (abandonmentHours <= 0) {
    logger.info('Payment abandonment is disabled (PAYMENT_ABANDONMENT_HOURS <= 0).');
    return 0;
  }

  if (isCronRunning) {
    logger.info('Abandoned payments cron job already in progress; skipping execution.');
    return 0;
  }

  let lockAcquired = false;
  const lockKey = 'lock:abandoned-payments-cron';
  const lockVal = Math.random().toString(36).substring(2);
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
      logger.warn({ err }, 'Failed to acquire Redis lock for abandoned payments cron');
    }
  }

  isCronRunning = true;
  try {
    const cutoff = new Date(Date.now() - abandonmentHours * 60 * 60 * 1000);

    // Fetch payments to be cancelled so we can dispatch per-payment webhooks
    const stalePayments = await prisma.payment.findMany({
      where: {
        status: 'initiated',
        createdAt: { lt: cutoff },
      },
      include: { merchant: true },
    });

    if (stalePayments.length === 0) return 0;

    const ids = stalePayments.map((p) => p.id);
    const { count } = await prisma.payment.updateMany({
      where: { id: { in: ids } },
      data: { status: 'cancelled' },
    });

    logger.info({ expiredCount: count, cutoff: cutoff.toISOString() }, 'Auto-expired abandoned payments.');

    // Dispatch webhook for each cancelled payment if merchant has a webhook URL
    if (webhookQueue) {
      for (const payment of stalePayments) {
        const settings = payment.merchant?.settings as { webhookUrl?: string } | null | undefined;
        const webhookUrl = settings?.webhookUrl;
        if (!webhookUrl) continue;

        try {
          const eventId = `payment:${payment.id}:expired`;
          await webhookQueue.add('deliver', {
            eventId,
            url: webhookUrl,
            event: {
              eventId,
              type: 'payment.expired',
              paymentId: payment.id,
              merchantId: payment.merchantId,
              amount: payment.amount.toString(),
              asset: payment.asset,
              reason: 'expired',
            },
          });
        } catch (err) {
          logger.warn({ err, paymentId: payment.id }, 'Failed to enqueue webhook for expired payment');
        }
      }
    }

    return count;
  } catch (error) {
    logger.error({ err: error }, 'Error during abandoned payment expiration cron job.');
    return 0;
  } finally {
    isCronRunning = false;
    if (lockAcquired && redis && typeof redis.eval === 'function') {
      await redis.eval(RELEASE_LOCK_SCRIPT, 1, lockKey, lockVal).catch(() => {});
    }
  }
}

export function startAbandonedPaymentsCron(
  prisma: PrismaClient,
  logger: FastifyLoggerInstance,
  abandonmentHours: number,
  webhookQueue?: Queue<WebhookJobData>,
  opts?: CronOptions,
) {
  if (cronInterval) return;

  const intervalMs = getCronIntervalMs(opts);

  const runJob = async () => {
    const jitter = Math.floor(Math.random() * (opts?.jitterMs ?? 1000));
    if (jitter > 0) {
      await new Promise((resolve) => setTimeout(resolve, jitter));
    }
    await autoExpireAbandonedPayments(prisma, logger, abandonmentHours, webhookQueue, opts?.redis).catch(err =>
      logger.error({ err }, 'Abandoned payments cron job failed unexpectedly.'),
    );
  };

  cronInterval = setInterval(runJob, intervalMs);
}

export function stopAbandonedPaymentsCron() {
  if (cronInterval) clearInterval(cronInterval);
  cronInterval = null;
  isCronRunning = false;
}