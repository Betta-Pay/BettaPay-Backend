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
  const batches: { id: string; asset: string; ids: string[]; totalGross?: string; totalFees?: string; totalNet?: string }[] = [];
  const findManyArgs: any[] = [];
  const prisma = {
    $transaction: async (cb: any) => cb(prisma),
    settlement: {
      findMany: async (args: any) => {
        findManyArgs.push(args);
        let found = rows.filter((r) => {
          if (args.where.status && r.status !== args.where.status) return false;
          if (args.where.batchId === null && (r as any).batchId !== undefined && (r as any).batchId !== null) return false;
          return true;
        });
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
        let count = 0;
        for (const r of rows) {
          if (ids.includes(r.id)) {
            if (args.where.status && r.status !== args.where.status) continue;
            if (args.where.batchId === null && (r as any).batchId !== undefined && (r as any).batchId !== null) continue;
            r.status = args.data.status;
            (r as any).batchId = args.data.batchId;
            count++;
          }
        }
        if (batches.length > 0) {
          batches[batches.length - 1].ids.push(...ids);
        }
        return { count };
      },
    },
    settlementBatch: {
      create: async (args: any) => {
        const batch = {
          id: `b${batches.length + 1}`,
          asset: args.data.asset,
          ids: [] as string[],
          totalGross: args.data.totalGross,
          totalFees: args.data.totalFees,
          totalNet: args.data.totalNet,
        };
        batches.push(batch);
        return batch;
      },
      updateMany: async (args: any) => {
        return { count: 1 };
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

test('claimBatchForProcessing returns null when updateMany.count === 0', async (t) => {
  let claimed = false;
  let findUniqueCalls = 0;
  const prisma = {
    settlementBatch: {
      updateMany: async () => {
        if (claimed) return { count: 0 };
        claimed = true;
        return { count: 1 };
      },
      findUnique: async () => {
        findUniqueCalls++;
        return { processedAt: new Date(T0) };
      },
    },
  } as any;

  t.equal(await claimBatchForProcessing(prisma, 'batch_1'), true, 'first claim succeeds');
  const secondClaim = await claimBatchForProcessing(prisma, 'batch_1');
  t.equal(secondClaim, null, 'second claim returns null immediately without throwing');
  t.equal(findUniqueCalls, 0, 'did not call findUnique when count === 0');
  t.end();
});

test('claimBatchForProcessing concurrency: two concurrent callers never receive the same claimed batch', async (t) => {
  let claimed = false;
  const prisma = {
    settlementBatch: {
      updateMany: async () => {
        // Atomic check-and-set: only one caller wins
        if (claimed) return { count: 0 };
        claimed = true;
        return { count: 1 };
      },
    },
  } as any;

  const [resA, resB] = await Promise.all([
    claimBatchForProcessing(prisma, 'batch_concurrent'),
    claimBatchForProcessing(prisma, 'batch_concurrent'),
  ]);

  const successCount = [resA, resB].filter((r) => r === true).length;
  const nullCount = [resA, resB].filter((r) => r === null).length;

  t.equal(successCount, 1, 'exactly one worker receives the claimed batch');
  t.equal(nullCount, 1, 'the other worker receives null');
  t.end();
});

test('concurrent runSettlementBatching invocations cannot double-assign settlements with Redis lock', async (t) => {
  const rows = [row(1, 'USDC'), row(2, 'USDC')];
  const { prisma, batches } = setup(rows);

  let lockHolder: string | null = null;
  const mockRedis = {
    set: async (_key: string, val: string, _px: string, _ttl: number, _nx: string) => {
      if (lockHolder !== null) {
        return null; // lock already held
      }
      lockHolder = val;
      return 'OK';
    },
    eval: async (_script: string, _keysCount: number, _key: string, val: string) => {
      if (lockHolder === val) {
        lockHolder = null;
        return 1;
      }
      return 0;
    },
  };

  // Run two invocations concurrently
  const [res1, res2] = await Promise.all([
    runSettlementBatching(prisma, { ...config, redis: mockRedis }, T0, log, T0),
    runSettlementBatching(prisma, { ...config, redis: mockRedis }, T0, log, T0),
  ]);

  const batchedCounts = [res1.batched, res2.batched].sort((a, b) => b - a);
  t.deepEqual(batchedCounts, [2, 0], 'one invocation batched all 2, the locked invocation batched 0');
  t.equal(batches.length, 1, 'only one batch created');
  t.end();
});

test('runSettlementBatching never attaches non-pending or already-batched settlements to a batch', async (t) => {
  const pendingRow = row(1, 'USDC');
  const alreadyBatchedRow = { ...row(2, 'USDC'), batchId: 'batch-existing' };
  const processingRow = { ...row(3, 'USDC'), status: 'processing' };
  const completedRow = { ...row(4, 'USDC'), status: 'completed' };

  const rows = [pendingRow, alreadyBatchedRow, processingRow, completedRow];
  const { prisma, batches } = setup(rows);

  const result = await runSettlementBatching(
    prisma,
    { ...config, minCount: 1 },
    T0,
    log,
    T0,
  );

  t.equal(result.batched, 1, 'only the truly pending settlement without batchId was batched');
  t.equal(batches.length, 1, 'one batch created');
  t.deepEqual(batches[0].ids, ['s001'], 'only s001 attached to batch');
  t.equal(alreadyBatchedRow.batchId, 'batch-existing', 'already batched settlement left untouched');
  t.end();
});

test('runSettlementBatching formats aggregated batch totals with fixed-decimal without scientific notation', async (t) => {
  // Very small fractional amounts and large amounts that would trigger scientific notation with .toString()
  const microRow: Row = {
    id: 'micro-1',
    asset: 'USDC',
    status: 'pending',
    initiatedAt: new Date(T0),
    grossAmount: '0.00000001',
    feeAmount: '0.000000001',
    netAmount: '0.000000009',
  };
  const microRow2: Row = {
    id: 'micro-2',
    asset: 'USDC',
    status: 'pending',
    initiatedAt: new Date(T0 + 1000),
    grossAmount: '0.00000002',
    feeAmount: '0.000000002',
    netAmount: '0.000000018',
  };

  const rows = [microRow, microRow2];
  const { prisma, batches } = setup(rows);

  await runSettlementBatching(prisma, { ...config, minCount: 2 }, T0, log, T0);

  t.equal(batches.length, 1, 'batch created');
  const batch = batches[0];
  t.notOk(batch.totalGross?.includes('e'), 'totalGross does not contain scientific notation');
  t.notOk(batch.totalFees?.includes('e'), 'totalFees does not contain scientific notation');
  t.notOk(batch.totalNet?.includes('e'), 'totalNet does not contain scientific notation');
  t.equal(batch.totalGross, '0.00000003', 'totalGross formatted as exact decimal string');
  t.end();
});
