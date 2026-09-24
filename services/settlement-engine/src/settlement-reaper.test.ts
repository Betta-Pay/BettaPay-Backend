import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { reapStuckSettlements, startSettlementReaper, PROCESSING_STUCK_THRESHOLD_MS } from './settlement-reaper.js';

const prisma = new PrismaClient();

describe('Settlement Reaper (#496)', () => {
  beforeEach(async () => {
    await prisma.settlement.deleteMany({});
    await prisma.merchant.deleteMany({});
  });

  afterEach(async () => {
    await prisma.settlement.deleteMany({});
    await prisma.merchant.deleteMany({});
  });

  it('should recover settlements stuck in processing state', async () => {
    await prisma.merchant.create({
      data: { id: 'merchant-1', name: 'Test', ownerId: 'owner-1' },
    });

    // Create a settlement stuck in processing
    const staleDate = new Date();
    staleDate.setTime(staleDate.getTime() - (PROCESSING_STUCK_THRESHOLD_MS + 10_000));

    const stuck = await prisma.settlement.create({
      data: {
        id: 'stl-stuck',
        merchantId: 'merchant-1',
        totalAmount: '100',
        grossAmount: '100',
        feeAmount: '1',
        netAmount: '99',
        feeBps: 100,
        asset: 'USDC',
        status: 'processing',
        initiatedAt: staleDate,
      },
    });

    const mockQueue = {
      add: vi.fn().mockResolvedValue(undefined),
    };

    const recovered = await reapStuckSettlements(prisma, mockQueue, undefined);

    expect(recovered).toBe(1);

    // Verify settlement was marked failed
    const updated = await prisma.settlement.findUnique({ where: { id: stuck.id } });
    expect(updated?.status).toBe('failed');
    expect(updated?.completedAt).toBeDefined();

    // Verify it was re-queued
    expect(mockQueue.add).toHaveBeenCalledWith(
      'process-settlement',
      expect.objectContaining({
        id: stuck.id,
        merchantId: 'merchant-1',
      })
    );
  });

  it('should not recover recent processing settlements', async () => {
    await prisma.merchant.create({
      data: { id: 'merchant-1', name: 'Test', ownerId: 'owner-1' },
    });

    // Create a settlement recently started (within threshold)
    const recent = await prisma.settlement.create({
      data: {
        id: 'stl-recent',
        merchantId: 'merchant-1',
        totalAmount: '100',
        grossAmount: '100',
        feeAmount: '1',
        netAmount: '99',
        feeBps: 100,
        asset: 'USDC',
        status: 'processing',
        initiatedAt: new Date(),
      },
    });

    const mockQueue = { add: vi.fn() };
    const recovered = await reapStuckSettlements(prisma, mockQueue, undefined);

    expect(recovered).toBe(0);

    // Verify settlement is still processing
    const updated = await prisma.settlement.findUnique({ where: { id: recent.id } });
    expect(updated?.status).toBe('processing');
  });

  it('should handle multiple stuck settlements in one cycle', async () => {
    await prisma.merchant.create({
      data: { id: 'merchant-1', name: 'Test', ownerId: 'owner-1' },
    });

    const staleDate = new Date();
    staleDate.setTime(staleDate.getTime() - (PROCESSING_STUCK_THRESHOLD_MS + 10_000));

    // Create 3 stuck settlements
    const ids = [];
    for (let i = 0; i < 3; i++) {
      const stl = await prisma.settlement.create({
        data: {
          id: `stl-stuck-${i}`,
          merchantId: 'merchant-1',
          totalAmount: '100',
          grossAmount: '100',
          feeAmount: '1',
          netAmount: '99',
          feeBps: 100,
          asset: 'USDC',
          status: 'processing',
          initiatedAt: staleDate,
        },
      });
      ids.push(stl.id);
    }

    const mockQueue = { add: vi.fn().mockResolvedValue(undefined) };
    const recovered = await reapStuckSettlements(prisma, mockQueue, undefined);

    expect(recovered).toBe(3);
    expect(mockQueue.add).toHaveBeenCalledTimes(3);

    // Verify all are marked failed
    for (const id of ids) {
      const stl = await prisma.settlement.findUnique({ where: { id } });
      expect(stl?.status).toBe('failed');
    }
  });

  it('should start and stop reaper daemon', async () => {
    await prisma.merchant.create({
      data: { id: 'merchant-1', name: 'Test', ownerId: 'owner-1' },
    });

    const staleDate = new Date();
    staleDate.setTime(staleDate.getTime() - (PROCESSING_STUCK_THRESHOLD_MS + 10_000));

    const stuck = await prisma.settlement.create({
      data: {
        id: 'stl-stuck',
        merchantId: 'merchant-1',
        totalAmount: '100',
        grossAmount: '100',
        feeAmount: '1',
        netAmount: '99',
        feeBps: 100,
        asset: 'USDC',
        status: 'processing',
        initiatedAt: staleDate,
      },
    });

    const mockQueue = { add: vi.fn().mockResolvedValue(undefined) };
    const mockLog = { info: vi.fn(), error: vi.fn() };

    // Start reaper with short interval for testing
    const stop = startSettlementReaper(prisma, mockQueue, mockLog, 100);

    // Wait for at least one cycle
    await new Promise(resolve => setTimeout(resolve, 200));

    // Stop reaper
    stop();

    // Verify reaper ran
    const updated = await prisma.settlement.findUnique({ where: { id: stuck.id } });
    expect(updated?.status).toBe('failed');
  });

  it('should handle recovery errors gracefully', async () => {
    await prisma.merchant.create({
      data: { id: 'merchant-1', name: 'Test', ownerId: 'owner-1' },
    });

    const staleDate = new Date();
    staleDate.setTime(staleDate.getTime() - (PROCESSING_STUCK_THRESHOLD_MS + 10_000));

    await prisma.settlement.create({
      data: {
        id: 'stl-stuck',
        merchantId: 'merchant-1',
        totalAmount: '100',
        grossAmount: '100',
        feeAmount: '1',
        netAmount: '99',
        feeBps: 100,
        asset: 'USDC',
        status: 'processing',
        initiatedAt: staleDate,
      },
    });

    // Queue that fails
    const mockQueue = {
      add: vi.fn().mockRejectedValue(new Error('Queue error')),
    };

    const mockLog = { error: vi.fn() };

    // Should not throw
    const recovered = await reapStuckSettlements(prisma, mockQueue, mockLog);

    // Should still count as recovered (DB update succeeded even if queue failed)
    expect(recovered).toBe(1);
  });
});
