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
      update: async (args: { where: { id: string }; data: { status: string } }) => {
        updates.push(args.where.id);
        const settlement = settlements.find((row) => row.id === args.where.id);
        if (settlement) settlement.status = args.data.status;
        return settlement;
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

test('reapStuckSettlements does nothing when there are no stale rows', async (t) => {
  let updateCount = 0;
  let enqueueCount = 0;
  const prisma = {
    settlement: {
      findMany: async () => [],
      update: async () => {
        updateCount++;
      },
    },
  };
  const queue = {
    add: async () => {
      enqueueCount++;
    },
  };

  const count = await reapStuckSettlements(prisma as any, queue as any, new Date());

  t.equal(count, 0);
  t.equal(updateCount, 0);
  t.equal(enqueueCount, 0);
  t.end();
});
