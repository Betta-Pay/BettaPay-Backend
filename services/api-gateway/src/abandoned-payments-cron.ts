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
export const ABANDONED_PAYMENTS_CRON_INTERVAL_ENV =
  'ABANDONED_PAYMENTS_CRON_INTERVAL_MS';

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
  abandonmentHours: number,
  webhookQueue?: Queue<WebhookJobData>,
): Promise<number> {
  if (abandonmentHours <= 0) {
    logger.info('Payment abandonment is disabled (PAYMENT_ABANDONMENT_HOURS <= 0).');
    return 0;
  }

  const traceId = randomUUID();
  logger.info({ traceId }, 'Starting abandoned payments sweep');

  const cutoff = new Date(Date.now() - abandonmentHours * 60 * 60 * 1000);

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
        where: { id: { in: ids } },
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
  }
}

export function startAbandonedPaymentsCron(
  prisma: PrismaClient,
  logger: FastifyLoggerInstance,
  abandonmentHours: number,
  webhookQueue?: Queue<WebhookJobData>,
) {
  if (cronInterval) return;

  const envVal = process.env[ABANDONED_PAYMENTS_CRON_INTERVAL_ENV];
  const intervalMs = getAbandonedPaymentsCronIntervalMs();
  if (envVal && intervalMs === DEFAULT_ABANDONED_PAYMENTS_CRON_INTERVAL_MS) {
    logger.warn(
      { envVal },
      `Invalid ${ABANDONED_PAYMENTS_CRON_INTERVAL_ENV}; falling back to ${DEFAULT_ABANDONED_PAYMENTS_CRON_INTERVAL_MS}ms`,
    );
  }

  const runJob = () => autoExpireAbandonedPayments(prisma, logger, abandonmentHours, webhookQueue).catch(err => logger.error({ err }, 'Abandoned payments cron job failed unexpectedly.'));
  cronInterval = setInterval(runJob, intervalMs);
}

export function stopAbandonedPaymentsCron() {
  if (cronInterval) clearInterval(cronInterval);
  cronInterval = null;
}