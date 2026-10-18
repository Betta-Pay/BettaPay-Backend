import type { Job } from 'bullmq';

export const DOMAIN_EVENTS_QUEUE = 'domain-events';

export interface PaymentCreatedEvent {
  type: 'payment.created';
  id: string;
  merchantId?: string;
  amount?: unknown;
  asset?: string;
  traceId?: string;
  occurredAt?: string;
}

type DomainEvent = PaymentCreatedEvent | { type?: string; traceId?: string; [key: string]: unknown };

export interface MirrorDelegate {
  upsert(args: {
    where: { id: string };
    update: Record<string, unknown>;
    create: Record<string, unknown>;
  }): Promise<unknown>;
}

interface Logger {
  child(bindings: Record<string, unknown>): Logger;
  info(obj: Record<string, unknown>, msg: string): void;
  debug(obj: Record<string, unknown>, msg: string): void;
}

/**
 * Builds the processor for the `domain-events` queue (#770). Mirrors
 * payment.created events into `paymentMirror` so the event path can be
 * proven alongside reconcile polling. The mirror table is optional in this
 * phase: when the Prisma delegate is absent or the upsert fails, the job is
 * a guarded no-op and never crashes the worker. Upsert keyed on the payment
 * id makes redelivery idempotent.
 */
export function createDomainEventProcessor(
  getMirror: () => MirrorDelegate | undefined,
  log: Logger,
) {
  return async (job: Job<DomainEvent>): Promise<void> => {
    const data = job.data ?? {};
    const jobLog = log.child({ traceId: data.traceId });

    if (data.type !== 'payment.created' || typeof data.id !== 'string') return;

    const mirror = getMirror();
    if (!mirror || typeof mirror.upsert !== 'function') {
      jobLog.debug({ id: data.id }, 'paymentMirror unavailable; domain event skipped');
      return;
    }

    const { id, merchantId, amount, asset } = data as PaymentCreatedEvent;
    const fields = { merchantId, amount, asset };

    const mirrored = await mirror
      .upsert({
        where: { id },
        update: fields,
        create: { id, ...fields, status: 'initiated' },
      })
      .then(() => true)
      .catch(() => false); // table optional in this phase; never crash the worker

    if (mirrored) jobLog.info({ id }, 'Domain event mirrored');
  };
}
