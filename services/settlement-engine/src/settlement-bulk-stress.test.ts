import test from 'tape';
import { fastify, prisma, closeTestResources } from './index.js';
import { MOCK_MERCHANT_STANDARD } from './test-fixtures.js';
import { getAssetPrecision, isSupportedAsset } from './settlement-properties.js';

// Setup environment variable for tests
process.env.NODE_ENV = 'test';

function resetMocks() {
  prisma.merchant.findUnique = async () => null;
  prisma.$queryRaw = async () => [{ sum: null }];
  prisma.$transaction = async (cb: any) => cb(prisma);
  prisma.settlement.create = async (args: any) => args.data;
  prisma.settlement.findMany = async () => [];
}

test('bulk-stress: support property functions checks', (t) => {
  t.ok(isSupportedAsset('USDC'));
  t.ok(isSupportedAsset('XLM'));
  t.notOk(isSupportedAsset('INVALID_ASSET'));

  const usdcConfig = getAssetPrecision('USDC');
  t.equal(usdcConfig.decimals, 7);
  t.equal(usdcConfig.roundingMode, 'down');

  const fallbackConfig = getAssetPrecision('UNKNOWN');
  t.equal(fallbackConfig.decimals, 2);
  t.end();
});

test('bulk-stress: handles validation performance check with 100 items', async (t) => {
  resetMocks();
  prisma.merchant.findUnique = async () => MOCK_MERCHANT_STANDARD as any;

  // Generate 100 items
  const settlements = Array.from({ length: 100 }, (_, i) => ({
    amount: (10.0 + i).toFixed(2),
    asset: 'USDC',
  }));

  const startTime = Date.now();

  const res = await fastify.inject({
    method: 'POST',
    url: '/api/settlements/bulk',
    payload: {
      merchantId: MOCK_MERCHANT_STANDARD.id,
      settlements,
    },
  });

  const duration = Date.now() - startTime;
  t.equal(res.statusCode, 201);
  const body = JSON.parse(res.body);
  t.equal(body.data.created, 100);
  t.ok(duration < 2000, `processing 100 settlements took ${duration}ms, must be < 2000ms`);
  t.end();
});

test('bulk-stress: process large batches with mixed valid and invalid entries', async (t) => {
  resetMocks();
  prisma.merchant.findUnique = async () => MOCK_MERCHANT_STANDARD as any;

  const settlements: any[] = [];
  // 50 valid, 50 invalid
  for (let i = 0; i < 50; i++) {
    settlements.push({ amount: '150.00', asset: 'USDC' }); // Valid
    settlements.push({ amount: '-50.00', asset: 'USDC' }); // Invalid
  }

  const res = await fastify.inject({
    method: 'POST',
    url: '/api/settlements/bulk',
    payload: {
      merchantId: MOCK_MERCHANT_STANDARD.id,
      settlements,
    },
  });

  t.equal(res.statusCode, 201);
  const body = JSON.parse(res.body);
  t.equal(body.data.total, 100);
  t.equal(body.data.created, 50);
  t.equal(body.data.errors.length, 50);
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
