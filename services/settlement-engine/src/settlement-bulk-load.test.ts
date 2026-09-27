import test from 'tape';
import { fastify, prisma, closeTestResources } from './index.js';
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
}

test('bulk-load: processing multiple batches sequentially to verify state memory cleanliness', async (t) => {
  resetMocks();
  prisma.merchant.findUnique = async () => MOCK_MERCHANT_STANDARD as any;

  // Run 10 consecutive bulk batches
  for (let batchIndex = 1; batchIndex <= 10; batchIndex++) {
    const settlements = [
      { amount: (10 * batchIndex).toFixed(2), asset: 'USDC' },
      { amount: (15 * batchIndex).toFixed(2), asset: 'USDC' },
    ];

    const res = await fastify.inject({
      method: 'POST',
      url: '/api/settlements/bulk',
      headers: AUTH_HEADER,
      payload: {
        merchantId: MOCK_MERCHANT_STANDARD.id,
        settlements,
      },
    });

    t.equal(res.statusCode, 201, `batch ${batchIndex} processes successfully`);
    const body = JSON.parse(res.body);
    t.equal(body.data.total, 2);
    t.equal(body.data.created, 2);
    t.equal(body.data.errors.length, 0);
  }
  t.end();
});

test('bulk-load: aggregate daily limit depletion validation with sequence iterations', async (t) => {
  resetMocks();
  prisma.merchant.findUnique = async () => MOCK_MERCHANT_STANDARD as any;

  let currentDailyAggregate = 9500.00; // Standard limit is 10000.00, only 500.00 left
  prisma.$queryRaw = async () => [{ sum: currentDailyAggregate.toString() }];

  // 1. Submit batch of items
  const res1 = await fastify.inject({
    method: 'POST',
    url: '/api/settlements/bulk',
    headers: AUTH_HEADER,
    payload: {
      merchantId: MOCK_MERCHANT_STANDARD.id,
      settlements: [
        { amount: '200.00', asset: 'USDC' }, // Fits (9500+200 = 9700 <= 10000)
        { amount: '400.00', asset: 'USDC' }, // Violates cumulative limit (9700+400 = 10100 > 10000)
      ],
    },
  });

  t.equal(res1.statusCode, 201);
  const body1 = JSON.parse(res1.body);
  t.equal(body1.created, 1);
  t.equal(body1.errors.length, 1);
  t.equal(body1.errors[0].index, 1);

  // 2. Submit another batch assuming the first item was committed (so pre-existing aggregate increases by 200.00)
  currentDailyAggregate += 200.00; // 9700.00
  prisma.$queryRaw = async () => [{ sum: currentDailyAggregate.toString() }];

  const res2 = await fastify.inject({
    method: 'POST',
    url: '/api/settlements/bulk',
    headers: AUTH_HEADER,
    payload: {
      merchantId: MOCK_MERCHANT_STANDARD.id,
      settlements: [
        { amount: '250.00', asset: 'USDC' }, // Fits (9700+250 = 9950 <= 10000)
        { amount: '100.00', asset: 'USDC' }, // Violates cumulative limit (9950+100 = 10050 > 10000)
      ],
    },
  });

  t.equal(res2.statusCode, 201);
  const body2 = JSON.parse(res2.body);
  t.equal(body2.created, 1);
  t.equal(body2.errors.length, 1);
  t.equal(body2.errors[0].index, 1);

  t.end();
});

test('bulk-load: verify invalid asset type rejections inside bulk collection', async (t) => {
  resetMocks();
  prisma.merchant.findUnique = async () => MOCK_MERCHANT_STANDARD as any;

  const res = await fastify.inject({
    method: 'POST',
    url: '/api/settlements/bulk',
    headers: AUTH_HEADER,
    payload: {
      merchantId: MOCK_MERCHANT_STANDARD.id,
      settlements: [
        { amount: '150.00', asset: 'UNSUPPORTED_ASSET' }, // Invalid asset
        { amount: '100.00', asset: 'USDC' }, // Valid asset
      ],
    },
  });

  // Although the asset is unsupported, schema validation requires a valid CurrencyCode.
  // Zod validation should fail the entire request return 400 validation error
  t.equal(res.statusCode, 400, 'Zod fails payload on invalid CurrencyCode asset');
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
