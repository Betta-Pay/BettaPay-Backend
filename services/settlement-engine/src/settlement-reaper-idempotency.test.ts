import test from 'tape';
import {
  reapStuckSettlements,
  settlementReapedCounter,
  startSettlementReaper,
} from './settlement-reaper.js';

const NOW = new Date('2026-09-26T19:00:00.000Z').getTime();
const STUCK_BEFORE = new Date(NOW - 30 * 60 * 1000);

interface Row {
  id: string;
  status: string;
  initiatedAt: Date;
}

// In-memory prisma double. `updateMany` checks-and-sets synchronously, so it is
// atomic the way a conditional SQL UPDATE is; `yieldOnFind` lets concurrent
// runs interleave between their read and write.
function setup(rows: Row[], opts: { yieldOnFind?: boolean } = {}) {
  const jobs: string[] = [];
  const prisma = {
    settlement: {
      findMany: async (args: any) => {
        const found = rows
          .filter(
            (r) =>
              r.status === args.where.status &&
              r.initiatedAt < args.where.initiatedAt.lt,
          )
          .slice(0, args.take)
          .map((r) => ({ id: r.id }));
        if (opts.yieldOnFind) await new Promise((r) => setImmediate(r));
        return found;
      },
      updateMany: async (args: any) => {
        const row = rows.find(
          (r) =>
            r.id === args.where.id &&
            r.status === args.where.status &&
            r.initiatedAt < args.where.initiatedAt.lt,
        );
        if (!row) return { count: 0 };
        row.status = args.data.status;
        return { count: 1 };
      },
    },
  };
  const queue = {
    add: async (_name: string, data: { id: string }) => {
      jobs.push(data.id);
    },
  };
  return { prisma: prisma as any, queue: queue as any, jobs };
}

async function reapedTotal(): Promise<number> {
  const metric = await settlementReapedCounter.get();
  return metric.values.reduce((sum, v) => sum + v.value, 0);
}

const stuckRow = (id: string): Row => ({
  id,
  status: 'processing',
  initiatedAt: new Date(NOW - 2 * 60 * 60 * 1000),
});

test('reaping the same stuck job twice does not change state or throw', async (t) => {
  const rows = [stuckRow('s1')];
  const { prisma, queue, jobs } = setup(rows);

  t.equal(await reapStuckSettlements(prisma, queue, STUCK_BEFORE), 1, 'first reap handles the job');
  const stateAfterFirst = JSON.stringify(rows);

  let second = -1;
  try {
    second = await reapStuckSettlements(prisma, queue, STUCK_BEFORE);
    t.pass('second reap does not throw');
  } catch (err) {
    t.fail(`second reap threw: ${err}`);
  }
  t.equal(second, 0, 'second reap handles nothing');
  t.equal(JSON.stringify(rows), stateAfterFirst, 'state identical after the first reap');
  t.deepEqual(jobs, ['s1'], 'job enqueued once');
  t.end();
});

test('an in-flight (recent) job is not reaped', async (t) => {
  const rows: Row[] = [
    { id: 'inflight', status: 'processing', initiatedAt: new Date(NOW - 60 * 1000) },
    stuckRow('stuck'),
  ];
  const { prisma, queue, jobs } = setup(rows);

  const count = await reapStuckSettlements(prisma, queue, STUCK_BEFORE);

  t.equal(count, 1, 'only the stuck job is reaped');
  t.equal(rows[0].status, 'processing', 'in-flight job left untouched');
  t.deepEqual(jobs, ['stuck'], 'in-flight job not enqueued');
  t.end();
});

test('a job below the stuck threshold is left alone, one above it is reaped once', async (t) => {
  const rows: Row[] = [
    { id: 'young', status: 'processing', initiatedAt: new Date(STUCK_BEFORE.getTime() + 1) },
    { id: 'old', status: 'processing', initiatedAt: new Date(STUCK_BEFORE.getTime() - 1) },
  ];
  const { prisma, queue, jobs } = setup(rows);

  await reapStuckSettlements(prisma, queue, STUCK_BEFORE);
  await reapStuckSettlements(prisma, queue, STUCK_BEFORE);

  t.equal(rows[0].status, 'processing', 'younger than threshold untouched');
  t.equal(rows[1].status, 'failed', 'older than threshold reaped');
  t.deepEqual(jobs, ['old'], 'older job enqueued exactly once');
  t.end();
});

test('the reaped counter increments exactly once per job', async (t) => {
  const before = await reapedTotal();
  const { prisma, queue } = setup([stuckRow('m1')]);

  await reapStuckSettlements(prisma, queue, STUCK_BEFORE);
  t.equal((await reapedTotal()) - before, 1, 'incremented by one for a single reaped job');

  await reapStuckSettlements(prisma, queue, STUCK_BEFORE);
  t.equal((await reapedTotal()) - before, 1, 'a repeat reap does not increment again');
  t.end();
});

test('concurrent reap runs yield a single effective reap per job', async (t) => {
  const before = await reapedTotal();
  const rows = [stuckRow('c1'), stuckRow('c2'), stuckRow('c3')];
  const { prisma, queue, jobs } = setup(rows, { yieldOnFind: true });

  const [a, b] = await Promise.all([
    reapStuckSettlements(prisma, queue, STUCK_BEFORE),
    reapStuckSettlements(prisma, queue, STUCK_BEFORE),
  ]);

  t.equal(a + b, 3, 'the runs together reap each job once');
  t.deepEqual([...jobs].sort(), ['c1', 'c2', 'c3'], 'each job enqueued exactly once');
  t.equal((await reapedTotal()) - before, 3, 'counter incremented once per job');
  t.ok(rows.every((r) => r.status === 'failed'), 'all jobs failed once');
  t.end();
});

test('startSettlementReaper skips a tick while a prior run is still active', async (t) => {
  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  let tick: () => void = () => {};
  (globalThis as any).setInterval = (fn: () => void) => {
    tick = fn;
    return 1;
  };
  (globalThis as any).clearInterval = () => {};

  try {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    let findCalls = 0;
    const prisma = {
      settlement: {
        findMany: async () => {
          findCalls++;
          await gate;
          return [];
        },
      },
    };
    const warnings: string[] = [];
    const logger = { warn: (_o: object, m: string) => warnings.push(m), info() {}, error() {} };

    const stop = startSettlementReaper(prisma as any, {} as any, logger as any);
    tick();
    tick(); // overlaps the first, still-pending run
    t.equal(findCalls, 1, 'overlapping tick did not start a second run');
    t.equal(warnings.length, 1, 'overlap logged');

    release();
    await stop();
  } finally {
    globalThis.setInterval = realSetInterval;
    globalThis.clearInterval = realClearInterval;
  }
  t.end();
});
