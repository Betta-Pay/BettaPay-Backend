import test from 'tape';
import { fastify, prisma, settlementQueue, closeTestResources } from './index.js';
import { MOCK_MERCHANT_STANDARD } from './test-fixtures.js';

// Setup environment variable for tests
process.env.NODE_ENV = 'test';

const AUTH_TOKEN = process.env.INTER_SERVICE_SECRET || 'dev-inter-service-secret';
const AUTH_HEADER = { 'x-service-token': AUTH_TOKEN };

function resetMocks() {
  prisma.merchant.findUnique = async () => null;
  prisma.$queryRaw = async () => [{ sum: null }];
  prisma.$transaction = async (cb: any) => cb(prisma);
  prisma.settlement.create = async (args: any) => args.data;
  prisma.settlement.findMany = async () => [];
  settlementQueue.add = async () => ({} as any);
  settlementQueue.addBulk = async () => [] as any;
}

test('bulk-concurrency: multiple concurrent bulk requests for standard merchant', async (t) => {
  resetMocks();
  prisma.merchant.findUnique = async () => MOCK_MERCHANT_STANDARD as any;

  const testBatch = [
    { amount: '10.00', asset: 'USDC' },
    { amount: '20.00', asset: 'USDC' },
  ];

  // Trigger 5 concurrent fastify.inject calls
  const promises = Array.from({ length: 5 }, () =>
    fastify.inject({
      method: 'POST',
      url: '/api/settlements/bulk',
      headers: AUTH_HEADER,
      payload: {
        merchantId: MOCK_MERCHANT_STANDARD.id,
        settlements: testBatch,
      },
    })
  );

  const responses = await Promise.all(promises);

  for (const res of responses) {
    t.equal(res.statusCode, 201, 'all concurrent requests should be processed independently');
    const body = JSON.parse(res.body);
    t.equal(body.data.total, 2);
    t.equal(body.data.created, 2);
    t.equal(body.data.errors.length, 0);
  }

  t.end();
});

test('bulk-concurrency: concurrent status check and update simulations', async (t) => {
  resetMocks();
  
  const settlements = [
    { id: 's1', status: 'pending', batchId: 'batch_con1' },
    { id: 's2', status: 'completed', batchId: 'batch_con1' },
    { id: 's3', status: 'failed', batchId: 'batch_con1' },
  ];

  prisma.settlement.findMany = async (args: any) => {
    t.equal(args.where.batchId, 'batch_con1');
    return settlements as any[];
  };

  // Inject multiple concurrent status checks
  const promises = Array.from({ length: 10 }, () =>
    fastify.inject({
      method: 'GET',
      url: '/api/settlements/batch/batch_con1/status',
      headers: AUTH_HEADER,
    })
  );

  const responses = await Promise.all(promises);

  for (const res of responses) {
    t.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    t.equal(body.data.batchId, 'batch_con1');
    t.equal(body.data.total, 3);
    t.equal(body.data.pending, 1);
    t.equal(body.data.completed, 1);
    t.equal(body.data.failed, 1);
  }

  t.end();
});

test('bulk-concurrency: simultaneous limit depletion check scenario', async (t) => {
  resetMocks();
  prisma.merchant.findUnique = async () => MOCK_MERCHANT_STANDARD as any;

  let currentSum = 9000.00; // standard limit is 10000.00, only 1000.00 left
  prisma.$queryRaw = async () => [{ sum: currentSum.toString() }];

  const payload = {
    merchantId: MOCK_MERCHANT_STANDARD.id,
    settlements: [
      { amount: '600.00', asset: 'USDC' }, // Fits (current: 9000 + 600 = 9600 <= 10000)
      { amount: '500.00', asset: 'USDC' }, // Violates cumulative (current: 9600 + 500 = 10100 > 10000)
    ]
  };

  const res = await fastify.inject({
    method: 'POST',
    url: '/api/settlements/bulk',
    headers: AUTH_HEADER,
    payload,
  });

  t.equal(res.statusCode, 201);
  const body = JSON.parse(res.body);
  t.equal(body.data.total, 2);
  t.equal(body.data.created, 1);
  t.equal(body.data.errors.length, 1);
  t.equal(body.data.errors[0].index, 1);
  t.ok(body.data.errors[0].reason.includes('Daily settlement limit exceeded'));
  t.end();
});

// Closes module-scope Fastify/Redis/BullMQ/Prisma handles so the tape
// process exits instead of hanging (see closeTestResources in index.ts).
test('teardown: release shared service resources', async (t) => {
  await closeTestResources();
  t.pass('resources released');
  t.end();
});
