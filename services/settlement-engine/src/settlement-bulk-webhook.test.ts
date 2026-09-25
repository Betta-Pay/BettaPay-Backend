import test from 'tape';
import { fastify, prisma, settlementQueue, closeTestResources } from './index.js';
import { MOCK_MERCHANT_STANDARD, BATCH_VALID_STANDARD } from './test-fixtures.js';

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
}

test('bulk-webhook: verifies webhookUrl is correctly propagated from merchant settings on creation', async (t) => {
  resetMocks();

  const createdRecords: any[] = [];
  
  // Custom merchant with fee rule and webhook configuration
  const customMerchant = {
    ...MOCK_MERCHANT_STANDARD,
    settings: {
      feeBps: 120,
      webhookUrl: 'https://api.merchant.com/webhooks/bettapay',
    },
  };

  prisma.merchant.findUnique = async () => customMerchant as any;
  
  prisma.settlement.create = async (args: any) => {
    createdRecords.push(args.data);
    return args.data;
  };

  const res = await fastify.inject({
    method: 'POST',
    url: '/api/settlements/bulk',
    headers: AUTH_HEADER,
    payload: {
      merchantId: customMerchant.id,
      settlements: [
        { amount: '100.00', asset: 'USDC' },
      ],
    },
  });

  t.equal(res.statusCode, 201);
  t.equal(createdRecords.length, 1);
  t.equal(createdRecords[0].webhookUrl, 'https://api.merchant.com/webhooks/bettapay', 'webhookUrl should be populated in DB record');
  t.equal(createdRecords[0].feeBps, 120, 'feeBps should match merchant settings');
  t.end();
});

test('bulk-webhook: checks webhookUrl is null when merchant has no webhook configured', async (t) => {
  resetMocks();

  const createdRecords: any[] = [];
  const simpleMerchant = {
    ...MOCK_MERCHANT_STANDARD,
    settings: {
      feeBps: 100,
    },
  };

  prisma.merchant.findUnique = async () => simpleMerchant as any;
  prisma.settlement.create = async (args: any) => {
    createdRecords.push(args.data);
    return args.data;
  };

  const res = await fastify.inject({
    method: 'POST',
    url: '/api/settlements/bulk',
    headers: AUTH_HEADER,
    payload: {
      merchantId: simpleMerchant.id,
      settlements: [
        { amount: '100.00', asset: 'USDC' },
      ],
    },
  });

  t.equal(res.statusCode, 201);
  t.equal(createdRecords[0].webhookUrl, null, 'webhookUrl should be null');
  t.end();
});

// #569 — custom webhook headers (idempotency keys, auth tokens, etc.) configured
// via merchant settings must be captured onto the Settlement row alongside the
// URL, so the delivery worker can replay them on every retry attempt.
test('bulk-webhook: verifies webhookHeaders is correctly propagated from merchant settings on creation', async (t) => {
  resetMocks();

  const createdRecords: any[] = [];

  const customMerchant = {
    ...MOCK_MERCHANT_STANDARD,
    settings: {
      feeBps: 120,
      webhookUrl: 'https://api.merchant.com/webhooks/bettapay',
      webhookHeaders: { 'Idempotency-Key': 'idem_abc123', 'X-Merchant-Auth': 'Bearer merchant-token' },
    },
  };

  prisma.merchant.findUnique = async () => customMerchant as any;

  prisma.settlement.create = async (args: any) => {
    createdRecords.push(args.data);
    return args.data;
  };

  const res = await fastify.inject({
    method: 'POST',
    url: '/api/settlements/bulk',
    headers: AUTH_HEADER,
    payload: {
      merchantId: customMerchant.id,
      settlements: [
        { amount: '100.00', asset: 'USDC' },
      ],
    },
  });

  t.equal(res.statusCode, 201);
  t.equal(createdRecords.length, 1);
  t.same(
    createdRecords[0].webhookHeaders,
    { 'Idempotency-Key': 'idem_abc123', 'X-Merchant-Auth': 'Bearer merchant-token' },
    'webhookHeaders should be populated in DB record',
  );
  t.end();
});

test('bulk-webhook: rejects a reserved header name from merchant settings (does not propagate)', async (t) => {
  resetMocks();

  const createdRecords: any[] = [];

  const merchantWithBadHeaders = {
    ...MOCK_MERCHANT_STANDARD,
    settings: {
      feeBps: 100,
      webhookUrl: 'https://api.merchant.com/webhooks/bettapay',
      // Content-Type is reserved — the worker always controls it, and the
      // API-layer schema rejects it too, so a hand-edited settings blob
      // containing it must not be trusted at delivery time either.
      webhookHeaders: { 'Content-Type': 'text/plain' },
    },
  };

  prisma.merchant.findUnique = async () => merchantWithBadHeaders as any;
  prisma.settlement.create = async (args: any) => {
    createdRecords.push(args.data);
    return args.data;
  };

  const res = await fastify.inject({
    method: 'POST',
    url: '/api/settlements/bulk',
    headers: AUTH_HEADER,
    payload: {
      merchantId: merchantWithBadHeaders.id,
      settlements: [
        { amount: '100.00', asset: 'USDC' },
      ],
    },
  });

  t.equal(res.statusCode, 201);
  t.equal(createdRecords[0].webhookHeaders, undefined, 'reserved header name is dropped, not propagated');
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
