/**
 * Tests for #317 — Merchant account suspension without data deletion.
 *
 * Verifies:
 *  - POST /api/merchants/:id/suspend flips status to 'suspended' (200)
 *  - POST /api/merchants/:id/unsuspend flips status back to 'active' (200)
 *  - Suspending an already-suspended merchant returns 409
 *  - Unsuspending an already-active merchant returns 409
 *  - Suspended merchant cannot create payments (403 MERCHANT_SUSPENDED)
 *  - Suspended merchant cannot create settlements (403 MERCHANT_SUSPENDED)
 *  - After unsuspend, the merchant can create payments again (200)
 *  - Soft-deleted merchants cannot be suspended (404)
 *  - Suspend/unsuspend require service-auth token
 *  - Audit log entries are written for both transitions
 */

import test from 'tape';
import { ErrorCodes, validateEnv } from '@bettapay/validation';
import { createTestApp, generateTestJwt } from './test-utils.js';
import { MOCK_MERCHANT_ACTIVE, MOCK_MERCHANT_DELETED, MOCK_MERCHANT_SUSPENDED } from './test-fixtures.js';

// Match the loaded INTER_SERVICE_SECRET (set in .env by `dotenv/config`) so
// the service-auth hook accepts our header. Falls back to a stable default
// only when the env var is genuinely absent.
const SERVICE_TOKEN = validateEnv(process.env).INTER_SERVICE_SECRET;

function authHeader() {
  return { 'x-service-token': SERVICE_TOKEN };
}

test('POST /api/merchants/:id/suspend flips status to suspended', async (t) => {
  const { app, mockPrisma } = await createTestApp({}, { merchants: [{ ...MOCK_MERCHANT_ACTIVE }] });
  try {
    const res = await app.inject({
      method: 'POST',
      url: `/api/merchants/${MOCK_MERCHANT_ACTIVE.id}/suspend`,
      headers: authHeader(),
    });
    t.equal(res.statusCode, 200, 'returns 200');
    const body = JSON.parse(res.body);
    t.equal(body.data.status, 'suspended', 'merchant is now suspended');
    t.equal(body.data.id, MOCK_MERCHANT_ACTIVE.id, 'returns correct merchant id');

    const stored = (mockPrisma as any).store.merchants.find((m: any) => m.id === MOCK_MERCHANT_ACTIVE.id);
    t.equal(stored.status, 'suspended', 'persisted status is suspended');
  } catch (err: any) {
    t.fail(err);
  } finally {
    await app.close();
    t.end();
  }
});

test('POST /api/merchants/:id/suspend returns 409 when already suspended', async (t) => {
  const { app } = await createTestApp({}, { merchants: [MOCK_MERCHANT_SUSPENDED] });
  try {
    const res = await app.inject({
      method: 'POST',
      url: `/api/merchants/${MOCK_MERCHANT_ACTIVE.id}/suspend`,
      headers: authHeader(),
    });
    t.equal(res.statusCode, 409, 'returns 409 Conflict');
    const body = JSON.parse(res.body);
    t.equal(body.error.code, ErrorCodes.INVALID_REQUEST, 'uses INVALID_REQUEST code');
    t.match(body.error.message, /already suspended/i, 'explains the merchant is already suspended');
  } catch (err: any) {
    t.fail(err);
  } finally {
    await app.close();
    t.end();
  }
});

test('POST /api/merchants/:id/suspend returns 404 for unknown merchant', async (t) => {
  const { app } = await createTestApp({}, { merchants: [] });
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/api/merchants/does-not-exist/suspend',
      headers: authHeader(),
    });
    t.equal(res.statusCode, 404, 'returns 404');
    const body = JSON.parse(res.body);
    t.equal(body.error.code, ErrorCodes.NOT_FOUND, 'uses NOT_FOUND code');
  } catch (err: any) {
    t.fail(err);
  } finally {
    await app.close();
    t.end();
  }
});

test('POST /api/merchants/:id/suspend returns 404 for soft-deleted merchant', async (t) => {
  const { app } = await createTestApp({}, { merchants: [{ ...MOCK_MERCHANT_DELETED }] });
  try {
    const res = await app.inject({
      method: 'POST',
      url: `/api/merchants/${MOCK_MERCHANT_DELETED.id}/suspend`,
      headers: authHeader(),
    });
    t.equal(res.statusCode, 404, 'returns 404 — soft-deleted cannot be suspended');
  } catch (err: any) {
    t.fail(err);
  } finally {
    await app.close();
    t.end();
  }
});

test('POST /api/merchants/:id/suspend requires service-auth', async (t) => {
  const { app } = await createTestApp({}, { merchants: [{ ...MOCK_MERCHANT_ACTIVE }] });
  try {
    const res = await app.inject({
      method: 'POST',
      url: `/api/merchants/${MOCK_MERCHANT_ACTIVE.id}/suspend`,
      // no x-service-token header
    });
    t.equal(res.statusCode, 401, 'returns 401 without service token');
  } catch (err: any) {
    t.fail(err);
  } finally {
    await app.close();
    t.end();
  }
});

test('POST /api/merchants/:id/suspend rejects wrong service-auth token (401)', async (t) => {
  const { app } = await createTestApp({}, { merchants: [{ ...MOCK_MERCHANT_ACTIVE }] });
  try {
    const res = await app.inject({
      method: 'POST',
      url: `/api/merchants/${MOCK_MERCHANT_ACTIVE.id}/suspend`,
      headers: { 'x-service-token': 'not-the-real-token' },
    });
    t.equal(res.statusCode, 401, 'returns 401 with wrong service token');
  } catch (err: any) {
    t.fail(err);
  } finally {
    await app.close();
    t.end();
  }
});

test('POST /api/merchants/:id/unsuspend flips status back to active', async (t) => {
  const { app, mockPrisma } = await createTestApp({}, { merchants: [MOCK_MERCHANT_SUSPENDED] });
  try {
    const res = await app.inject({
      method: 'POST',
      url: `/api/merchants/${MOCK_MERCHANT_ACTIVE.id}/unsuspend`,
      headers: authHeader(),
    });
    t.equal(res.statusCode, 200, 'returns 200');
    const body = JSON.parse(res.body);
    t.equal(body.data.status, 'active', 'merchant is now active');

    const stored = (mockPrisma as any).store.merchants.find((m: any) => m.id === MOCK_MERCHANT_ACTIVE.id);
    t.equal(stored.status, 'active', 'persisted status is active');
  } catch (err: any) {
    t.fail(err);
  } finally {
    await app.close();
    t.end();
  }
});

test('POST /api/merchants/:id/unsuspend returns 409 when already active', async (t) => {
  const { app } = await createTestApp({}, { merchants: [{ ...MOCK_MERCHANT_ACTIVE }] });
  try {
    const res = await app.inject({
      method: 'POST',
      url: `/api/merchants/${MOCK_MERCHANT_ACTIVE.id}/unsuspend`,
      headers: authHeader(),
    });
    t.equal(res.statusCode, 409, 'returns 409 Conflict');
    const body = JSON.parse(res.body);
    t.match(body.error.message, /already active/i, 'explains the merchant is already active');
  } catch (err: any) {
    t.fail(err);
  } finally {
    await app.close();
    t.end();
  }
});

test('POST /api/merchants/:id/unsuspend requires service-auth', async (t) => {
  const { app } = await createTestApp({}, { merchants: [MOCK_MERCHANT_SUSPENDED] });
  try {
    const res = await app.inject({
      method: 'POST',
      url: `/api/merchants/${MOCK_MERCHANT_ACTIVE.id}/unsuspend`,
      // no x-service-token header
    });
    t.equal(res.statusCode, 401, 'returns 401 without service token');
  } catch (err: any) {
    t.fail(err);
  } finally {
    await app.close();
    t.end();
  }
});

test('Suspended merchant cannot create a payment (403)', async (t) => {
  const { app } = await createTestApp({}, { merchants: [MOCK_MERCHANT_SUSPENDED] });
  const token = generateTestJwt(app);
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/api/payments',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        merchantId: MOCK_MERCHANT_ACTIVE.id,
        amount: '10.00',
        asset: 'USDC',
      },
    });
    t.equal(res.statusCode, 403, 'returns 403 Forbidden');
    const body = JSON.parse(res.body);
    t.equal(body.error.code, ErrorCodes.MERCHANT_SUSPENDED, 'returns MERCHANT_SUSPENDED code');
    t.match(body.error.message, /suspended/i, 'mentions suspension in message');
  } catch (err: any) {
    t.fail(err);
  } finally {
    await app.close();
    t.end();
  }
});

test('Suspended merchant cannot create a settlement (403)', async (t) => {
  const { app } = await createTestApp({}, {
    merchants: [MOCK_MERCHANT_SUSPENDED],
  });
  const token = generateTestJwt(app);
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/api/settlements',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        merchantId: MOCK_MERCHANT_ACTIVE.id,
        amount: '100.00',
        asset: 'USDC',
      },
    });
    t.equal(res.statusCode, 403, 'returns 403 Forbidden');
    const body = JSON.parse(res.body);
    t.equal(body.error.code, ErrorCodes.MERCHANT_SUSPENDED, 'returns MERCHANT_SUSPENDED code');
  } catch (err: any) {
    t.fail(err);
  } finally {
    await app.close();
    t.end();
  }
});

test('After unsuspend, merchant can create a payment again', async (t) => {
  const { app } = await createTestApp({}, { merchants: [MOCK_MERCHANT_SUSPENDED] });
  const token = generateTestJwt(app);

  try {
    // First, unsuspend the merchant
    const suspendRes = await app.inject({
      method: 'POST',
      url: `/api/merchants/${MOCK_MERCHANT_ACTIVE.id}/unsuspend`,
      headers: authHeader(),
    });
    t.equal(suspendRes.statusCode, 200, 'unsuspend succeeded');

    // Now try to create a payment
    const payRes = await app.inject({
      method: 'POST',
      url: '/api/payments',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        merchantId: MOCK_MERCHANT_ACTIVE.id,
        amount: '25.00',
        asset: 'USDC',
      },
    });
    t.equal(payRes.statusCode, 201, 'payment creation succeeds after unsuspend');
  } catch (err: any) {
    t.fail(err);
  } finally {
    await app.close();
    t.end();
  }
});

test('Full suspend → block payment → unsuspend → allow payment flow', async (t) => {
  const { app } = await createTestApp({}, { merchants: [{ ...MOCK_MERCHANT_ACTIVE }] });
  const token = generateTestJwt(app);

  try {
    // 1. Suspend
    const suspendRes = await app.inject({
      method: 'POST',
      url: `/api/merchants/${MOCK_MERCHANT_ACTIVE.id}/suspend`,
      headers: authHeader(),
    });
    t.equal(suspendRes.statusCode, 200, 'suspend returned 200');

    // 2. Payment should be blocked
    const blockedRes = await app.inject({
      method: 'POST',
      url: '/api/payments',
      headers: { authorization: `Bearer ${token}` },
      payload: { merchantId: MOCK_MERCHANT_ACTIVE.id, amount: '10.00', asset: 'USDC' },
    });
    t.equal(blockedRes.statusCode, 403, 'payment creation blocked while suspended');
    t.equal(JSON.parse(blockedRes.body).error.code, ErrorCodes.MERCHANT_SUSPENDED, 'blocked with MERCHANT_SUSPENDED');

    // 3. Unsuspend
    const unsuspendRes = await app.inject({
      method: 'POST',
      url: `/api/merchants/${MOCK_MERCHANT_ACTIVE.id}/unsuspend`,
      headers: authHeader(),
    });
    t.equal(unsuspendRes.statusCode, 200, 'unsuspend returned 200');

    // 4. Payment should now succeed
    const allowedRes = await app.inject({
      method: 'POST',
      url: '/api/payments',
      headers: { authorization: `Bearer ${token}` },
      payload: { merchantId: MOCK_MERCHANT_ACTIVE.id, amount: '10.00', asset: 'USDC' },
    });
    t.equal(allowedRes.statusCode, 201, 'payment creation succeeds after unsuspend');
  } catch (err: any) {
    t.fail(err);
  } finally {
    await app.close();
    t.end();
  }
});

test('Suspend writes an audit log entry', async (t) => {
  const { app, mockPrisma } = await createTestApp({}, { merchants: [{ ...MOCK_MERCHANT_ACTIVE }] });
  try {
    const res = await app.inject({
      method: 'POST',
      url: `/api/merchants/${MOCK_MERCHANT_ACTIVE.id}/suspend`,
      headers: authHeader(),
    });
    t.equal(res.statusCode, 200, 'suspend succeeded');

    const audits = (mockPrisma as any).store.auditLogs;
    const found = audits.find((a: any) => a.action === 'merchant.suspended' && a.entityId === MOCK_MERCHANT_ACTIVE.id);
    t.ok(found, 'merchant.suspended audit log entry exists');
    t.equal(found.entityType, 'merchant', 'entityType is merchant');
    t.equal(found.actorType, 'service', 'actorType is service');
  } catch (err: any) {
    t.fail(err);
  } finally {
    await app.close();
    t.end();
  }
});

test('Unsuspend writes an audit log entry', async (t) => {
  const { app, mockPrisma } = await createTestApp({}, { merchants: [MOCK_MERCHANT_SUSPENDED] });
  try {
    const res = await app.inject({
      method: 'POST',
      url: `/api/merchants/${MOCK_MERCHANT_ACTIVE.id}/unsuspend`,
      headers: authHeader(),
    });
    t.equal(res.statusCode, 200, 'unsuspend succeeded');

    const audits = (mockPrisma as any).store.auditLogs;
    const found = audits.find((a: any) => a.action === 'merchant.unsuspended' && a.entityId === MOCK_MERCHANT_ACTIVE.id);
    t.ok(found, 'merchant.unsuspended audit log entry exists');
    t.equal(found.actorType, 'service', 'actorType is service');
  } catch (err: any) {
    t.fail(err);
  } finally {
    await app.close();
    t.end();
  }
});

test('Existing data remains readable for suspended merchant (GET /api/merchants/:id → 200)', async (t) => {
  const { app } = await createTestApp({}, { merchants: [MOCK_MERCHANT_SUSPENDED] });
  const token = generateTestJwt(app);
  try {
    const res = await app.inject({
      method: 'GET',
      url: `/api/merchants/${MOCK_MERCHANT_ACTIVE.id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    t.equal(res.statusCode, 200, 'GET returns 200 — merchant data is readable while suspended');
    const body = JSON.parse(res.body);
    t.equal(body.data.id, MOCK_MERCHANT_ACTIVE.id, 'returns the suspended merchant record');
    t.equal(body.data.status, 'suspended', 'status field reflects the suspended state');
  } catch (err: any) {
    t.fail(err);
  } finally {
    await app.close();
    t.end();
  }
});

test('Existing payments remain readable for suspended merchant (GET /api/payments/:id → 200)', async (t) => {
  const { app } = await createTestApp({}, {
    merchants: [MOCK_MERCHANT_SUSPENDED],
    payments: [{
      id: 'pay_existing_001',
      merchantId: MOCK_MERCHANT_ACTIVE.id,
      payerId: 'payer-1',
      amount: '50.00',
      asset: 'USDC',
      status: 'initiated',
      createdAt: new Date(),
      idempotencyKey: null,
      idempotencyKeyExpiresAt: null,
    }],
  });
  try {
    const res = await app.inject({
      method: 'GET',
      url: '/api/payments/pay_existing_001',
    });
    t.equal(res.statusCode, 200, 'GET payment returns 200 — existing payment data is readable while suspended');
    const body = JSON.parse(res.body);
    t.equal(body.data.id, 'pay_existing_001', 'returns the existing payment');
  } catch (err: any) {
    t.fail(err);
  } finally {
    await app.close();
    t.end();
  }
});

test('PATCH /api/payments/:id/status is allowed for suspended merchant (in-flight state transitions)', async (t) => {
  const { app } = await createTestApp({}, {
    merchants: [MOCK_MERCHANT_SUSPENDED],
    payments: [{
      id: 'pay_inflight_001',
      merchantId: MOCK_MERCHANT_ACTIVE.id,
      payerId: 'payer-1',
      amount: '75.00',
      asset: 'USDC',
      status: 'initiated',
      createdAt: new Date(),
      idempotencyKey: null,
      idempotencyKeyExpiresAt: null,
    }],
  });
  const token = generateTestJwt(app);
  try {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/payments/pay_inflight_001/status',
      headers: { authorization: `Bearer ${token}` },
      payload: { status: 'completed' },
    });
    t.equal(res.statusCode, 200, 'PATCH returns 200 — state transitions on existing payments are not blocked');
    const body = JSON.parse(res.body);
    t.equal(body.data.status, 'completed', 'payment is transitioned to completed');
  } catch (err: any) {
    t.fail(err);
  } finally {
    await app.close();
    t.end();
  }
});

test('Suspend response strips secretHash', async (t) => {
  const { app } = await createTestApp({}, { merchants: [{ ...MOCK_MERCHANT_ACTIVE }] });
  try {
    const res = await app.inject({
      method: 'POST',
      url: `/api/merchants/${MOCK_MERCHANT_ACTIVE.id}/suspend`,
      headers: authHeader(),
    });
    t.equal(res.statusCode, 200, 'suspend succeeded');
    const body = JSON.parse(res.body);
    t.notOk(body.data.secretHash, 'secretHash is not exposed in the response');
  } catch (err: any) {
    t.fail(err);
  } finally {
    await app.close();
    t.end();
  }
});

test('POST /api/payments returns 404 for unknown merchant', async (t) => {
  const { app } = await createTestApp({}, { merchants: [] });
  const token = generateTestJwt(app);
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/api/payments',
      headers: { authorization: `Bearer ${token}` },
      payload: { merchantId: 'GC566BRQU6NGBBAJXT3V7HGF7TX44DCNJNKCA4UCIA3FVFENJIQ6WYWG', amount: '10.00', asset: 'USDC' },
    });
    t.equal(res.statusCode, 404, 'returns 404 for unknown merchant');
    const body = JSON.parse(res.body);
    t.equal(body.error.code, ErrorCodes.NOT_FOUND, 'returns NOT_FOUND');
  } catch (err: any) {
    t.fail(err);
  } finally {
    await app.close();
    t.end();
  }
});
