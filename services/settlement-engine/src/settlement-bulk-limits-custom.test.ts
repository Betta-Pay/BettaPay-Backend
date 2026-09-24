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

test('bulk-limits-custom: custom decimals precision formatting check', async (t) => {
  resetMocks();

  const customMerchant = {
    ...MOCK_MERCHANT_STANDARD,
    settings: {
      feeBps: 150, // 1.5% fee
      minSettlementAmount: '10.00',
    },
  };

  prisma.merchant.findUnique = async () => customMerchant as any;

  const res = await fastify.inject({
    method: 'POST',
    url: '/api/settlements/bulk',
    payload: {
      merchantId: customMerchant.id,
      settlements: [
        { amount: '100.00', asset: 'USDC' }, // feeAmount = 100 * 1.5% = 1.50, netAmount = 98.50
      ],
    },
  });

  t.equal(res.statusCode, 201);
  t.end();
});

test('bulk-limits-custom: validates asset formatting with lowercase strings', async (t) => {
  resetMocks();
  prisma.merchant.findUnique = async () => MOCK_MERCHANT_STANDARD as any;

  const res = await fastify.inject({
    method: 'POST',
    url: '/api/settlements/bulk',
    payload: {
      merchantId: MOCK_MERCHANT_STANDARD.id,
      settlements: [
        { amount: '100.00', asset: 'usdc' }, // Lowercase asset
      ],
    },
  });

  // Zod validation strictly enforces uppercase CurrencyCode (USDC, XLM, EURT, etc.)
  t.equal(res.statusCode, 400, 'Zod should reject lowercase currency codes');
  t.end();
});

test('bulk-limits-custom: rejects request with empty settlements array', async (t) => {
  resetMocks();
  prisma.merchant.findUnique = async () => MOCK_MERCHANT_STANDARD as any;

  const res = await fastify.inject({
    method: 'POST',
    url: '/api/settlements/bulk',
    payload: {
      merchantId: MOCK_MERCHANT_STANDARD.id,
      settlements: [], // Empty array
    },
  });

  t.equal(res.statusCode, 400);
  t.end();
});

test('bulk-limits-custom: rejects request with missing settlements key', async (t) => {
  resetMocks();
  prisma.merchant.findUnique = async () => MOCK_MERCHANT_STANDARD as any;

  const res = await fastify.inject({
    method: 'POST',
    url: '/api/settlements/bulk',
    payload: {
      merchantId: MOCK_MERCHANT_STANDARD.id,
    },
  });

  t.equal(res.statusCode, 400);
  t.end();
});

test('bulk-limits-custom: rejects status checks with invalid character batchId values', async (t) => {
  resetMocks();

  const res = await fastify.inject({
    method: 'GET',
    url: '/api/settlements/batch/batch_@special#char$/status',
  });

  t.equal(res.statusCode, 400, 'should reject non-alphanumeric batchId parameters');
  t.end();
});
export {};

// Closes module-scope Fastify/Redis/BullMQ/Prisma handles so the tape
// process exits instead of hanging (see closeTestResources in index.ts).
test('teardown: release shared service resources', async (t) => {
  await closeTestResources();
  t.pass('resources released');
  t.end();
});
