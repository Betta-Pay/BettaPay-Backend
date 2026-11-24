import test from 'tape';
import { fastify, prisma, settlementQueue, closeTestResources } from './index.js';

process.env.NODE_ENV = 'test';

const AUTH_HEADER = {
  'x-service-token': process.env.INTER_SERVICE_SECRET || 'dev-inter-service-secret',
};

const original = {
  id: 'set_failed_original',
  merchantId: 'merchant-1',
  totalAmount: '100',
  grossAmount: '100',
  feeAmount: '1',
  netAmount: '99',
  feeBps: 100,
  asset: 'USDC',
  status: 'failed',
  version: 3,
  webhookUrl: null,
  webhookHeaders: null,
  feeSnapshot: null,
  supersededById: null,
};

/**
 * Installs an in-memory stand-in for the settlement table with transaction
 * semantics: rows written inside `$transaction` are discarded if the callback
 * throws, mirroring a database rollback.
 */
function installFakeDb(parentUpdateCount: number) {
  const rows: Array<Record<string, any>> = [{ ...original }];
  const p = prisma as any;
  const savedFindUnique = p.settlement.findUnique;
  const savedFindMany = p.settlement.findMany;
  const savedTransaction = p.$transaction;

  p.settlement.findUnique = async (args: any) => {
    if (args.select) return { supersededById: null };
    return rows.find((r) => r.id === args.where.id) ?? null;
  };
  p.settlement.findMany = async () => [];
  p.$transaction = async (fn: (tx: any) => Promise<unknown>) => {
    const snapshot = rows.map((r) => ({ ...r }));
    const tx = {
      settlement: {
        create: async ({ data }: any) => {
          const row = { ...data, version: 0 };
          rows.push(row);
          return row;
        },
        updateMany: async () => ({ count: parentUpdateCount }),
        findUnique: async ({ where }: any) => rows.find((r) => r.id === where.id) ?? null,
      },
    };
    try {
      return await fn(tx);
    } catch (err) {
      rows.length = 0;
      rows.push(...snapshot);
      throw err;
    }
  };

  return {
    rows,
    restore() {
      p.settlement.findUnique = savedFindUnique;
      p.settlement.findMany = savedFindMany;
      p.$transaction = savedTransaction;
    },
  };
}

test('retry: VersionConflictError returns 409 and leaves no orphaned settlement', async (t) => {
  const db = installFakeDb(0); // parent update matches zero rows => VersionConflictError
  const queued: unknown[] = [];
  const savedAdd = settlementQueue.add.bind(settlementQueue);
  (settlementQueue as any).add = async (...args: unknown[]) => {
    queued.push(args);
    return {};
  };

  try {
    const res = await fastify.inject({
      method: 'POST',
      url: `/api/settlements/${original.id}/retry`,
      headers: AUTH_HEADER,
    });

    t.equal(res.statusCode, 409, 'returns HTTP 409 on version conflict');
    t.equal(db.rows.length, 1, 'no orphaned settlement rows remain');
    t.equal(db.rows[0].id, original.id, 'only the original settlement is left');
    t.equal(db.rows[0].supersededById, null, 'original is not linked to a retry');
    t.equal(queued.length, 0, 'nothing is enqueued for processing');
  } finally {
    (settlementQueue as any).add = savedAdd;
    db.restore();
  }
  t.end();
});

test('retry: successful retry creates the new settlement and enqueues it', async (t) => {
  const db = installFakeDb(1);
  const queued: unknown[] = [];
  const savedAdd = settlementQueue.add.bind(settlementQueue);
  (settlementQueue as any).add = async (...args: unknown[]) => {
    queued.push(args);
    return {};
  };

  try {
    const res = await fastify.inject({
      method: 'POST',
      url: `/api/settlements/${original.id}/retry`,
      headers: AUTH_HEADER,
    });

    t.equal(res.statusCode, 201, 'returns HTTP 201');
    t.equal(db.rows.length, 2, 'new settlement row is persisted');
    t.equal(queued.length, 1, 'new settlement is enqueued');
  } finally {
    (settlementQueue as any).add = savedAdd;
    db.restore();
  }
  t.end();
});

test('teardown: release shared service resources', async (t) => {
  await closeTestResources();
  t.pass('resources released');
  t.end();
});
