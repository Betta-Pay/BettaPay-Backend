import test from 'tape';
import { createTestApp, generateTestJwt } from './test-utils.js';

const SERVICE_SECRET = process.env.INTER_SERVICE_SECRET || 'dev-inter-service-secret';
const ADMIN_ADDR = process.env.ADMIN_ADDRESS || 'GA_TEST';

test('authorization: PATCH /api/settlements/:id/status returns 401 without valid JWT or service token', async (t) => {
  const { app } = await createTestApp({}, {
    merchants: [{ id: 'm1', ownerId: 'u1' }],
    settlements: [{ id: 'set_1', status: 'pending', merchantId: 'm1', totalAmount: '100.00', completedAt: null }],
  });

  const res = await app.inject({
    method: 'PATCH',
    url: '/api/settlements/set_1/status',
    headers: { 'x-csrf-check': '1' },
    payload: { status: 'processing' },
  });

  t.equal(res.statusCode, 401, 'returns 401 Unauthorized without auth headers');
  await app.close();
  t.end();
});

test('authorization: PATCH /api/settlements/:id/status returns 401 with invalid service token', async (t) => {
  const { app } = await createTestApp({}, {
    merchants: [{ id: 'm1', ownerId: 'u1' }],
    settlements: [{ id: 'set_1', status: 'pending', merchantId: 'm1', totalAmount: '100.00', completedAt: null }],
  });

  const res = await app.inject({
    method: 'PATCH',
    url: '/api/settlements/set_1/status',
    headers: { 'x-service-token': 'wrong-token', 'x-csrf-check': '1' },
    payload: { status: 'processing' },
  });

  t.equal(res.statusCode, 401, 'returns 401 with invalid service token');
  await app.close();
  t.end();
});

test('authorization: PATCH /api/settlements/:id/status returns 403 for unauthorized caller (different merchant)', async (t) => {
  const { app } = await createTestApp({}, {
    merchants: [
      { id: 'm1', ownerId: 'u1' },
      { id: 'm2', ownerId: 'u2' },
    ],
    settlements: [{ id: 'set_1', status: 'pending', merchantId: 'm1', totalAmount: '100.00', completedAt: null }],
  });
  const tokenM2 = generateTestJwt(app, { merchantId: 'm2', ownerId: 'u2' });

  const res = await app.inject({
    method: 'PATCH',
    url: '/api/settlements/set_1/status',
    headers: { authorization: `Bearer ${tokenM2}`, 'x-csrf-check': '1' },
    payload: { status: 'processing' },
  });

  t.equal(res.statusCode, 403, 'returns 403 Forbidden for unauthorized merchant caller');
  const body = JSON.parse(res.body);
  t.equal(body.error.code, 'FORBIDDEN');
  await app.close();
  t.end();
});

test('authorization: PATCH /api/settlements/:id/status allows authorized service callers (x-service-token)', async (t) => {
  const { app, mockPrisma } = await createTestApp({}, {
    merchants: [{ id: 'm1', ownerId: 'u1' }],
    settlements: [{ id: 'set_1', status: 'pending', merchantId: 'm1', totalAmount: '100.00', completedAt: null }],
  });

  const res = await app.inject({
    method: 'PATCH',
    url: '/api/settlements/set_1/status',
    headers: { 'x-service-token': SERVICE_SECRET, 'x-csrf-check': '1' },
    payload: { status: 'processing' },
  });

  t.equal(res.statusCode, 200, 'returns 200 for authorized service caller');
  const stored = await mockPrisma.settlement.findUnique({ where: { id: 'set_1' } });
  t.equal(stored.status, 'processing', 'updates status via service caller');
  await app.close();
  t.end();
});

test('authorization: PATCH /api/settlements/:id/status allows authorized admin callers', async (t) => {
  const { app, mockPrisma } = await createTestApp({}, {
    merchants: [{ id: 'm1', ownerId: 'u1' }],
    settlements: [{ id: 'set_1', status: 'pending', merchantId: 'm1', totalAmount: '100.00', completedAt: null }],
  });
  const adminToken = generateTestJwt(app, { merchantId: ADMIN_ADDR, ownerId: 'admin' });

  const res = await app.inject({
    method: 'PATCH',
    url: '/api/settlements/set_1/status',
    headers: { authorization: `Bearer ${adminToken}`, 'x-csrf-check': '1' },
    payload: { status: 'processing' },
  });

  t.equal(res.statusCode, 200, 'returns 200 for admin caller');
  const stored = await mockPrisma.settlement.findUnique({ where: { id: 'set_1' } });
  t.equal(stored.status, 'processing', 'updates status via admin caller');
  await app.close();
  t.end();
});

test('PENDING transitions to processing and persists in DB for owning merchant', async (t) => {
  const { app, mockPrisma } = await createTestApp({}, {
    merchants: [{ id: 'm1', ownerId: 'u1' }],
    settlements: [{ id: 'set_1', status: 'pending', merchantId: 'm1', totalAmount: '100.00', completedAt: null }],
  });
  const token = generateTestJwt(app, { merchantId: 'm1', ownerId: 'u1' });

  const res = await app.inject({
    method: 'PATCH',
    url: '/api/settlements/set_1/status',
    headers: { authorization: `Bearer ${token}`, 'x-csrf-check': '1' },
    payload: { status: 'processing' },
  });

  t.equal(res.statusCode, 200, 'returns 200');
  t.equal(JSON.parse(res.body).data.status, 'processing', 'updates to processing');

  const stored = await mockPrisma.settlement.findUnique({ where: { id: 'set_1' } });
  t.equal(stored.status, 'processing', 'updates status in mock DB');

  await app.close();
  t.end();
});

test('PROCESSING transitions to completed and sets completedAt in DB', async (t) => {
  const { app, mockPrisma } = await createTestApp({}, {
    merchants: [{ id: 'm1', ownerId: 'u1' }],
    settlements: [{ id: 'set_1', status: 'processing', merchantId: 'm1', totalAmount: '100.00', completedAt: null }],
  });
  const token = generateTestJwt(app, { merchantId: 'm1', ownerId: 'u1' });

  const res = await app.inject({
    method: 'PATCH',
    url: '/api/settlements/set_1/status',
    headers: { authorization: `Bearer ${token}`, 'x-csrf-check': '1' },
    payload: { status: 'completed' },
  });

  t.equal(res.statusCode, 200, 'returns 200');
  const body = JSON.parse(res.body);
  t.equal(body.data.status, 'completed', 'updates to completed');
  t.ok(body.data.completedAt, 'sets completedAt on terminal status');

  const stored = await mockPrisma.settlement.findUnique({ where: { id: 'set_1' } });
  t.ok(stored.completedAt, 'persists completedAt timestamp in mock DB');

  await app.close();
  t.end();
});

test('invalid transition returns 422', async (t) => {
  const { app } = await createTestApp({}, {
    merchants: [{ id: 'm1', ownerId: 'u1' }],
    settlements: [{ id: 'set_1', status: 'pending', merchantId: 'm1', totalAmount: '100.00', completedAt: null }],
  });
  const token = generateTestJwt(app, { merchantId: 'm1', ownerId: 'u1' });

  const res = await app.inject({
    method: 'PATCH',
    url: '/api/settlements/set_1/status',
    headers: { authorization: `Bearer ${token}`, 'x-csrf-check': '1' },
    payload: { status: 'completed' },
  });

  t.equal(res.statusCode, 422, 'returns 422');
  const body = JSON.parse(res.body);
  t.equal(body.error.details.from, 'pending', 'reports current status');
  t.ok(Array.isArray(body.error.details.allowedTransitions), 'includes allowedTransitions in error');

  await app.close();
  t.end();
});

test('missing settlement returns 404', async (t) => {
  const { app } = await createTestApp({}, {
    merchants: [{ id: 'm1', ownerId: 'u1' }],
    settlements: [],
  });
  const token = generateTestJwt(app, { merchantId: 'm1', ownerId: 'u1' });

  const res = await app.inject({
    method: 'PATCH',
    url: '/api/settlements/missing_set/status',
    headers: { authorization: `Bearer ${token}`, 'x-csrf-check': '1' },
    payload: { status: 'processing' },
  });

  t.equal(res.statusCode, 404, 'returns 404');
  await app.close();
  t.end();
});
