import test from 'tape';
import { fastify, prisma, closeTestResources } from './index.js';

process.env.NODE_ENV = 'test';

const AUTH_TOKEN = process.env.INTER_SERVICE_SECRET || 'dev-inter-service-secret';
const AUTH_HEADER = { 'x-service-token': AUTH_TOKEN };

function status(batchId: string) {
  return fastify.inject({
    method: 'GET',
    url: `/api/settlements/batch/${batchId}/status`,
    headers: AUTH_HEADER,
  });
}

// ─── superseded counts ───────────────────────────────────────────────────────

test('batch status: superseded settlements are counted separately', async (t) => {
  prisma.settlement.findMany = async () =>
    [
      { id: 's1', status: 'completed', supersededById: null },
      { id: 's2', status: 'failed', supersededById: 'set_retry1' },
      { id: 's3', status: 'pending', supersededById: null },
    ] as any[];

  const res = await status('batch_abc123');
  t.equal(res.statusCode, 200, 'returns 200');
  const { data } = JSON.parse(res.body);
  t.equal(data.total, 3, 'total includes superseded');
  t.equal(data.superseded, 1, 'superseded count is reported');
  t.equal(data.failed, 0, 'superseded failure is not double-counted as failed');
  t.equal(data.completed, 1, 'completed count');
  t.equal(data.pending, 1, 'pending count');
  t.end();
});

test('batch status: batch is completed once all non-superseded settlements complete', async (t) => {
  prisma.settlement.findMany = async () =>
    [
      { id: 's1', status: 'completed', supersededById: null },
      { id: 's2', status: 'completed', supersededById: null },
      { id: 's3', status: 'failed', supersededById: 'set_retry1' },
    ] as any[];

  const res = await status('batch_abc123');
  const { data } = JSON.parse(res.body);
  t.equal(data.superseded, 1, 'superseded count');
  t.equal(data.status, 'completed', 'superseded failure does not block completion');
  t.end();
});

test('batch status: superseded is 0 when no settlement was superseded', async (t) => {
  prisma.settlement.findMany = async () =>
    [
      { id: 's1', status: 'pending', supersededById: null },
      { id: 's2', status: 'pending', supersededById: null },
    ] as any[];

  const res = await status('batch_abc123');
  const { data } = JSON.parse(res.body);
  t.equal(data.superseded, 0, 'superseded is present and 0');
  t.equal(data.status, 'pending', 'all pending → pending');
  t.end();
});

test('batch status: batch with every settlement superseded stays processing', async (t) => {
  prisma.settlement.findMany = async () =>
    [
      { id: 's1', status: 'failed', supersededById: 'set_r1' },
      { id: 's2', status: 'failed', supersededById: 'set_r2' },
    ] as any[];

  const res = await status('batch_abc123');
  const { data } = JSON.parse(res.body);
  t.equal(data.total, 2, 'total');
  t.equal(data.superseded, 2, 'all superseded');
  t.equal(data.failed, 0, 'none counted as failed');
  t.equal(data.status, 'processing', 'retries are still in flight');
  t.end();
});

// ─── :batchId validation ─────────────────────────────────────────────────────

test('batch status: invalid :batchId values return 400 and never hit the DB', async (t) => {
  let dbCalls = 0;
  prisma.settlement.findMany = async () => {
    dbCalls++;
    return [] as any[];
  };

  const invalid = [
    'not_a_batch',                 // missing batch_ prefix
    'batch_',                      // empty suffix
    'batch_%27%20OR%201%3D1',      // encoded quote / whitespace
    'batch_abc-123',               // hyphen not allowed
    'batch_%40special%23char%24',  // special chars
    `batch_${'a'.repeat(65)}`,     // over length bound
  ];

  for (const id of invalid) {
    const res = await status(id);
    t.equal(res.statusCode, 400, `rejects ${id}`);
  }
  t.equal(dbCalls, 0, 'no DB query was issued for any invalid id');
  t.end();
});

test('batch status: generated-style batchId (batch_ + 32 hex) is accepted', async (t) => {
  const id = 'batch_' + 'a1b2c3d4'.repeat(4);
  prisma.settlement.findMany = async (args: any) => {
    t.equal(args.where.batchId, id, 'validated id is used in the query');
    return [{ id: 's1', status: 'pending', supersededById: null }] as any[];
  };

  const res = await status(id);
  t.equal(res.statusCode, 200, 'returns 200');
  t.end();
});

test('teardown: release shared service resources', async (t) => {
  await closeTestResources();
  t.pass('resources released');
  t.end();
});
