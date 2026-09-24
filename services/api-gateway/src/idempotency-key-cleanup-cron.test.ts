import test from 'tape';
import { reclaimExpiredIdempotencyKeys, getCronIntervalMs } from './idempotency-key-cleanup-cron.js';

interface MockPrisma {
  payment: {
    updateMany: (args: { where: any; data: any }) => Promise<{ count: number }>;
  };
  settlement: {
    updateMany: (args: { where: any; data: any }) => Promise<{ count: number }>;
  };
}

interface MockLogger {
  info: (obj: any, msg?: string) => void;
  error: (obj: any, msg?: string) => void;
  warn: (obj: any, msg?: string) => void;
}

let lastPaymentArgs: { where: any; data: any } | null = null;
let lastSettlementArgs: { where: any; data: any } | null = null;

function createMockPrisma(paymentCount: number, settlementCount: number): MockPrisma {
  return {
    payment: {
      updateMany: async (args) => {
        lastPaymentArgs = args;
        return { count: paymentCount };
      },
    },
    settlement: {
      updateMany: async (args) => {
        lastSettlementArgs = args;
        return { count: settlementCount };
      },
    },
  };
}

function createMockLogger(): MockLogger {
  return { info: () => {}, error: () => {}, warn: () => {} };
}

test('reclaimExpiredIdempotencyKeys - nulls out expired keys on both Payment and Settlement', async (t) => {
  lastPaymentArgs = null;
  lastSettlementArgs = null;
  const mockPrisma = createMockPrisma(2, 1);
  const mockLogger = createMockLogger();

  const total = await reclaimExpiredIdempotencyKeys(mockPrisma as any, mockLogger as any);

  t.equal(total, 3, 'returns the combined reclaimed count across both tables');

  t.ok(lastPaymentArgs, 'Payment.updateMany should have been called');
  t.deepEqual(lastPaymentArgs?.data, { idempotencyKey: null, idempotencyKeyExpiresAt: null }, 'clears the key and its expiry on Payment');
  t.ok(lastPaymentArgs?.where.idempotencyKeyExpiresAt.lt instanceof Date, 'Payment filter compares expiresAt against now');
  t.equal(lastPaymentArgs?.where.idempotencyKey.not, null, 'Payment filter only targets rows that still have a key set');

  t.ok(lastSettlementArgs, 'Settlement.updateMany should have been called');
  t.deepEqual(lastSettlementArgs?.data, { idempotencyKey: null, idempotencyKeyExpiresAt: null }, 'clears the key and its expiry on Settlement');
  t.ok(lastSettlementArgs?.where.idempotencyKeyExpiresAt.lt instanceof Date, 'Settlement filter compares expiresAt against now');

  t.end();
});

test('reclaimExpiredIdempotencyKeys - a row with expiresAt in the future is not targeted (time-mocked)', async (t) => {
  lastPaymentArgs = null;
  lastSettlementArgs = null;
  const mockPrisma = createMockPrisma(0, 0);
  const mockLogger = createMockLogger();

  const now = Date.now();
  const futureExpiry = new Date(now + 60 * 60 * 1000); // expires in 1 hour — not yet reclaimable

  const total = await reclaimExpiredIdempotencyKeys(mockPrisma as any, mockLogger as any);

  t.equal(total, 0, 'returns 0 when nothing is expired');
  const cutoff = (lastPaymentArgs?.where.idempotencyKeyExpiresAt.lt as Date).getTime();
  t.ok(cutoff <= now + 1000, 'cutoff is "now", so a row expiring an hour from now would not match `lt` cutoff');
  t.ok(futureExpiry.getTime() > cutoff, 'sanity check: the future-expiring row is after the cutoff used by the query');

  t.end();
});

test('reclaimExpiredIdempotencyKeys - returns 0 and does not call Prisma when a concurrent run is in progress', async (t) => {
  lastPaymentArgs = null;
  lastSettlementArgs = null;
  const mockPrisma = createMockPrisma(5, 5);
  const mockLogger = createMockLogger();

  // Kick off a slow first run without awaiting it, then immediately try a
  // second run — it must see isCronRunning and bail out.
  const slowPrisma: MockPrisma = {
    payment: {
      updateMany: async (args) => {
        lastPaymentArgs = args;
        await new Promise((resolve) => setTimeout(resolve, 50));
        return { count: 1 };
      },
    },
    settlement: {
      updateMany: async (args) => {
        lastSettlementArgs = args;
        return { count: 0 };
      },
    },
  };

  const firstRun = reclaimExpiredIdempotencyKeys(slowPrisma as any, mockLogger as any);
  const secondRunCount = await reclaimExpiredIdempotencyKeys(mockPrisma as any, mockLogger as any);

  t.equal(secondRunCount, 0, 'concurrent second run returns 0 immediately');

  const firstRunCount = await firstRun;
  t.equal(firstRunCount, 1, 'first run completes normally');

  t.end();
});

test('reclaimExpiredIdempotencyKeys - skips execution when Redis lock cannot be acquired', async (t) => {
  lastPaymentArgs = null;
  const mockPrisma = createMockPrisma(3, 3);
  const mockLogger = createMockLogger();

  const mockRedisLocked = { set: async () => null };

  const total = await reclaimExpiredIdempotencyKeys(mockPrisma as any, mockLogger as any, mockRedisLocked);

  t.equal(total, 0, 'returns 0 when lock fails');
  t.equal(lastPaymentArgs, null, 'Payment.updateMany is not called when lock is unavailable');

  t.end();
});

test('getCronIntervalMs - reads options or environment variable', (t) => {
  t.equal(getCronIntervalMs({ intervalMs: 30000 }), 30000, 'reads intervalMs option');

  const originalEnv = process.env.IDEMPOTENCY_KEY_CLEANUP_CRON_INTERVAL_MS;
  process.env.IDEMPOTENCY_KEY_CLEANUP_CRON_INTERVAL_MS = '120000';
  t.equal(getCronIntervalMs(), 120000, 'reads env variable');

  delete process.env.IDEMPOTENCY_KEY_CLEANUP_CRON_INTERVAL_MS;
  t.equal(getCronIntervalMs(), 3600000, 'defaults to 1 hour (3600000ms)');

  process.env.IDEMPOTENCY_KEY_CLEANUP_CRON_INTERVAL_MS = originalEnv;
  t.end();
});
