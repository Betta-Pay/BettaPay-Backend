import test from 'tape';
import { fastify, prisma, closeTestResources } from './index.js';
import { MOCK_MERCHANT_STANDARD } from './test-fixtures.js';

// Setup environment variable for tests
process.env.NODE_ENV = 'test';

function resetMocks() {
  prisma.merchant.findUnique = async () => null;
  prisma.$queryRaw = async () => [{ sum: null }];
  prisma.$transaction = async (cb: any) => cb(prisma);
  prisma.settlement.create = async (args: any) => args.data;
  prisma.settlement.findMany = async () => [];
}

test('bulk-extensive: validation loop for various positive amounts', async (t) => {
  resetMocks();
  prisma.merchant.findUnique = async () => MOCK_MERCHANT_STANDARD as any;

  // Verify a series of 20 valid amount variations
  for (let i = 1; i <= 20; i++) {
    const amount = (i * 15.5).toFixed(2);
    const res = await fastify.inject({
      method: 'POST',
      url: '/api/settlements/bulk',
      payload: {
        merchantId: MOCK_MERCHANT_STANDARD.id,
        settlements: [{ amount, asset: 'USDC' }],
      },
    });
    
    t.equal(res.statusCode, 201, `amount ${amount} should pass standard validation`);
    const body = JSON.parse(res.body);
    t.equal(body.data.created, 1);
    t.equal(body.data.errors.length, 0);
  }
  t.end();
});

test('bulk-extensive: validation loop for various invalid amounts', async (t) => {
  resetMocks();
  prisma.merchant.findUnique = async () => MOCK_MERCHANT_STANDARD as any;

  const invalidAmounts = [
    '-1.00', '0.00', 'not-a-number', '12abc', '   ', '', '1.2.3', 'NaN', 'undefined', 'null'
  ];

  for (const amount of invalidAmounts) {
    const res = await fastify.inject({
      method: 'POST',
      url: '/api/settlements/bulk',
      payload: {
        merchantId: MOCK_MERCHANT_STANDARD.id,
        settlements: [{ amount, asset: 'USDC' }],
      },
    });

    t.equal(res.statusCode, 201, `amount ${amount} should process with validation error`);
    const body = JSON.parse(res.body);
    t.equal(body.data.created, 0);
    t.equal(body.data.errors.length, 1);
    t.equal(body.data.errors[0].reason, 'amount must be greater than zero');
  }
  t.end();
});

test('bulk-extensive: batch limit checks on border value 100', async (t) => {
  resetMocks();
  prisma.merchant.findUnique = async () => MOCK_MERCHANT_STANDARD as any;

  const settlements = Array.from({ length: 100 }, () => ({
    amount: '20.00',
    asset: 'USDC',
  }));

  const res = await fastify.inject({
    method: 'POST',
    url: '/api/settlements/bulk',
    payload: {
      merchantId: MOCK_MERCHANT_STANDARD.id,
      settlements,
    },
  });

  t.equal(res.statusCode, 201, 'should accept exactly 100 items');
  const body = JSON.parse(res.body);
  t.equal(body.data.total, 100);
  t.equal(body.data.created, 100);
  t.end();
});

test('bulk-extensive: merchant rules fallback values verification', async (t) => {
  resetMocks();
  
  // Merchant has null settings
  prisma.merchant.findUnique = async () => ({
    id: 'merch_fallback',
    settings: null,
  } as any);

  const res = await fastify.inject({
    method: 'POST',
    url: '/api/settlements/bulk',
    payload: {
      merchantId: 'merch_fallback',
      settlements: [{ amount: '50.00', asset: 'USDC' }],
    },
  });

  t.equal(res.statusCode, 201);
  const body = JSON.parse(res.body);
  t.equal(body.data.created, 1, 'should fallback to default settings gracefully');
  t.end();
});

test('bulk-extensive: batch tracking overall status transitions validation', async (t) => {
  resetMocks();

  const batchId = 'batch_trans_test';

  // 1. All pending
  prisma.settlement.findMany = async () => [
    { id: 's1', status: 'pending', batchId },
    { id: 's2', status: 'pending', batchId },
  ] as any[];

  const res1 = await fastify.inject({
    method: 'GET',
    url: `/api/settlements/batch/${batchId}/status`,
  });
  t.equal(JSON.parse(res1.body).status, 'pending');

  // 2. All completed
  prisma.settlement.findMany = async () => [
    { id: 's1', status: 'completed', batchId },
    { id: 's2', status: 'completed', batchId },
  ] as any[];

  const res2 = await fastify.inject({
    method: 'GET',
    url: `/api/settlements/batch/${batchId}/status`,
  });
  t.equal(JSON.parse(res2.body).status, 'completed');

  // 3. All failed
  prisma.settlement.findMany = async () => [
    { id: 's1', status: 'failed', batchId },
    { id: 's2', status: 'failed', batchId },
  ] as any[];

  const res3 = await fastify.inject({
    method: 'GET',
    url: `/api/settlements/batch/${batchId}/status`,
  });
  t.equal(JSON.parse(res3.body).status, 'failed');

  t.end();
});

// Closes module-scope Fastify/Redis/BullMQ/Prisma handles so the tape
// process exits instead of hanging (see closeTestResources in index.ts).
test('teardown: release shared service resources', async (t) => {
  await closeTestResources();
  t.pass('resources released');
  t.end();
});
