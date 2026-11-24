import test from 'tape';
import { reapStuckSettlements } from './settlement-reaper.js';

test('reapStuckSettlements drains processing rows in batches of 200', async (t) => {
  const stuckBefore = new Date('2026-09-26T19:00:00.000Z');
  const settlements = Array.from({ length: 500 }, (_, index) => ({
    id: `settlement-${String(index).padStart(4, '0')}`,
    initiatedAt: new Date('2026-09-26T18:00:00.000Z'),
    status: 'processing',
  }));
  const findManyArgs: Array<{ where: any; select: any; orderBy: any; take: number }> = [];
  const updates: string[] = [];
  const jobs: Array<{ name: string; data: { id: string } }> = [];

  const prisma = {
    settlement: {
      findMany: async (args: (typeof findManyArgs)[number]) => {
        findManyArgs.push(args);
        return settlements
          .filter((settlement) => settlement.status === args.where.status && settlement.initiatedAt < args.where.initiatedAt.lt)
          .slice(0, args.take);
      },
      updateMany: async (args: { where: { id: string; status: string }; data: { status: string } }) => {
        const settlement = settlements.find(
          (row) => row.id === args.where.id && row.status === args.where.status,
        );
        if (!settlement) return { count: 0 };
        updates.push(args.where.id);
        settlement.status = args.data.status;
        return { count: 1 };
      },
    },
  };
  const queue = {
    add: async (name: string, data: { id: string }) => {
      jobs.push({ name, data });
    },
  };

  const count = await reapStuckSettlements(prisma as any, queue as any, stuckBefore);

  t.equal(count, 500, 'should reap all stale settlements');
  t.deepEqual(findManyArgs.map((args) => args.take), [200, 200, 200], 'should fetch bounded pages');
  t.equal(findManyArgs[0].where.status, 'processing', 'should only scan processing settlements');
  t.equal(findManyArgs[0].where.initiatedAt.lt, stuckBefore, 'should preserve the supplied cutoff');
  t.equal(updates.length, 500, 'should mark every fetched row failed');
  t.equal(jobs.length, 500, 'should enqueue one job per reaped settlement');
  t.deepEqual(jobs[0], { name: 'process-settlement', data: { id: 'settlement-0000' } });
  t.end();
});

test('reapStuckSettlements transitions settlements exceeding max retries to terminal failure with completedAt set', async (t) => {
  const stuckBefore = new Date('2026-09-26T19:00:00.000Z');
  const settlement = {
    id: 'stuck-terminal-1',
    initiatedAt: new Date('2026-09-26T18:00:00.000Z'),
    status: 'processing',
    completedAt: null as Date | null,
  };

  const attemptsMap = new Map<string, number>();
  // Pre-set attempts at maxRetries threshold (3)
  attemptsMap.set('stuck-terminal-1', 3);

  let updatedData: any = null;
  const prisma = {
    settlement: {
      findMany: async () => [settlement],
      updateMany: async (args: any) => {
        updatedData = args.data;
        settlement.status = args.data.status;
        settlement.completedAt = args.data.completedAt;
        return { count: 1 };
      },
    },
  };

  const enqueuedJobs: any[] = [];
  const queue = {
    add: async (name: string, data: any) => {
      enqueuedJobs.push({ name, data });
    },
  };

  const warnings: any[] = [];
  const logger = {
    warn: (obj: any, msg?: string) => warnings.push({ obj, msg }),
    error: () => {},
  };

  const count = await reapStuckSettlements(prisma as any, queue as any, stuckBefore, {
    maxRetries: 3,
    attemptsMap,
    logger: logger as any,
  });

  t.equal(count, 1, 'reaped 1 settlement');
  t.equal(settlement.status, 'failed', 'status transitioned to failed');
  t.ok(settlement.completedAt instanceof Date, 'completedAt is set on terminal failure');
  t.ok(updatedData.completedAt, 'update payload included completedAt');
  t.equal(enqueuedJobs.length, 0, 'did not re-enqueue job into BullMQ after reaching retry cap');
  t.equal(warnings.length, 1, 'logged warning for exceeding retry limit');
  t.end();
});

test('reapStuckSettlements handles BullMQ enqueue failure without leaving DB in inconsistent state', async (t) => {
  const stuckBefore = new Date('2026-09-26T19:00:00.000Z');
  const settlement = {
    id: 'stuck-enqueue-fail',
    initiatedAt: new Date('2026-09-26T18:00:00.000Z'),
    status: 'processing',
  };

  const statusHistory: string[] = [];
  const prisma = {
    settlement: {
      findMany: async () => [settlement],
      updateMany: async (args: any) => {
        settlement.status = args.data.status;
        statusHistory.push(args.data.status);
        return { count: 1 };
      },
    },
  };

  const queue = {
    add: async () => {
      throw new Error('BullMQ connection failure');
    },
  };

  const loggedErrors: any[] = [];
  const logger = {
    error: (obj: any, msg?: string) => loggedErrors.push({ obj, msg }),
    warn: () => {},
  };

  const attemptsMap = new Map<string, number>();

  const count = await reapStuckSettlements(prisma as any, queue as any, stuckBefore, {
    maxRetries: 3,
    attemptsMap,
    logger: logger as any,
  });

  t.equal(count, 0, 'reapedCount not incremented on enqueue error');
  t.equal(settlement.status, 'processing', 'settlement status restored to processing after enqueue failure');
  t.deepEqual(statusHistory, ['failed', 'processing'], 'status transitioned processing -> failed -> reverted to processing');
  t.equal(loggedErrors.length, 1, 'logged the enqueue error');
  t.match(loggedErrors[0].obj.err.message, /BullMQ connection failure/, 'error logged with cause');
  t.equal(attemptsMap.get('stuck-enqueue-fail'), undefined, 'failed attempt was not committed to retry map');
  t.end();
});
