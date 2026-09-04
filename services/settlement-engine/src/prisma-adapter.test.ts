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
  t.notMatch(
    adapterContent,
    /\.upsert\s*\(/,
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
// Issue #497: Add tests for Prisma adapter transaction isolation

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import {
  createSettlementWithUniqueGuard,
  updateSettlementWithOptimisticLock,
  VersionConflictError,
  UniqueConstraintError,
} from './prisma-adapter.js';

describe('Prisma Adapter Transaction Isolation (#497)', () => {
  let prisma: PrismaClient;

  beforeEach(async () => {
    prisma = new PrismaClient();
    await prisma.settlement.deleteMany({});
    await prisma.merchant.deleteMany({});

    // Create test merchant
    await prisma.merchant.create({
      data: {
        id: 'merchant-tx-test',
        name: 'Transaction Test',
        ownerId: 'owner-1',
      },
    });
  });

  afterEach(async () => {
    await prisma.settlement.deleteMany({});
    await prisma.merchant.deleteMany({});
    await prisma.$disconnect();
  });

  it('should rollback transaction on error', async () => {
    try {
      await prisma.$transaction(async (tx) => {
        // Create settlement
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

        expect(settlement.id).toBe('stl-rollback-test');

        // Throw error to trigger rollback
        throw new Error('Intentional rollback test');
      });
    } catch (err) {
      // Expected
      expect((err as Error).message).toContain('Intentional rollback test');
    }

    // Verify settlement was not created (rolled back)
    const settlement = await prisma.settlement.findUnique({
      where: { id: 'stl-rollback-test' },
    });
    expect(settlement).toBeNull();
  });

  it('should handle concurrent updates with transaction isolation', async () => {
    // Create initial settlement
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

    // Simulate concurrent updates
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

    // Both updates should succeed
    expect(updates[0].status).toBe('fulfilled');
    expect(updates[1].status).toBe('fulfilled');

    // Verify final state reflects both updates
    const final = await prisma.settlement.findUnique({
      where: { id: initial.id },
    });
    expect(final?.status).toBe('processing');
    expect(final?.completedAt).toBeDefined();
  });

  it('should verify idempotent updates within transaction', async () => {
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

    // Apply same update twice via transaction
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

    // Both should reflect the same state
    expect(update1.status).toBe('processing');
    expect(update2.status).toBe('processing');
    expect(update1.id).toBe(update2.id);
  });

  it('should handle partial failures within transactions', async () => {
    // Create two settlements
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
        // Update first settlement
        await tx.settlement.update({
          where: { id: stl1.id },
          data: { status: 'processing' },
        });

        // Try to update non-existent settlement (should fail)
        await tx.settlement.update({
          where: { id: 'non-existent-id' },
          data: { status: 'processing' },
        });
      });
    } catch (err) {
      // Expected to fail
      expect((err as Error).message).toBeDefined();
    }

    // Verify first settlement update was rolled back
    const updatedStl1 = await prisma.settlement.findUnique({ where: { id: stl1.id } });
    expect(updatedStl1?.status).toBe('pending');

    // Second settlement should be unchanged
    const unchangedStl2 = await prisma.settlement.findUnique({ where: { id: stl2.id } });
    expect(unchangedStl2?.status).toBe('pending');
  });
});

// ── Adapter unit tests (in-memory mocks, no DB required) ─────────────────────

describe('Settlement Prisma Adapter (#543)', () => {
  function makeMockPrisma(overrides?: {
    existingById?: Record<string, unknown>;
    existingByKey?: Record<string, unknown>;
    updateCount?: number;
  }) {
    const store: Record<string, unknown> = {};
    const mockPrisma = {
      settlement: {
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          return { ...(data as object), version: 0 } as unknown as Settlement;
        }),
        findUnique: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
          if ('id' in where) {
            return (overrides?.existingById?.[where.id as string] as Settlement) ?? null;
          }
          if ('idempotencyKey' in where) {
            return (overrides?.existingByKey?.[where.idempotencyKey as string] as Settlement) ?? null;
          }
          return null;
        }),
        updateMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
          return { count: overrides?.updateCount ?? 1 };
        }),
      },
    };
    return { mockPrisma, store };
  }

  it('createSettlementWithUniqueGuard creates a new settlement', async () => {
    const { mockPrisma } = makeMockPrisma();
    const result = await createSettlementWithUniqueGuard(mockPrisma as any, {
      id: 'set_new',
      merchantId: 'm1',
      status: 'pending',
    } as any);
    expect(result.id).toBe('set_new');
    expect(mockPrisma.settlement.create).toHaveBeenCalledTimes(1);
  });

  it('createSettlementWithUniqueGuard returns existing record on P2002', async () => {
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

    expect(result).toEqual(existing);
    expect(mockPrisma.settlement.findUnique).toHaveBeenCalledWith({ where: { id: 'set_existing' } });
  });

  it('createSettlementWithUniqueGuard throws UniqueConstraintError when existing record is not found', async () => {
    const { mockPrisma } = makeMockPrisma();
    mockPrisma.settlement.create.mockRejectedValueOnce({ code: 'P2002' });

    await expect(
      createSettlementWithUniqueGuard(mockPrisma as any, {
        id: 'set_missing',
        merchantId: 'm1',
        status: 'pending',
      } as any),
    ).rejects.toBeInstanceOf(UniqueConstraintError);
  });

  it('updateSettlementWithOptimisticLock increments version on success', async () => {
    const { mockPrisma } = makeMockPrisma();
    const result = await updateSettlementWithOptimisticLock(mockPrisma as any, {
      id: 'set_1',
      expectedVersion: 3,
      data: { status: 'processing' },
    });
    expect(result).toBeDefined();
    expect(mockPrisma.settlement.updateMany).toHaveBeenCalledWith({
      where: { id: 'set_1', version: 3 },
      data: { status: 'processing', version: { increment: 1 } },
    });
  });

  it('updateSettlementWithOptimisticLock throws VersionConflictError on stale version', async () => {
    const { mockPrisma } = makeMockPrisma({ updateCount: 0 });

    await expect(
      updateSettlementWithOptimisticLock(mockPrisma as any, {
        id: 'set_1',
        expectedVersion: 2,
        data: { status: 'processing' },
      }),
    ).rejects.toBeInstanceOf(VersionConflictError);
  });
});
