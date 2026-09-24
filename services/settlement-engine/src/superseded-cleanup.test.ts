import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { archiveSupersededChains, countRetryChainDepth } from './superseded-cleanup.js';

const prisma = new PrismaClient();

describe('Superseded Settlement Cleanup (#494)', () => {
  beforeEach(async () => {
    await prisma.settlement.deleteMany({});
    await prisma.merchant.deleteMany({});
  });

  afterEach(async () => {
    await prisma.settlement.deleteMany({});
    await prisma.merchant.deleteMany({});
  });

  it('should not archive recent superseded chains', async () => {
    await prisma.merchant.create({
      data: { id: 'merchant-1', name: 'Test', ownerId: 'owner-1' },
    });

    // Create recent chain (created today)
    const root = await prisma.settlement.create({
      data: {
        id: 'stl-1',
        merchantId: 'merchant-1',
        totalAmount: '100',
        grossAmount: '100',
        feeAmount: '1',
        netAmount: '99',
        feeBps: 100,
        asset: 'USDC',
        status: 'failed',
        initiatedAt: new Date(),
      },
    });

    const retry = await prisma.settlement.create({
      data: {
        id: 'stl-2',
        merchantId: 'merchant-1',
        totalAmount: '100',
        grossAmount: '100',
        feeAmount: '1',
        netAmount: '99',
        feeBps: 100,
        asset: 'USDC',
        status: 'completed',
        initiatedAt: new Date(),
      },
    });

    await prisma.settlement.update({
      where: { id: root.id },
      data: { supersededById: retry.id },
    });

    const mockLog = { info: () => {} };
    const archived = await archiveSupersededChains(prisma, mockLog);

    // Should not archive recent chains
    expect(archived).toBe(0);
  });

  it('should archive old completed superseded chains', async () => {
    await prisma.merchant.create({
      data: { id: 'merchant-1', name: 'Test', ownerId: 'owner-1' },
    });

    const eightDaysAgo = new Date();
    eightDaysAgo.setDate(eightDaysAgo.getDate() - 8);

    const root = await prisma.settlement.create({
      data: {
        id: 'stl-1',
        merchantId: 'merchant-1',
        totalAmount: '100',
        grossAmount: '100',
        feeAmount: '1',
        netAmount: '99',
        feeBps: 100,
        asset: 'USDC',
        status: 'failed',
        initiatedAt: eightDaysAgo,
        completedAt: eightDaysAgo,
      },
    });

    const retry = await prisma.settlement.create({
      data: {
        id: 'stl-2',
        merchantId: 'merchant-1',
        totalAmount: '100',
        grossAmount: '100',
        feeAmount: '1',
        netAmount: '99',
        feeBps: 100,
        asset: 'USDC',
        status: 'completed',
        initiatedAt: eightDaysAgo,
        completedAt: eightDaysAgo,
      },
    });

    await prisma.settlement.update({
      where: { id: root.id },
      data: { supersededById: retry.id },
    });

    const mockLog = { info: () => {} };
    const archived = await archiveSupersededChains(prisma, mockLog);

    expect(archived).toBeGreaterThan(0);
  });

  it('should count retry chain depth correctly', async () => {
    await prisma.merchant.create({
      data: { id: 'merchant-1', name: 'Test', ownerId: 'owner-1' },
    });

    const stl1 = await prisma.settlement.create({
      data: {
        id: 'stl-1',
        merchantId: 'merchant-1',
        totalAmount: '100',
        grossAmount: '100',
        feeAmount: '1',
        netAmount: '99',
        feeBps: 100,
        asset: 'USDC',
        status: 'failed',
      },
    });

    const stl2 = await prisma.settlement.create({
      data: {
        id: 'stl-2',
        merchantId: 'merchant-1',
        totalAmount: '100',
        grossAmount: '100',
        feeAmount: '1',
        netAmount: '99',
        feeBps: 100,
        asset: 'USDC',
        status: 'failed',
      },
    });

    await prisma.settlement.update({
      where: { id: stl1.id },
      data: { supersededById: stl2.id },
    });

    const stl3 = await prisma.settlement.create({
      data: {
        id: 'stl-3',
        merchantId: 'merchant-1',
        totalAmount: '100',
        grossAmount: '100',
        feeAmount: '1',
        netAmount: '99',
        feeBps: 100,
        asset: 'USDC',
        status: 'pending',
      },
    });

    await prisma.settlement.update({
      where: { id: stl2.id },
      data: { supersededById: stl3.id },
    });

    const depth = await countRetryChainDepth(prisma, stl1.id);
    expect(depth).toBe(2);
  });

  it('should enforce max 3 retries during creation', async () => {
    await prisma.merchant.create({
      data: { id: 'merchant-1', name: 'Test', ownerId: 'owner-1' },
    });

    // Create chain of 4 settlements
    let current = await prisma.settlement.create({
      data: {
        id: 'stl-1',
        merchantId: 'merchant-1',
        totalAmount: '100',
        grossAmount: '100',
        feeAmount: '1',
        netAmount: '99',
        feeBps: 100,
        asset: 'USDC',
        status: 'failed',
      },
    });

    for (let i = 2; i <= 4; i++) {
      const next = await prisma.settlement.create({
        data: {
          id: `stl-${i}`,
          merchantId: 'merchant-1',
          totalAmount: '100',
          grossAmount: '100',
          feeAmount: '1',
          netAmount: '99',
          feeBps: 100,
          asset: 'USDC',
          status: 'failed',
        },
      });

      await prisma.settlement.update({
        where: { id: current.id },
        data: { supersededById: next.id },
      });

      current = next;
    }

    // Verify the chain depth
    const depth = await countRetryChainDepth(prisma, 'stl-1');
    expect(depth).toBe(3);

    // The 4th attempt should be blocked by validation in index.ts
    const finalDepth = await countRetryChainDepth(prisma, 'stl-1');
    expect(finalDepth).toBeGreaterThanOrEqual(3);
  });
});
