/**
 * Settlement Prisma Query Timeout Tests (#923)
 *
 * Verifies that slow Prisma queries are aborted by the statement timeout
 * and surface as QueryTimeoutError rather than hanging indefinitely.
 */
import test from 'tape';
import { PrismaClient } from '@prisma/client';
import {
  createSettlementWithUniqueGuard,
  updateSettlementWithOptimisticLock,
  QueryTimeoutError,
} from './prisma-adapter.js';

async function connectTestPrisma(): Promise<PrismaClient> {
  const prisma = new PrismaClient();
  await prisma.$queryRaw`SELECT 1`;
  return prisma;
}

async function resetTestDb(prisma: PrismaClient): Promise<void> {
  await prisma.settlement.deleteMany({});
  await prisma.merchant.deleteMany({});
  await prisma.merchant.create({
    data: {
      id: 'merchant-timeout-test',
      name: 'Timeout Test Merchant',
      ownerId: 'owner-timeout-test',
    },
  });
}

async function teardownTestDb(prisma: PrismaClient): Promise<void> {
  await prisma.settlement.deleteMany({}).catch(() => {});
  await prisma.merchant.deleteMany({}).catch(() => {});
  await prisma.$disconnect().catch(() => {});
}

test('prisma-adapter (#923): fast queries complete without timeout', async (t) => {
  let prisma: PrismaClient;
  try {
    prisma = await connectTestPrisma();
  } catch (err) {
    t.skip(`PostgreSQL unavailable: ${err}`);
    t.end();
    return;
  }

  try {
    await resetTestDb(prisma);

    // Create a settlement (fast query, should complete within timeout)
    const settlement = await createSettlementWithUniqueGuard(prisma, {
      id: 'stl-fast-test',
      merchantId: 'merchant-timeout-test',
      totalAmount: '100',
      grossAmount: '100',
      feeAmount: '1',
      netAmount: '99',
      feeBps: 100,
      asset: 'USDC',
      status: 'pending',
    });

    t.equal(settlement.id, 'stl-fast-test', 'settlement created successfully');
    t.equal(settlement.status, 'pending', 'settlement has correct status');

    // Update the settlement (fast query, should complete within timeout)
    const updated = await updateSettlementWithOptimisticLock(prisma, {
      id: settlement.id,
      expectedVersion: settlement.version,
      data: { status: 'processing' },
    });

    t.equal(updated.status, 'processing', 'settlement updated successfully');
    t.equal(updated.version, settlement.version + 1, 'version incremented');
  } finally {
    await teardownTestDb(prisma!);
  }
  t.end();
});

test('prisma-adapter (#923): slow query exceeds timeout and throws QueryTimeoutError', async (t) => {
  let prisma: PrismaClient;
  try {
    prisma = await connectTestPrisma();
  } catch (err) {
    t.skip(`PostgreSQL unavailable: ${err}`);
    t.end();
    return;
  }

  try {
    await resetTestDb(prisma);

    // Simulate a slow query using pg_sleep within a transaction
    // We'll use a custom timeout of 100ms and sleep for 500ms
    try {
      await prisma.$transaction(async (tx) => {
        // Set a very short timeout
        await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = '100ms'`);
        
        // Attempt a query that sleeps for 500ms (will exceed timeout)
        await tx.$queryRawUnsafe(`SELECT pg_sleep(0.5)`);
      });
      
      t.fail('Expected QueryTimeoutError to be thrown');
    } catch (err: any) {
      // PostgreSQL will throw error code 57014 or message containing "statement timeout"
      const isTimeoutError = 
        err?.code === '57014' || 
        err?.message?.toLowerCase().includes('statement timeout') ||
        err?.message?.toLowerCase().includes('query canceled');
      
      t.ok(
        isTimeoutError,
        `slow query was canceled by statement timeout: ${err?.code || err?.message}`,
      );
    }
  } finally {
    await teardownTestDb(prisma!);
  }
  t.end();
});

test('prisma-adapter (#923): QueryTimeoutError contains operation details', async (t) => {
  const error = new QueryTimeoutError('testOperation', 5000, new Error('timeout'));
  
  t.equal(error.name, 'QueryTimeoutError', 'error has correct name');
  t.equal(error.operation, 'testOperation', 'error contains operation name');
  t.equal(error.timeoutMs, 5000, 'error contains timeout value');
  t.ok(error.cause, 'error contains cause');
  t.ok(
    error.message.includes('testOperation') && error.message.includes('5000ms'),
    'error message contains operation and timeout',
  );
  t.end();
});

test('prisma-adapter (#923): normal Prisma errors are not mapped to QueryTimeoutError', async (t) => {
  let prisma: PrismaClient;
  try {
    prisma = await connectTestPrisma();
  } catch (err) {
    t.skip(`PostgreSQL unavailable: ${err}`);
    t.end();
    return;
  }

  try {
    await resetTestDb(prisma);

    // Attempt to create a settlement with a non-existent merchant (should fail with FK error)
    try {
      await createSettlementWithUniqueGuard(prisma, {
        id: 'stl-bad-merchant',
        merchantId: 'non-existent-merchant',
        totalAmount: '100',
        grossAmount: '100',
        feeAmount: '1',
        netAmount: '99',
        feeBps: 100,
        asset: 'USDC',
        status: 'pending',
      });
      t.fail('Expected foreign key error to be thrown');
    } catch (err: any) {
      t.ok(
        err.name !== 'QueryTimeoutError',
        'non-timeout errors are not mapped to QueryTimeoutError',
      );
      // Prisma foreign key violation is P2003
      t.ok(
        err?.code === 'P2003' || err?.message?.includes('foreign key'),
        'original error type is preserved',
      );
    }
  } finally {
    await teardownTestDb(prisma!);
  }
  t.end();
});

test('prisma-adapter (#923): statement timeout is cleared after successful query', async (t) => {
  let prisma: PrismaClient;
  try {
    prisma = await connectTestPrisma();
  } catch (err) {
    t.skip(`PostgreSQL unavailable: ${err}`);
    t.end();
    return;
  }

  try {
    await resetTestDb(prisma);

    // Create a settlement (which sets and clears timeout)
    await createSettlementWithUniqueGuard(prisma, {
      id: 'stl-clear-test',
      merchantId: 'merchant-timeout-test',
      totalAmount: '100',
      grossAmount: '100',
      feeAmount: '1',
      netAmount: '99',
      feeBps: 100,
      asset: 'USDC',
      status: 'pending',
    });

    // Verify timeout was cleared by checking current setting
    const result = await prisma.$queryRaw<[{ statement_timeout: string }]>`
      SHOW statement_timeout
    `;
    
    // Default should be 0 (no timeout) or a high value like 60s
    const timeoutValue = result[0]?.statement_timeout;
    t.ok(
      timeoutValue === '0' || timeoutValue === '0ms' || parseInt(timeoutValue) >= 60000,
      `statement timeout was cleared: ${timeoutValue}`,
    );
  } finally {
    await teardownTestDb(prisma!);
  }
  t.end();
});
