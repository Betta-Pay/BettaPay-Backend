/**
 * Issue #887 — Bulk settlement zero-item guard.
 *
 * POST /api/settlements/bulk must reject an empty settlements array with a
 * 400 VALIDATION_ERROR, accept a single-item batch, and reject a 101-item
 * batch that exceeds the 100-settlement cap.
 */
import test from 'tape';
import { fastify, prisma, settlementQueue, redis } from './index.js';
import { MOCK_MERCHANT_STANDARD } from './test-fixtures.js';

process.env.NODE_ENV = 'test';

const AUTH_TOKEN = process.env.INTER_SERVICE_SECRET || 'dev-inter-service-secret';
const AUTH_HEADER = { 'x-service-token': AUTH_TOKEN };

function resetMocks() {
  prisma.merchant.findUnique = async () => MOCK_MERCHANT_STANDARD as any;
  prisma.$queryRaw = async () => [{ sum: null }];
  prisma.$transaction = async (cb: any) => cb(prisma);
  prisma.settlement.create = async (args: any) => args.data;
  prisma.settlement.findMany = async () => [];
  settlementQueue.add = async () => ({} as any);
  settlementQueue.addBulk = async () => [] as any;
  redis.set = async () => 'OK' as any;
  redis.get = async () => null as any;
}

test('#887: POST /api/settlements/bulk with empty array returns 400 VALIDATION_ERROR', async (t) => {
  resetMocks();

  const res = await fastify.inject({
    method: 'POST',
    url: '/api/settlements/bulk',
    headers: AUTH_HEADER,
    payload: {
      merchantId: MOCK_MERCHANT_STANDARD.id,
      settlements: [],
    },
  });

  t.equal(res.statusCode, 400, 'returns 400 for empty settlements array');
  const body = JSON.parse(res.body);
  t.equal(body.error.code, 'VALIDATION_ERROR', 'error code is VALIDATION_ERROR');
  t.ok(
    typeof body.error.message === 'string' && body.error.message.length > 0,
    'error envelope includes a message',
  );
  t.end();
});

test('#887: POST /api/settlements/bulk with a single settlement is accepted', async (t) => {
  resetMocks();

  const res = await fastify.inject({
    method: 'POST',
    url: '/api/settlements/bulk',
    headers: AUTH_HEADER,
    payload: {
      merchantId: MOCK_MERCHANT_STANDARD.id,
      settlements: [{ amount: '10.00', asset: 'USDC' }],
    },
  });

  t.notEqual(res.statusCode, 400, 'single-item batch is not rejected with 400');
  t.notEqual(res.statusCode, 422, 'single-item batch is not rejected with 422');
  t.end();
});

test('#887: POST /api/settlements/bulk with 101 items returns 400 VALIDATION_ERROR', async (t) => {
  resetMocks();

  const oversizedBatch = Array.from({ length: 101 }, () => ({ amount: '1.00', asset: 'USDC' }));

  const res = await fastify.inject({
    method: 'POST',
    url: '/api/settlements/bulk',
    headers: AUTH_HEADER,
    payload: {
      merchantId: MOCK_MERCHANT_STANDARD.id,
      settlements: oversizedBatch,
    },
  });

  t.equal(res.statusCode, 400, 'returns 400 for batch exceeding the 100-item cap');
  const body = JSON.parse(res.body);
  t.equal(body.error.code, 'VALIDATION_ERROR', 'error code is VALIDATION_ERROR');
  t.end();
});

test('#887: error envelope shape has error.code and error.message at minimum', async (t) => {
  resetMocks();

  const res = await fastify.inject({
    method: 'POST',
    url: '/api/settlements/bulk',
    headers: AUTH_HEADER,
    payload: {
      merchantId: MOCK_MERCHANT_STANDARD.id,
      settlements: [],
    },
  });

  const body = JSON.parse(res.body);
  t.ok(body.error, 'response has an "error" key');
  t.equal(typeof body.error.code, 'string', 'error.code is a string');
  t.equal(typeof body.error.message, 'string', 'error.message is a string');
  t.end();
});
