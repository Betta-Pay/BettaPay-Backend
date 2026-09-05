import test from 'tape';
import { fastify, prisma } from './index.js';
import {
  MOCK_MERCHANT_TIGHT_LIMITS,
} from './test-fixtures.js';

// Setup environment variable for tests
process.env.NODE_ENV = 'test';

function resetMocks() {
  prisma.merchant.findUnique = async () => null;
  prisma.$queryRaw = async () => [{ sum: null }];
  prisma.$transaction = async (cb: any) => cb(prisma);
  prisma.settlement.create = async (args: any) => args.data;
  prisma.settlement.findMany = async () => [];
}

test('bulk-limits: validates item below tight min limit', async (t) => {
  resetMocks();
  prisma.merchant.findUnique = async () => MOCK_MERCHANT_TIGHT_LIMITS as any;

  const res = await fastify.inject({
    method: 'POST',
    url: '/api/settlements/bulk',
    payload: {
      merchantId: MOCK_MERCHANT_TIGHT_LIMITS.id,
      settlements: [
        { amount: '4.99', asset: 'XLM' }, // Below min (5.00)
        { amount: '5.00', asset: 'XLM' }, // Exactly min
      ],
    },
  });

  t.equal(res.statusCode, 201);
  const body = JSON.parse(res.body);
  t.equal(body.total, 2);
  t.equal(body.created, 1);
  t.equal(body.errors.length, 1);
  t.equal(body.errors[0].index, 0);
  t.ok(body.errors[0].reason.includes('below minimum'));
  t.end();
});

test('bulk-limits: validates item above tight max limit', async (t) => {
  resetMocks();
  prisma.merchant.findUnique = async () => MOCK_MERCHANT_TIGHT_LIMITS as any;

  const res = await fastify.inject({
    method: 'POST',
    url: '/api/settlements/bulk',
    payload: {
      merchantId: MOCK_MERCHANT_TIGHT_LIMITS.id,
      settlements: [
        { amount: '100.00', asset: 'XLM' }, // Exactly max
        { amount: '100.01', asset: 'XLM' }, // Above max (100.00)
      ],
    },
  });

  t.equal(res.statusCode, 201);
  const body = JSON.parse(res.body);
  t.equal(body.total, 2);
  t.equal(body.created, 1);
  t.equal(body.errors.length, 1);
  t.equal(body.errors[0].index, 1);
  t.ok(body.errors[0].reason.includes('exceeds maximum'));
  t.end();
});

test('bulk-limits: daily limit aggregation on empty history', async (t) => {
  resetMocks();
  prisma.merchant.findUnique = async () => MOCK_MERCHANT_TIGHT_LIMITS as any;
  prisma.$queryRaw = async () => [{ sum: null }]; // No settlements today yet

  const res = await fastify.inject({
    method: 'POST',
    url: '/api/settlements/bulk',
    payload: {
      merchantId: MOCK_MERCHANT_TIGHT_LIMITS.id,
      settlements: [
        { amount: '90.00', asset: 'XLM' },
        { amount: '90.00', asset: 'XLM' },
        { amount: '30.00', asset: 'XLM' }, // Cumulative: 210.00, exceeds tight daily limit of 200.00
      ],
    },
  });

  t.equal(res.statusCode, 201);
  const body = JSON.parse(res.body);
  t.equal(body.total, 3);
  t.equal(body.created, 2);
  t.equal(body.errors.length, 1);
  t.equal(body.errors[0].index, 2);
  t.ok(body.errors[0].reason.includes('daily settlement limit exceeded'));
  t.end();
});

test('bulk-limits: daily limit aggregation with pre-existing settlements', async (t) => {
  resetMocks();
  prisma.merchant.findUnique = async () => MOCK_MERCHANT_TIGHT_LIMITS as any;
  prisma.$queryRaw = async () => [{ sum: '150.00' }]; // Already used 150.00 today

  const res = await fastify.inject({
    method: 'POST',
    url: '/api/settlements/bulk',
    payload: {
      merchantId: MOCK_MERCHANT_TIGHT_LIMITS.id,
      settlements: [
        { amount: '40.00', asset: 'XLM' }, // Fit (150+40 <= 200)
        { amount: '20.00', asset: 'XLM' }, // Exceed (150+40+20 > 200)
      ],
    },
  });

  t.equal(res.statusCode, 201);
  const body = JSON.parse(res.body);
  t.equal(body.total, 2);
  t.equal(body.created, 1);
  t.equal(body.errors.length, 1);
  t.equal(body.errors[0].index, 1);
  t.end();
});

test('bulk-limits: decimal precision check under boundary constraints', async (t) => {
  resetMocks();
  prisma.merchant.findUnique = async () => MOCK_MERCHANT_TIGHT_LIMITS as any;

  // Test amount with very high decimals (e.g. USDC / XLM bounds check)
  const res = await fastify.inject({
    method: 'POST',
    url: '/api/settlements/bulk',
    payload: {
      merchantId: MOCK_MERCHANT_TIGHT_LIMITS.id,
      settlements: [
        { amount: '10.0000001', asset: 'XLM' }, // Highly precise decimal
      ],
    },
  });

  t.equal(res.statusCode, 201);
  const body = JSON.parse(res.body);
  t.equal(body.total, 1);
  t.equal(body.created, 1);
  t.equal(body.errors.length, 0);
  t.end();
});

test('bulk-limits: rejects empty bulk batch', async (t) => {
  resetMocks();
  prisma.merchant.findUnique = async () => MOCK_MERCHANT_TIGHT_LIMITS as any;

  const res = await fastify.inject({
    method: 'POST',
    url: '/api/settlements/bulk',
    payload: {
      merchantId: MOCK_MERCHANT_TIGHT_LIMITS.id,
      settlements: [],
    },
  });

  t.equal(res.statusCode, 400);
  const body = JSON.parse(res.body);
  t.ok(body.error.message.includes('at least one settlement'));
  t.end();
});

test('bulk-limits: handles multiple assets in the same daily limit check', async (t) => {
  resetMocks();
  prisma.merchant.findUnique = async () => MOCK_MERCHANT_TIGHT_LIMITS as any;
  prisma.$queryRaw = async () => [{ sum: '100.00' }]; // Pre-existing aggregate sum

  const res = await fastify.inject({
    method: 'POST',
    url: '/api/settlements/bulk',
    payload: {
      merchantId: MOCK_MERCHANT_TIGHT_LIMITS.id,
      settlements: [
        { amount: '50.00', asset: 'USDC' },
        { amount: '50.00', asset: 'EURT' },
        { amount: '10.00', asset: 'XLM' }, // Exceeds daily limit (100 + 50 + 50 + 10 = 210 > 200)
      ],
    },
  });

  t.equal(res.statusCode, 201);
  const body = JSON.parse(res.body);
  t.equal(body.total, 3);
  t.equal(body.created, 2);
  t.equal(body.errors.length, 1);
  t.equal(body.errors[0].index, 2);
  t.end();
});
