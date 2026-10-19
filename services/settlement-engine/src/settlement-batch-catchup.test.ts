import test from 'tape';
import {
  BatchAlreadyProcessedError,
  claimBatchForProcessing,
  runSettlementBatching,
} from './settlement-batch-processor.js';

const INTERVAL_MS = 300_000;
const T0 = 1_700_000_000_000;

interface Row {
  id: string;
  asset: string;
  status: string;
  initiatedAt: Date;
  grossAmount: string;
  feeAmount: string;
  netAmount: string;
}

function row(i: number, asset = 'USDC'): Row {
  return {
    id: `s${String(i).padStart(3, '0')}`,
    asset,
    status: 'pending',
    initiatedAt: new Date(T0 + i * 1000),
    grossAmount: '100',
    feeAmount: '1',
    netAmount: '99',
  };
}

// In-memory prisma double that honours orderBy/take on findMany.
function setup(rows: Row[]) {
  const batches: { id: string; asset: string; ids: string[] }[] = [];
  const findManyArgs: any[] = [];
  const prisma = {
    settlement: {
      findMany: async (args: any) => {
        findManyArgs.push(args);
        let found = rows.filter((r) => r.status === args.where.status);
        for (const order of [...(args.orderBy ?? [])].reverse()) {
          const [field, dir] = Object.entries(order)[0] as [keyof Row, string];
          found = [...found].sort((a, b) => {
            const av = a[field] as any;
            const bv = b[field] as any;
            return (av > bv ? 1 : av < bv ? -1 : 0) * (dir === 'asc' ? 1 : -1);
          });
        }
        return args.take ? found.slice(0, args.take) : found;
      },
      updateMany: async (args: any) => {
        const ids: string[] = args.where.id.in;
        for (const r of rows) if (ids.includes(r.id)) r.status = args.data.status;
        batches[batches.length - 1].ids.push(...ids);
        return { count: ids.length };
      },
    },
    settlementBatch: {
      create: async (args: any) => {
        const batch = { id: `b${batches.length + 1}`, asset: args.data.asset, ids: [] as string[] };
        batches.push(batch);
        return batch;
      },
    },
  };
  return { prisma: prisma as any, batches, findManyArgs };
}

const log = { info() {}, warn() {} };
const config = { intervalMs: INTERVAL_MS, minCount: 2, volumeThreshold: 0 };

test('a missed interval triggers catch-up on the next run', async (t) => {
  const rows = [row(1), row(2), row(3), row(4)];
  const { prisma, batches } = setup(rows);
  const warnings: string[] = [];

  const result = await runSettlementBatching(
    prisma,
    config,
    T0,
    { info() {}, warn: (_o, m) => warnings.push(m) },
    T0 + 3 * INTERVAL_MS + 10,
  );

  t.ok(result.late, 'run flagged as late');
  t.equal(result.missedIntervals, 2, 'two intervals were missed');
  t.equal(warnings.length, 1, 'catch-up warning logged');
  t.equal(result.batched, 4, 'the queued backlog is processed');
  t.equal(batches.length, 1, 'backlog batched together');
  t.ok(rows.every((r) => r.status === 'processing'), 'all queued settlements moved to processing');
  t.end();
});

test('an on-time run is not flagged late', async (t) => {
  const { prisma } = setup([row(1), row(2)]);
  const result = await runSettlementBatching(prisma, config, T0, log, T0 + INTERVAL_MS);
  t.notOk(result.late, 'not late');
  t.equal(result.missedIntervals, 0, 'no missed intervals');
  t.end();
});

test('a run processes at most the configured batch size', async (t) => {
  const rows = Array.from({ length: 10 }, (_, i) => row(i));
  const { prisma, findManyArgs } = setup(rows);

  const result = await runSettlementBatching(prisma, { ...config, maxBatchSize: 4 }, T0, log, T0);

  t.equal(findManyArgs[0].take, 4, 'query is capped at the batch size');
  t.equal(result.batched, 4, 'only 4 processed');
  t.equal(rows.filter((r) => r.status === 'processing').length, 4, 'four moved to processing');
  t.equal(rows.filter((r) => r.status === 'pending').length, 6, 'the remainder stays queued');
  t.end();
});

test('no cap is applied when maxBatchSize is unset or zero', async (t) => {
  for (const maxBatchSize of [undefined, 0]) {
    const rows = Array.from({ length: 6 }, (_, i) => row(i));
    const { prisma, findManyArgs } = setup(rows);
    const result = await runSettlementBatching(prisma, { ...config, maxBatchSize }, T0, log, T0);
    t.notOk('take' in findManyArgs[0], `no take for maxBatchSize=${maxBatchSize}`);
    t.equal(result.batched, 6, 'everything processed');
  }
  t.end();
});

test('jobs are processed in the original enqueue order across a catch-up run', async (t) => {
  // Insert out of order; enqueue order is defined by initiatedAt.
  const rows = [row(5), row(2), row(9), row(1), row(7), row(3)];
  const { prisma, batches, findManyArgs } = setup(rows);

  await runSettlementBatching(prisma, { ...config, maxBatchSize: 4 }, T0, log, T0 + 5 * INTERVAL_MS);

  t.deepEqual(
    findManyArgs[0].orderBy,
    [{ initiatedAt: 'asc' }, { id: 'asc' }],
    'oldest first, id as tiebreaker',
  );
  t.deepEqual(batches[0].ids, ['s001', 's002', 's003', 's005'], 'the four oldest, in enqueue order');
  t.end();
});

test('a pause longer than one interval does not skip queued work', async (t) => {
  const rows = Array.from({ length: 7 }, (_, i) => row(i));
  const { prisma } = setup(rows);
  const cfg = { ...config, minCount: 1, maxBatchSize: 3 };

  let last = T0;
  let processed = 0;
  // Worker was paused for 4 intervals; subsequent runs drain the backlog.
  let now = T0 + 4 * INTERVAL_MS;
  for (let run = 0; run < 3; run++) {
    const result = await runSettlementBatching(prisma, cfg, last, log, now);
    processed += result.batched;
    last = now;
    now += INTERVAL_MS;
  }

  t.equal(processed, 7, 'every queued item eventually processed');
  t.ok(rows.every((r) => r.status === 'processing'), 'none left pending');
  t.end();
});

test('an empty queue is a no-op run reporting zero processed', async (t) => {
  const { prisma, batches } = setup([]);
  const result = await runSettlementBatching(prisma, config, T0, log, T0 + INTERVAL_MS);

  t.equal(result.batched, 0, 'zero processed');
  t.equal(batches.length, 0, 'no batch created');
  t.deepEqual(result.assets, [], 'no assets touched');
  t.end();
});

test('assets below the count and volume thresholds are left pending', async (t) => {
  const rows = [row(1, 'USDC'), row(2, 'USDC'), row(3, 'EURT')];
  const { prisma, batches } = setup(rows);

  const result = await runSettlementBatching(prisma, config, T0, log, T0);

  t.equal(result.batched, 2, 'only USDC met the minimum count');
  t.equal(batches.length, 1, 'one batch');
  t.equal(rows[2].status, 'pending', 'EURT stays pending');
  t.end();
});

test('claimBatchForProcessing throws BatchAlreadyProcessedError on a duplicate claim', async (t) => {
  let claimed = false;
  const prisma = {
    $executeRaw: async () => {
      if (claimed) return 0;
      claimed = true;
      return 1;
    },
    settlementBatch: {
      findUnique: async () => ({ processedAt: new Date(T0) }),
    },
  } as any;

  t.equal(await claimBatchForProcessing(prisma, 'batch_1'), true, 'first claim succeeds');
  try {
    await claimBatchForProcessing(prisma, 'batch_1');
    t.fail('duplicate claim should throw');
  } catch (err) {
    t.ok(err instanceof BatchAlreadyProcessedError, 'duplicate claim raises BatchAlreadyProcessedError');
    t.match((err as Error).message, /batch_1/, 'message names the batch');
  }
  t.end();
});
