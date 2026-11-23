import test from 'tape';
import { createTestApp, generateTestJwt } from './test-utils.js';
import { MOCK_SUPPORTED_ASSET_USDC } from './test-fixtures.js';
import { ErrorCodes } from '@bettapay/validation';

const ADMIN_ADDR = process.env.ADMIN_ADDRESS || 'GA_TEST';

test('POST /api/settlements rejects cross-merchant settlement creation with HTTP 403', async (t) => {
  const { app } = await createTestApp({}, {
    merchants: [
      { id: 'merch_caller', ownerId: 'u1', status: 'active', settings: {} },
      { id: 'merch_target', ownerId: 'u2', status: 'active', settings: {} },
    ],
    supportedAssets: [MOCK_SUPPORTED_ASSET_USDC],
  });

  const callerToken = generateTestJwt(app, { merchantId: 'merch_caller', ownerId: 'u1' });

  const res = await app.inject({
    method: 'POST',
    url: '/api/settlements',
    headers: {
      authorization: `Bearer ${callerToken}`,
      'x-csrf-check': '1',
    },
    payload: {
      merchantId: 'merch_target', // cross-merchant attempt
      items: [{ amount: '50.00', asset: 'USDC' }],
    },
  });

  t.equal(res.statusCode, 403, 'cross-merchant settlement creation returns 403');
  const body = JSON.parse(res.body);
  t.equal(body.error.code, ErrorCodes.FORBIDDEN, 'returns FORBIDDEN error code');
  t.match(body.error.message, /access to create settlements/i, 'returns clear permission error');

  await app.close();
  t.end();
});

test('POST /api/settlements allows admin callers to create settlements for any merchant', async (t) => {
  const { app } = await createTestApp({}, {
    merchants: [
      { id: 'merch_target', ownerId: 'u2', status: 'active', settings: {} },
    ],
    supportedAssets: [MOCK_SUPPORTED_ASSET_USDC],
  });

  const adminToken = generateTestJwt(app, { merchantId: ADMIN_ADDR, ownerId: 'admin' });

  const res = await app.inject({
    method: 'POST',
    url: '/api/settlements',
    headers: {
      authorization: `Bearer ${adminToken}`,
      'x-csrf-check': '1',
    },
    payload: {
      merchantId: 'merch_target',
      items: [{ amount: '50.00', asset: 'USDC' }],
    },
  });

  t.equal(res.statusCode, 201, 'admin can create settlement for other merchant');
  await app.close();
  t.end();
});

test('POST /api/settlements excludes failed, cancelled, and superseded settlements from daily volume', async (t) => {
  const merchantId = 'merch_vol_test';
  const now = new Date();

  const { app } = await createTestApp({}, {
    merchants: [{
      id: merchantId,
      ownerId: 'u1',
      status: 'active',
      settings: {
        dailySettlementLimit: '1000.00',
      },
    }],
    supportedAssets: [MOCK_SUPPORTED_ASSET_USDC],
    settlements: [
      // 500 completed — this counts
      { id: 's1', merchantId, totalAmount: '500.00', status: 'completed', initiatedAt: now },
      // 400 failed — must NOT count
      { id: 's2', merchantId, totalAmount: '400.00', status: 'failed', initiatedAt: now },
      // 300 cancelled — must NOT count
      { id: 's3', merchantId, totalAmount: '300.00', status: 'cancelled', initiatedAt: now },
      // 200 superseded (supersededById set) — must NOT count
      { id: 's4', merchantId, totalAmount: '200.00', status: 'processing', supersededById: 's_parent', initiatedAt: now },
    ],
  });

  const token = generateTestJwt(app, { merchantId, ownerId: 'u1' });

  // Adding 400.00:
  // If failed/cancelled/superseded counted, total would be 500+400+300+200 + 400 = 1800 > 1000 (QUOTA_EXCEEDED).
  // Because they are excluded, current volume is 500.00, new total is 500 + 400 = 900.00 <= 1000.00 (succeeds).
  const res = await app.inject({
    method: 'POST',
    url: '/api/settlements',
    headers: {
      authorization: `Bearer ${token}`,
      'x-csrf-check': '1',
    },
    payload: {
      merchantId,
      items: [{ amount: '400.00', asset: 'USDC' }],
    },
  });

  t.equal(res.statusCode, 201, 'creation succeeds because failed/cancelled/superseded settlements do not count against limit');

  // Now adding 200.00 more:
  // Current valid volume is 500.00 (from DB). 500 + 600 = 1100 > 1000 -> should exceed limit
  const exceedRes = await app.inject({
    method: 'POST',
    url: '/api/settlements',
    headers: {
      authorization: `Bearer ${token}`,
      'x-csrf-check': '1',
    },
    payload: {
      merchantId,
      items: [{ amount: '600.00', asset: 'USDC' }],
    },
  });

  t.equal(exceedRes.statusCode, 422, 'exceeding daily limit returns 422');
  const exceedBody = JSON.parse(exceedRes.body);
  t.equal(exceedBody.error.code, 'QUOTA_EXCEEDED');

  await app.close();
  t.end();
});

test('POST /api/settlements daily limit math has zero floating-point precision loss', async (t) => {
  const merchantId = 'merch_decimal_precision';
  const now = new Date();

  // Floating point: 0.1 + 0.2 = 0.30000000000000004
  // In IEEE 754 float: 0.1 + 0.2 > 0.3 is true!
  // With Decimal math: 0.1 + 0.2 = 0.3, so newDailyTotal <= 0.3 is true!
  const { app } = await createTestApp({}, {
    merchants: [{
      id: merchantId,
      ownerId: 'u1',
      status: 'active',
      settings: {
        dailySettlementLimit: '0.3',
      },
    }],
    supportedAssets: [MOCK_SUPPORTED_ASSET_USDC],
    settlements: [
      { id: 's_prev', merchantId, totalAmount: '0.1', status: 'completed', initiatedAt: now },
    ],
  });

  const token = generateTestJwt(app, { merchantId, ownerId: 'u1' });

  // Adding 0.2: current(0.1) + requested(0.2) = exact 0.3 <= dailyLimit(0.3).
  // If float math was used, 0.30000000000000004 > 0.3 would falsely reject it.
  const res = await app.inject({
    method: 'POST',
    url: '/api/settlements',
    headers: {
      authorization: `Bearer ${token}`,
      'x-csrf-check': '1',
    },
    payload: {
      merchantId,
      items: [{ amount: '0.2', asset: 'USDC' }],
    },
  });

  t.equal(res.statusCode, 201, '0.1 + 0.2 does not exceed 0.3 limit with Decimal math');

  // Adding 0.21: 0.1 + 0.21 = 0.31 > 0.3 -> properly rejected with 422 QUOTA_EXCEEDED
  const exceedRes = await app.inject({
    method: 'POST',
    url: '/api/settlements',
    headers: {
      authorization: `Bearer ${token}`,
      'x-csrf-check': '1',
    },
    payload: {
      merchantId,
      items: [{ amount: '0.21', asset: 'USDC' }],
    },
  });

  t.equal(exceedRes.statusCode, 422, 'properly rejects when amount genuinely exceeds limit');
  const exceedBody = JSON.parse(exceedRes.body);
  t.equal(exceedBody.error.code, 'QUOTA_EXCEEDED');
  await app.close();
  t.end();
});
