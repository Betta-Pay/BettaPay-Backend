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

  const cutoff = new Date(Date.now() - abandonmentHours * 60 * 60 * 1000);

  try {
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
  }
}

export function startAbandonedPaymentsCron(
  prisma: PrismaClient,
  logger: FastifyLoggerInstance,
  abandonmentHours: number,
  webhookQueue?: Queue<WebhookJobData>,
) {
  if (cronInterval) return;

  const runJob = () => autoExpireAbandonedPayments(prisma, logger, abandonmentHours, webhookQueue).catch(err => logger.error({ err }, 'Abandoned payments cron job failed unexpectedly.'));
  cronInterval = setInterval(runJob, 60 * 60 * 1000); // Run every hour
}

export function stopAbandonedPaymentsCron() {
  if (cronInterval) clearInterval(cronInterval);
  cronInterval = null;
}