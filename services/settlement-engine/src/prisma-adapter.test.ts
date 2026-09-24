/**
 * Verifies that the settlement engine uses the pg.Pool + PrismaPg adapter
 * pattern, matching the api-gateway/indexer setup (issue #253).
 *
 * These tests parse the source file as text so they require no database
 * connection and run in CI without any external dependencies.
 */
import test from 'tape';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const indexPath = path.resolve(__dirname, './index.ts');
const content = fs.readFileSync(indexPath, 'utf-8');

// ── Imports ──────────────────────────────────────────────────────────────────

test('settlement-engine imports pg as a default import', (t) => {
  t.match(
    content,
    /import\s+pg\s+from\s+['"]pg['"]/,
    'index.ts should import pg as default from "pg"',
  );
  t.end();
});

test('settlement-engine imports PrismaPg from @prisma/adapter-pg', (t) => {
  t.match(
    content,
    /import\s+\{[^}]*PrismaPg[^}]*\}\s+from\s+['"]@prisma\/adapter-pg['"]/,
    'index.ts should import PrismaPg from @prisma/adapter-pg',
  );
  t.end();
});

// ── Pool construction ─────────────────────────────────────────────────────────

test('settlement-engine creates a pg.Pool with connectionString from buildPrismaConnectionUrl', (t) => {
  t.match(
    content,
    /new\s+pg\.Pool\s*\(/,
    'index.ts should construct a pg.Pool instance',
  );
  t.match(
    content,
    /connectionString:\s*buildPrismaConnectionUrl\(/,
    'pg.Pool connectionString should be built with buildPrismaConnectionUrl',
  );
  t.end();
});

test('settlement-engine configures pool max from DATABASE_POOL_SIZE', (t) => {
  t.match(
    content,
    /max:\s*env\.DATABASE_POOL_SIZE/,
    'pg.Pool max should come from env.DATABASE_POOL_SIZE',
  );
  t.end();
});

test('settlement-engine configures pool connectionTimeoutMillis from DATABASE_POOL_TIMEOUT', (t) => {
  t.match(
    content,
    /connectionTimeoutMillis:\s*env\.DATABASE_POOL_TIMEOUT\s*\*\s*1000/,
    'pg.Pool connectionTimeoutMillis should derive from env.DATABASE_POOL_TIMEOUT',
  );
  t.end();
});

// ── Adapter & PrismaClient ────────────────────────────────────────────────────

test('settlement-engine wraps pool in a PrismaPg adapter', (t) => {
  t.match(
    content,
    /new\s+PrismaPg\s*\(\s*pool\s*\)/,
    'index.ts should pass pool to PrismaPg constructor',
  );
  t.end();
});

test('settlement-engine passes adapter to PrismaClient', (t) => {
  t.match(
    content,
    /new\s+PrismaClient\s*\(\s*\{[^}]*adapter[^}]*\}\s*\)/s,
    'PrismaClient should be constructed with the adapter option',
  );
  t.end();
});

// ── Side-effect removal ───────────────────────────────────────────────────────

test('settlement-engine does NOT assign process.env.DATABASE_URL as a side-effect', (t) => {
  const hasSideEffect = /process\.env\.DATABASE_URL\s*=/.test(content);
  t.ok(!hasSideEffect, 'index.ts must not mutate process.env.DATABASE_URL');
  t.end();
});

// ── Prisma adapter concurrency helpers (#543) ────────────────────────────────
// These tests parse the adapter source as text and exercise it with an
// in-memory mock so they require no database connection.

const adapterPath = path.resolve(__dirname, './prisma-adapter.ts');
const adapterContent = fs.readFileSync(adapterPath, 'utf-8');

test('prisma-adapter exists and avoids upsert', (t) => {
  t.ok(fs.existsSync(adapterPath), 'prisma-adapter.ts should exist');
  t.ok(
    !/\.upsert\s*\(/.test(adapterContent),
    'adapter must not use Prisma upsert (create + unique-constraint handling instead)',
  );
  t.match(
    adapterContent,
    /export\s+async\s+function\s+createSettlementWithUniqueGuard/,
    'adapter should export createSettlementWithUniqueGuard',
  );
  t.match(
    adapterContent,
    /export\s+async\s+function\s+updateSettlementWithOptimisticLock/,
    'adapter should export updateSettlementWithOptimisticLock',
  );
  t.match(
    adapterContent,
    /export\s+class\s+VersionConflictError/,
    'adapter should export VersionConflictError',
  );
  t.end();
});

test('prisma-adapter index.ts imports the adapter helpers', (t) => {
  t.match(
    content,
    /from\s+['"]\.\/prisma-adapter\.js['"]/,
    'index.ts should import from prisma-adapter.js',
  );
  t.match(
    content,
    /createSettlementWithUniqueGuard/,
    'index.ts should reference createSettlementWithUniqueGuard',
  );
  t.match(
    content,
    /updateSettlementWithOptimisticLock/,
    'index.ts should reference updateSettlementWithOptimisticLock',
  );
  t.end();
});

// ── Transaction isolation tests ───────────────────────────────────────────────
// Issue #497: Prisma adapter transaction isolation (DB-backed).
//
// Written in tape (the repo standard — vitest is not a dependency).
// These need a live PostgreSQL with the schema pushed; they SKIP cleanly when
// it is unavailable, exactly like the payment-to-settlement integration test.

import { PrismaClient } from '@prisma/client';
import {
  createSettlementWithUniqueGuard,
  updateSettlementWithOptimisticLock,
  VersionConflictError,
  UniqueConstraintError,
} from './prisma-adapter.js';

async function connectTxPrisma(): Promise<PrismaClient> {
  const prisma = new PrismaClient();
  await prisma.$queryRaw`SELECT 1`;
  return prisma;
}

async function resetTxDb(prisma: PrismaClient): Promise<void> {
  await prisma.settlement.deleteMany({});
  await prisma.merchant.deleteMany({});
  await prisma.merchant.create({
    data: {
      id: 'merchant-tx-test',
      name: 'Transaction Test',
      ownerId: 'owner-1',
    },
  });
}

async function teardownTxDb(prisma: PrismaClient): Promise<void> {
  await prisma.settlement.deleteMany({}).catch(() => {});
  await prisma.merchant.deleteMany({}).catch(() => {});
  await prisma.$disconnect().catch(() => {});
}

test('prisma-adapter (#497): rolls back the transaction on error', async (t) => {
  let prisma: PrismaClient;
  try {
    prisma = await connectTxPrisma();
  } catch (err) {
    t.skip(`PostgreSQL unavailable: ${err}`);
    t.end();
    return;
  }
  try {
    await resetTxDb(prisma);
    try {
      await prisma.$transaction(async (tx) => {
        const settlement = await tx.settlement.create({
          data: {
            id: 'stl-rollback-test',
            merchantId: 'merchant-tx-test',
            totalAmount: '100',
            grossAmount: '100',
            feeAmount: '1',
            netAmount: '99',
            feeBps: 100,
            asset: 'USDC',
            status: 'pending',
          },
        });
        t.equal(settlement.id, 'stl-rollback-test', 'created inside the transaction');
        throw new Error('Intentional rollback test');
      });
      t.fail('transaction should have thrown');
    } catch (err) {
      t.ok(
        (err as Error).message.includes('Intentional rollback test'),
        'transaction error surfaces',
      );
    }
    const settlement = await prisma.settlement.findUnique({
      where: { id: 'stl-rollback-test' },
    });
    t.equal(settlement, null, 'rolled-back row is absent');
  } finally {
    await teardownTxDb(prisma!);
  }
  t.end();
});

test('prisma-adapter (#497): handles concurrent updates with transaction isolation', async (t) => {
  let prisma: PrismaClient;
  try {
    prisma = await connectTxPrisma();
  } catch (err) {
    t.skip(`PostgreSQL unavailable: ${err}`);
    t.end();
    return;
  }
  try {
    await resetTxDb(prisma);
    const initial = await prisma.settlement.create({
      data: {
        id: 'stl-concurrent-test',
        merchantId: 'merchant-tx-test',
        totalAmount: '100',
        grossAmount: '100',
        feeAmount: '1',
        netAmount: '99',
        feeBps: 100,
        asset: 'USDC',
        status: 'pending',
        completedAt: null,
      },
    });

    const updates = await Promise.allSettled([
      prisma.settlement.update({
        where: { id: initial.id },
        data: { status: 'processing' },
      }),
      prisma.settlement.update({
        where: { id: initial.id },
        data: { completedAt: new Date() },
      }),
    ]);

    t.equal(updates[0].status, 'fulfilled', 'first concurrent update succeeds');
    t.equal(updates[1].status, 'fulfilled', 'second concurrent update succeeds');

    const final = await prisma.settlement.findUnique({
      where: { id: initial.id },
    });
    t.equal(final?.status, 'processing', 'final state reflects the status update');
    t.ok(final?.completedAt, 'final state reflects the completion timestamp');
  } finally {
    await teardownTxDb(prisma!);
  }
  t.end();
});

test('prisma-adapter (#497): verifies idempotent updates within transactions', async (t) => {
  let prisma: PrismaClient;
  try {
    prisma = await connectTxPrisma();
  } catch (err) {
    t.skip(`PostgreSQL unavailable: ${err}`);
    t.end();
    return;
  }
  try {
    await resetTxDb(prisma);
    const settlement = await prisma.settlement.create({
      data: {
        id: 'stl-idempotent-test',
        merchantId: 'merchant-tx-test',
        totalAmount: '100',
        grossAmount: '100',
        feeAmount: '1',
        netAmount: '99',
        feeBps: 100,
        asset: 'USDC',
        status: 'pending',
      },
    });

    const update1 = await prisma.$transaction(async (tx) => {
      return tx.settlement.update({
        where: { id: settlement.id },
        data: { status: 'processing' },
      });
    });

    const update2 = await prisma.$transaction(async (tx) => {
      return tx.settlement.update({
        where: { id: settlement.id },
        data: { status: 'processing' },
      });
    });

    t.equal(update1.status, 'processing', 'first update applies');
    t.equal(update2.status, 'processing', 'repeated update applies');
    t.equal(update1.id, update2.id, 'both updates target the same row');
  } finally {
    await teardownTxDb(prisma!);
  }
  t.end();
});

test('prisma-adapter (#497): handles partial failures within transactions', async (t) => {
  let prisma: PrismaClient;
  try {
    prisma = await connectTxPrisma();
  } catch (err) {
    t.skip(`PostgreSQL unavailable: ${err}`);
    t.end();
    return;
  }
  try {
    await resetTxDb(prisma);
    const stl1 = await prisma.settlement.create({
      data: {
        id: 'stl-partial-1',
        merchantId: 'merchant-tx-test',
        totalAmount: '100',
        grossAmount: '100',
        feeAmount: '1',
        netAmount: '99',
        feeBps: 100,
        asset: 'USDC',
        status: 'pending',
      },
    });

    const stl2 = await prisma.settlement.create({
      data: {
        id: 'stl-partial-2',
        merchantId: 'merchant-tx-test',
        totalAmount: '200',
        grossAmount: '200',
        feeAmount: '2',
        netAmount: '198',
        feeBps: 100,
        asset: 'USDC',
        status: 'pending',
      },
    });

    try {
      await prisma.$transaction(async (tx) => {
        await tx.settlement.update({
          where: { id: stl1.id },
          data: { status: 'processing' },
        });
        await tx.settlement.update({
          where: { id: 'non-existent-id' },
          data: { status: 'processing' },
        });
      });
      t.fail('transaction touching a missing row should have thrown');
    } catch (err) {
      t.ok((err as Error).message, 'partial failure surfaces an error');
    }

    const updatedStl1 = await prisma.settlement.findUnique({ where: { id: stl1.id } });
    t.equal(updatedStl1?.status, 'pending', 'first update was rolled back');

    const unchangedStl2 = await prisma.settlement.findUnique({ where: { id: stl2.id } });
    t.equal(unchangedStl2?.status, 'pending', 'untouched row is unchanged');
  } finally {
    await teardownTxDb(prisma!);
  }
  t.end();
});

// ── Adapter unit tests (in-memory mocks, no DB required) ─────────────────────
// Issue #543: concurrency-safe create / optimistic-lock update.

/** Minimal mock-function helper (the repo does not depend on a mocking library). */
function mockFn<T extends (...args: any[]) => any>(impl?: T) {
  const calls: any[][] = [];
  const onceRejections: unknown[] = [];
  const fn = (async (...args: any[]) => {
    calls.push(args);
    if (onceRejections.length > 0) {
      throw onceRejections.shift();
    }
    return impl?.(...args);
  }) as T & {
    calls: any[][];
    mockRejectedValueOnce: (err: unknown) => void;
  };
  fn.calls = calls;
  fn.mockRejectedValueOnce = (err: unknown) => {
    onceRejections.push(err);
  };
  return fn;
}

function makeMockPrisma(overrides?: {
  existingById?: Record<string, unknown>;
  existingByKey?: Record<string, unknown>;
  updateCount?: number;
}) {
  const mockPrisma = {
    settlement: {
      create: mockFn(async ({ data }: { data: Record<string, unknown> }) => {
        return { ...(data as object), version: 0 };
      }),
      findUnique: mockFn(async ({ where }: { where: Record<string, unknown> }) => {
        if ('id' in where) {
          return (overrides?.existingById?.[where.id as string] as unknown) ?? null;
        }
        if ('idempotencyKey' in where) {
          return (overrides?.existingByKey?.[where.idempotencyKey as string] as unknown) ?? null;
        }
        return null;
      }),
      updateMany: mockFn(async () => {
        return { count: overrides?.updateCount ?? 1 };
      }),
    },
  };
  return { mockPrisma };
}

test('prisma-adapter (#543): createSettlementWithUniqueGuard creates a new settlement', async (t) => {
  const { mockPrisma } = makeMockPrisma();
  const result = await createSettlementWithUniqueGuard(mockPrisma as any, {
    id: 'set_new',
    merchantId: 'm1',
    status: 'pending',
  } as any);
  t.equal((result as { id: string }).id, 'set_new', 'returns the created row');
  t.equal(mockPrisma.settlement.create.calls.length, 1, 'create called once');
  t.end();
});

test('prisma-adapter (#543): createSettlementWithUniqueGuard returns existing record on P2002', async (t) => {
  const existing = { id: 'set_existing', merchantId: 'm1', status: 'pending', version: 0 };
  const { mockPrisma } = makeMockPrisma({
    existingById: { set_existing: existing },
  });

  mockPrisma.settlement.create.mockRejectedValueOnce({ code: 'P2002' });

  const result = await createSettlementWithUniqueGuard(mockPrisma as any, {
    id: 'set_existing',
    merchantId: 'm1',
    status: 'pending',
  } as any);

  t.deepEqual(result, existing, 'returns the pre-existing row');
  t.deepEqual(
    mockPrisma.settlement.findUnique.calls[0][0],
    { where: { id: 'set_existing' } },
    'looks up the conflicting row by id',
  );
  t.end();
});

test('prisma-adapter (#543): createSettlementWithUniqueGuard throws UniqueConstraintError when existing record is not found', async (t) => {
  const { mockPrisma } = makeMockPrisma();
  mockPrisma.settlement.create.mockRejectedValueOnce({ code: 'P2002' });

  try {
    await createSettlementWithUniqueGuard(mockPrisma as any, {
      id: 'set_missing',
      merchantId: 'm1',
      status: 'pending',
    } as any);
    t.fail('should have thrown UniqueConstraintError');
  } catch (err) {
    t.ok(err instanceof UniqueConstraintError, 'throws UniqueConstraintError');
  }
  t.end();
});

test('prisma-adapter (#543): updateSettlementWithOptimisticLock increments version on success', async (t) => {
  const { mockPrisma } = makeMockPrisma({
    existingById: { set_1: { id: 'set_1', version: 4, status: 'processing' } },
  });
  const result = await updateSettlementWithOptimisticLock(mockPrisma as any, {
    id: 'set_1',
    expectedVersion: 3,
    data: { status: 'processing' },
  });
  t.ok(result, 'returns the updated row');
  t.deepEqual(
    mockPrisma.settlement.updateMany.calls[0][0],
    {
      where: { id: 'set_1', version: 3 },
      data: { status: 'processing', version: { increment: 1 } },
    },
    'update is guarded by the expected version and bumps it',
  );
  t.end();
});

test('prisma-adapter (#543): updateSettlementWithOptimisticLock throws VersionConflictError on stale version', async (t) => {
  const { mockPrisma } = makeMockPrisma({ updateCount: 0 });

  try {
    await updateSettlementWithOptimisticLock(mockPrisma as any, {
      id: 'set_1',
      expectedVersion: 2,
      data: { status: 'processing' },
    });
    t.fail('should have thrown VersionConflictError');
  } catch (err) {
    t.ok(err instanceof VersionConflictError, 'throws VersionConflictError');
  }
  t.end();
});
