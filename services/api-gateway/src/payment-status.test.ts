import test from 'tape';
import { createTestApp, generateTestJwt } from './test-utils.js';

test('authorization: PATCH /api/payments/:id/status returns 401 without valid JWT', async (t) => {
  const { app } = await createTestApp({}, {
    payments: [{ id: 'pay_1', status: 'initiated', merchantId: 'm1', amount: '10.00', asset: 'USDC' }],
  });

  const res = await app.inject({
    method: 'PATCH',
    url: '/api/payments/pay_1/status',
    payload: { status: 'completed' },
  });

  t.equal(res.statusCode, 401, 'returns 401 Unauthorized when missing token');
  await app.close();
  t.end();
});

test('persistence & transitions: initiated transitions to a terminal state and updates DB', async (t) => {
  const initialPayment = { id: 'pay_1', status: 'initiated', merchantId: 'm1', amount: '10.00', asset: 'USDC' };
  const { app, mockPrisma } = await createTestApp({}, { payments: [initialPayment] });
  const token = generateTestJwt(app);

  const res = await app.inject({
    method: 'PATCH',
    url: '/api/payments/pay_1/status',
    headers: { authorization: `Bearer ${token}` },
    payload: { status: 'completed' },
  });

  t.equal(res.statusCode, 200, 'returns 200 OK');
  const body = JSON.parse(res.body);
  t.equal(body.data.status, 'completed', 'response status is updated to completed');

  // Persistence verification in mock DB
  const stored = await mockPrisma.payment.findUnique({ where: { id: 'pay_1' } });
  t.ok(stored, 'payment exists in mock database');
  t.equal(stored.status, 'completed', 'database payment status is updated to completed');

  await app.close();
  t.end();
});

test('terminal states cannot transition', async (t) => {
  const { app } = await createTestApp({}, {
    payments: [{ id: 'pay_1', status: 'completed', merchantId: 'm1', amount: '10.00', asset: 'USDC' }],
  });
  const token = generateTestJwt(app);

  const res = await app.inject({
    method: 'PATCH',
    url: '/api/payments/pay_1/status',
    headers: { authorization: `Bearer ${token}` },
    payload: { status: 'failed' },
  });

  t.equal(res.statusCode, 422, 'returns 422 Unprocessable Entity');
  const body = JSON.parse(res.body);
  t.equal(body.error.details.from, 'completed', 'reports the current state in error details');

  await app.close();
  t.end();
});

test('an unaccepted status value is rejected as a bad payload', async (t) => {
  const { app } = await createTestApp({}, {
    payments: [{ id: 'pay_1', status: 'initiated', merchantId: 'm1', amount: '10.00', asset: 'USDC' }],
  });
  const token = generateTestJwt(app);

  const res = await app.inject({
    method: 'PATCH',
    url: '/api/payments/pay_1/status',
    headers: { authorization: `Bearer ${token}` },
    payload: { status: 'initiated' },
  });

  t.equal(res.statusCode, 400, 'returns 400 for a status outside the accepted enum');
  await app.close();
  t.end();
});

test('updating a missing payment returns 404', async (t) => {
  const { app } = await createTestApp({}, { payments: [] });
  const token = generateTestJwt(app);

  const res = await app.inject({
    method: 'PATCH',
    url: '/api/payments/missing_pay/status',
    headers: { authorization: `Bearer ${token}` },
    payload: { status: 'completed' },
  });

  t.equal(res.statusCode, 404, 'returns 404 Not Found');
  await app.close();
  t.end();
});
