/**
 * idempotency-key-cleanup-cron.ts (issue #622)
 *
 * Payment.idempotencyKey and Settlement.idempotencyKey are @unique so a
 * stale row's key value permanently blocks a client from reusing that same
 * key once its 24h idempotencyKeyExpiresAt window has passed — the DB
 * uniqueness constraint doesn't know the key expired, only the application's
 * `idempotencyKeyExpiresAt: { gt: now }` lookup does. This job periodically
 * reclaims expired keys by nulling them out, freeing the value for reuse.
 */

import type { PrismaClient } from '@prisma/client';
import type { FastifyLoggerInstance } from 'fastify';

let cronInterval: NodeJS.Timeout | null = null;
let isCronRunning = false;

export interface CronOptions {
  intervalMs?: number;
  jitterMs?: number;
  redis?: any;
}

export function getCronIntervalMs(opts?: CronOptions): number {
  if (opts?.intervalMs && opts.intervalMs > 0) return opts.intervalMs;
  const envVal = process.env.IDEMPOTENCY_KEY_CLEANUP_CRON_INTERVAL_MS;
  if (envVal) {
    const parsed = parseInt(envVal, 10);
    if (!isNaN(parsed) && parsed > 0) return parsed;
  }
  return 60 * 60 * 1000;
}

/**
 * Lua script for atomic lock release — only deletes the lock if the stored
 * value matches what we wrote, preventing accidental deletion of a lock
 * acquired by another gateway instance.
 */
const RELEASE_LOCK_SCRIPT = `
  if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("del", KEYS[1])
  else
    return 0
  end
`;

/**
 * Nulls out idempotencyKey (and its expiry) on Payment and Settlement rows
 * whose idempotencyKeyExpiresAt has passed, so the @unique constraint no
 * longer blocks a client from reusing that key value.
 *
 * @returns the total number of rows reclaimed across both tables.
 */
export async function reclaimExpiredIdempotencyKeys(
  prisma: PrismaClient,
  logger: FastifyLoggerInstance,
  redis?: any,
): Promise<number> {
  if (isCronRunning) {
    logger.info('Idempotency key cleanup cron job already in progress; skipping execution.');
    return 0;
  }

  let lockAcquired = false;
  const lockKey = 'lock:idempotency-key-cleanup-cron';
  const lockVal = Math.random().toString(36).substring(2);
  const lockTtlMs = 5 * 60 * 1000;

  if (redis && typeof redis.set === 'function') {
    try {
      const res = await redis.set(lockKey, lockVal, 'PX', lockTtlMs, 'NX');
      if (res !== 'OK' && res !== true && res !== '1') {
        logger.info('Idempotency key cleanup cron lock held by another instance; skipping run.');
        return 0;
      }
      lockAcquired = true;
    } catch (err) {
      logger.warn({ err }, 'Failed to acquire Redis lock for idempotency key cleanup cron');
    }
  }

  isCronRunning = true;
  try {
    const now = new Date();
    const where = {
      idempotencyKey: { not: null },
      idempotencyKeyExpiresAt: { lt: now },
    };
    const data = { idempotencyKey: null, idempotencyKeyExpiresAt: null };

    const [payments, settlements] = await Promise.all([
      prisma.payment.updateMany({ where, data }),
      prisma.settlement.updateMany({ where, data }),
    ]);

    const total = payments.count + settlements.count;
    if (total > 0) {
      logger.info(
        { paymentsReclaimed: payments.count, settlementsReclaimed: settlements.count },
        'Reclaimed expired idempotency keys.',
      );
    }
    return total;
  } catch (error) {
    logger.error({ err: error }, 'Error during idempotency key cleanup cron job.');
    return 0;
  } finally {
    isCronRunning = false;
    if (lockAcquired && redis && typeof redis.eval === 'function') {
      await redis.eval(RELEASE_LOCK_SCRIPT, 1, lockKey, lockVal).catch(() => {});
    }
  }
}

export function startIdempotencyKeyCleanupCron(
  prisma: PrismaClient,
  logger: FastifyLoggerInstance,
  opts?: CronOptions,
) {
  if (cronInterval) return;

  const intervalMs = getCronIntervalMs(opts);

  const runJob = async () => {
    const jitter = Math.floor(Math.random() * (opts?.jitterMs ?? 1000));
    if (jitter > 0) {
      await new Promise((resolve) => setTimeout(resolve, jitter));
    }
    await reclaimExpiredIdempotencyKeys(prisma, logger, opts?.redis).catch((err) =>
      logger.error({ err }, 'Idempotency key cleanup cron job failed unexpectedly.'),
    );
  };

  cronInterval = setInterval(runJob, intervalMs);
}

export function stopIdempotencyKeyCleanupCron() {
  if (cronInterval) clearInterval(cronInterval);
  cronInterval = null;
  isCronRunning = false;
}
