import test from 'tape';
import { fastify, prisma, closeTestResources } from './index.js';
import { MOCK_MERCHANT_STANDARD, BATCH_VALID_STANDARD } from './test-fixtures.js';

// Setup environment variable for tests
process.env.NODE_ENV = 'test';

function resetMocks() {
  prisma.merchant.findUnique = async () => null;
  prisma.$queryRaw = async () => [{ sum: null }];
  prisma.$transaction = async (cb: any) => cb(prisma);
  prisma.settlement.create = async (args: any) => args.data;
  prisma.settlement.findMany = async () => [];
}

test('bulk-errors: returns 404 on merchant lookup database error', async (t) => {
  resetMocks();
  prisma.merchant.findUnique = async () => {
    throw new Error('Database lookup failure');
  };

  const res = await fastify.inject({
    method: 'POST',
    url: '/api/settlements/bulk',
    payload: {
      merchantId: MOCK_MERCHANT_STANDARD.id,
      settlements: BATCH_VALID_STANDARD,
    },
  });

  t.equal(res.statusCode, 500, 'database query throws should bubble up as 500');
  t.end();
});

test('bulk-errors: handles queryRaw throwing connection errors on daily aggregate calculation', async (t) => {
  resetMocks();
  prisma.merchant.findUnique = async () => MOCK_MERCHANT_STANDARD as any;
  prisma.$queryRaw = async () => {
    throw new Error('Connection lost');
  };

  const res = await fastify.inject({
    method: 'POST',
    url: '/api/settlements/bulk',
    payload: {
      merchantId: MOCK_MERCHANT_STANDARD.id,
      settlements: BATCH_VALID_STANDARD,
    },
  });

  t.equal(res.statusCode, 500);
  t.end();
});

test('bulk-errors: handles transaction rollback on batch insertion database crash', async (t) => {
  resetMocks();
  prisma.merchant.findUnique = async () => MOCK_MERCHANT_STANDARD as any;
  
  prisma.$transaction = async () => {
    throw new Error('Unique constraint check crash');
  };

  const res = await fastify.inject({
    method: 'POST',
    url: '/api/settlements/bulk',
    payload: {
      merchantId: MOCK_MERCHANT_STANDARD.id,
      settlements: BATCH_VALID_STANDARD,
    },
  });

  t.equal(res.statusCode, 500);
  t.end();
});

test('bulk-errors: rejects malformed payload layout with 400', async (t) => {
  resetMocks();

  const res = await fastify.inject({
    method: 'POST',
    url: '/api/settlements/bulk',
    payload: {
      merchantId: '', // invalid format
      settlements: [
        { amount: '', asset: 'USDC' }, // empty amount
      ],
    },
  });

  t.equal(res.statusCode, 400);
  const body = JSON.parse(res.body);
  t.equal(body.error.code, 'VALIDATION_ERROR');
  t.end();
});

test('bulk-errors: status checks fail on malformed batchId', async (t) => {
  resetMocks();

  const res = await fastify.inject({
    method: 'GET',
    url: '/api/settlements/batch/invalid_batch_format_123/status',
  });

  t.equal(res.statusCode, 400);
  const body = JSON.parse(res.body);
  t.equal(body.error.code, 'VALIDATION_ERROR');
  t.equal(body.error.message, 'Invalid batchId format');
  t.end();
});

// Closes module-scope Fastify/Redis/BullMQ/Prisma handles so the tape
// process exits instead of hanging (see closeTestResources in index.ts).
test('teardown: release shared service resources', async (t) => {
  await closeTestResources();
  t.pass('resources released');
  t.end();
});
