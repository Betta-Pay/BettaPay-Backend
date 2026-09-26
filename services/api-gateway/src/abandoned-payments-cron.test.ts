import test from 'tape';
import { autoExpireAbandonedPayments } from './abandoned-payments-cron.js';

interface MockPrismaPayment {
  findMany: (args: { where: any; include: any; orderBy: any; take: number }) => Promise<any[]>;
  updateMany: (args: { where: any; data: any }) => Promise<{ count: number }>;
}

interface MockPrisma {
  payment: MockPrismaPayment;
}

interface MockLogger {
  info: (obj: any, msg?: string) => void;
  error: (obj: any, msg?: string) => void;
}

function createMockPrisma(count: number): MockPrisma {
  const payments = Array.from({ length: count }, (_, index) => ({
    id: `payment-${String(index).padStart(4, '0')}`,
    merchantId: 'merchant-1',
    amount: { toString: () => '10.00' },
    asset: 'USDC',
    merchant: null,
  }));

  return {
    payment: {
      findMany: async (args) => {
        lastFindManyArgs.push(args);
        const cursor = args.where.id?.gt;
        return payments
          .filter((payment) => !cursor || payment.id > cursor)
          .slice(0, args.take);
      },
      updateMany: async (args: { where: any; data: any }) => {
        lastUpdateManyArgs = args;
        return { count: args.where.id.in.length };
      },
    },
  };
}

function createMockLogger(): MockLogger {
  return {
    info: () => {},
    error: () => {},
  };
}

let lastUpdateManyArgs: { where: any; data: any } | null = null;
let lastFindManyArgs: Array<{ where: any; include: any; orderBy: any; take: number }> = [];

function resetMockCalls() {
  lastUpdateManyArgs = null;
  lastFindManyArgs = [];
}

test('autoExpireAbandonedPayments - expires payments older than cutoff', async (t) => {
  resetMockCalls();
  const mockPrisma = createMockPrisma(5);
  const mockLogger = createMockLogger();
  const abandonmentHours = 24;

  const count = await autoExpireAbandonedPayments(mockPrisma as any, mockLogger as any, abandonmentHours);

  t.equal(count, 5, 'should return the count of expired payments');
  t.ok(lastUpdateManyArgs, 'updateMany should have been called');
  t.equal(lastUpdateManyArgs?.where.id.in.length, 5, 'updateMany should target the fetched page');
  t.equal(lastFindManyArgs[0].where.status, 'initiated', 'should only fetch initiated payments');
  t.ok(lastFindManyArgs[0].where.createdAt.lt instanceof Date, 'createdAt filter should be a Date');
  t.equal(lastUpdateManyArgs?.data.status, 'cancelled', 'should set status to cancelled');
  t.equal(lastFindManyArgs[0].take, 200, 'should fetch one bounded page');
  t.equal(lastFindManyArgs[0].orderBy.id, 'asc', 'should order pages by id');

  const now = Date.now();
  const expectedCutoff = now - abandonmentHours * 60 * 60 * 1000;
  const actualCutoff = lastFindManyArgs[0].where.createdAt.lt.getTime();

  // Allow a small delta for test execution time
  t.ok(Math.abs(expectedCutoff - actualCutoff) < 1000, 'cutoff time should be approximately correct');

  t.end();
});

test('autoExpireAbandonedPayments - drains stale payments in pages of 200', async (t) => {
  resetMockCalls();
  const mockPrisma = createMockPrisma(405);
  const mockLogger = createMockLogger();

  const count = await autoExpireAbandonedPayments(mockPrisma as any, mockLogger as any, 24);

  t.equal(count, 405, 'should return the total count across pages');
  t.equal(lastFindManyArgs.length, 3, 'should fetch two full pages and one remainder');
  t.deepEqual(lastFindManyArgs.map((args) => args.take), [200, 200, 200]);
  t.notOk(lastFindManyArgs[0].where.id, 'first page should not have a cursor');
  t.equal(lastFindManyArgs[1].where.id.gt, 'payment-0199', 'second page should continue after the first page');
  t.equal(lastFindManyArgs[2].where.id.gt, 'payment-0399', 'third page should continue after the second page');
  t.end();
});

test('autoExpireAbandonedPayments - does nothing if abandonment is disabled', async (t) => {
  resetMockCalls();
  const mockPrisma = createMockPrisma(0);
  const mockLogger = createMockLogger();

  const count = await autoExpireAbandonedPayments(mockPrisma as any, mockLogger as any, 0);

  t.equal(count, 0, 'should return 0');
  t.equal(lastUpdateManyArgs, null, 'updateMany should not be called');

  t.end();
});

test('autoExpireAbandonedPayments - handles zero expired payments', async (t) => {
  resetMockCalls();
  const mockPrisma = createMockPrisma(0);
  const mockLogger = createMockLogger();

  const count = await autoExpireAbandonedPayments(mockPrisma as any, mockLogger as any, 24);

  t.equal(count, 0, 'should return 0');
  t.equal(lastUpdateManyArgs, null, 'updateMany should not be called when no payments are found');

  t.end();
});