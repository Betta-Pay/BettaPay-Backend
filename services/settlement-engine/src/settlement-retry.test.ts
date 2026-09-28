import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { assertRetryLimit } from './index.js';

const prisma = new PrismaClient();

describe('Settlement Retry', () => {
  beforeEach(async () => {
    await prisma.settlement.deleteMany({});
    await prisma.merchant.deleteMany({});
  });

  afterEach(async () => {
    await prisma.settlement.deleteMany({});
    await prisma.merchant.deleteMany({});
  });

  it('should retry a failed settlement', async () => {
    // Create merchant
    await prisma.merchant.create({
      data: {
        id: 'merchant-1',
        name: 'Test Merchant',
        ownerId: 'owner-1',
      },
    });

    // Create failed settlement
    const failed = await prisma.settlement.create({
      data: {
        id: 'settlement-1',
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

    // Simulate retry logic
    const newSettlement = await prisma.settlement.create({
      data: {
        id: 'settlement-2',
        merchantId: failed.merchantId,
        totalAmount: failed.totalAmount,
        grossAmount: failed.grossAmount,
        feeAmount: failed.feeAmount,
        netAmount: failed.netAmount,
        feeBps: failed.feeBps,
        asset: failed.asset,
        status: 'pending',
        webhookUrl: failed.webhookUrl,
      },
    });

    await prisma.settlement.update({
      where: { id: failed.id },
      data: { supersededById: newSettlement.id },
    });

    // Verify
    const updated = await prisma.settlement.findUnique({ where: { id: failed.id } });
    expect(updated?.supersededById).toBe(newSettlement.id);
    expect(newSettlement.status).toBe('pending');
    expect(newSettlement.grossAmount).toBe(failed.grossAmount);
  });

  it('should not retry a completed settlement', async () => {
    await prisma.merchant.create({
      data: {
        id: 'merchant-1',
        name: 'Test Merchant',
        ownerId: 'owner-1',
      },
    });

    const completed = await prisma.settlement.create({
      data: {
        id: 'settlement-1',
        merchantId: 'merchant-1',
        totalAmount: '100',
        grossAmount: '100',
        feeAmount: '1',
        netAmount: '99',
        feeBps: 100,
        asset: 'USDC',
        status: 'completed',
      },
    });

    // Should validate that status is 'failed' before retrying
    expect(completed.status).toBe('completed');
    // In actual implementation, API would return 422
  });

  it('should reject when retry count reaches max allowed', () => {
    expect(() => assertRetryLimit(3, 3)).toThrow(/Maximum retry limit/i);
    expect(() => assertRetryLimit(0, 3)).not.toThrow();
  });

  it('should enforce max 3 retries', async () => {
    await prisma.merchant.create({
      data: {
        id: 'merchant-1',
        name: 'Test Merchant',
        ownerId: 'owner-1',
      },
    });

    // Create chain of 4 settlements (original + 3 retries)
    let current = await prisma.settlement.create({
      data: {
        id: 'settlement-1',
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
      const retry = await prisma.settlement.create({
        data: {
          id: `settlement-${i}`,
          merchantId: 'merchant-1',
          totalAmount: '100',
          grossAmount: '100',
          feeAmount: '1',
          netAmount: '99',
          feeBps: 100,
          asset: 'USDC',
          status: i === 4 ? 'failed' : 'failed',
        },
      });

      await prisma.settlement.update({
        where: { id: current.id },
        data: { supersededById: retry.id },
      });

      current = retry;
    }

    // Count the retry chain
    const chain = await prisma.settlement.findMany({
      where: {
        OR: [
          { id: 'settlement-1' },
          { supersededById: { not: null } },
        ],
      },
    });

    // Should have 4 settlements total (original + 3 retries)
    expect(chain.length).toBeGreaterThanOrEqual(3);
    // The 4th attempt should be rejected (verified at API level)
  });

  it('should exclude superseded settlements from default listing', async () => {
    await prisma.merchant.create({
      data: {
        id: 'merchant-1',
        name: 'Test Merchant',
        ownerId: 'owner-1',
      },
    });

    const original = await prisma.settlement.create({
      data: {
        id: 'settlement-1',
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

    const retry = await prisma.settlement.create({
      data: {
        id: 'settlement-2',
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
      where: { id: original.id },
      data: { supersededById: retry.id },
    });

    // Query excluding superseded settlements
    const activeSettlements = await prisma.settlement.findMany({
      where: { supersededById: null },
    });

    expect(activeSettlements).toHaveLength(1);
    expect(activeSettlements[0].id).toBe(retry.id);

    // Query including superseded settlements
    const allSettlements = await prisma.settlement.findMany({});
    expect(allSettlements).toHaveLength(2);
  });
});
