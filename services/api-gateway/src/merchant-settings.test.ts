import test from 'tape';
import { createTestApp, generateTestJwt } from './test-utils.js';

test('authorization: PATCH /api/merchants/:id/settings returns 401 without JWT', async (t) => {
  const { app } = await createTestApp({}, {
    merchants: [{ id: 'm1', settings: { tier: 'silver', autoSettle: true } }],
  });

  const res = await app.inject({
    method: 'PATCH',
    url: '/api/merchants/m1/settings',
    payload: { feeBps: 75 },
  });

  t.equal(res.statusCode, 401, 'returns 401 Unauthorized');
  await app.close();
  t.end();
});

test('updating feeBps merges into existing settings and persists in DB', async (t) => {
  const { app, mockPrisma } = await createTestApp(
    {},
    {
      merchants: [{
        id: 'm1',
        secretHash: 'encrypted-secret',
        settings: { tier: 'silver', autoSettle: true },
      }],
    },
  );
  const token = generateTestJwt(app);

  const res = await app.inject({
    method: 'PATCH',
    url: '/api/merchants/m1/settings',
    headers: { authorization: `Bearer ${token}` },
    payload: { feeBps: 75 },
  });

  t.equal(res.statusCode, 200, 'returns 200');
  const merchant = JSON.parse(res.body as string).data.merchant;
  const settings = merchant.settings;
  t.notOk('secretHash' in merchant, 'response omits secretHash');
  t.equal(settings.feeBps, 75, 'feeBps is set');
  t.equal(settings.autoSettle, true, 'unrelated settings are preserved');

  const stored = await mockPrisma.merchant.findUnique({ where: { id: 'm1' } });
  t.equal(stored.settings.feeBps, 75, 'persisted feeBps in mock database');

  await app.close();
  t.end();
});

test('PATCH settings forbids a different merchant owner and never returns secretHash', async (t) => {
  const { app } = await createTestApp(
    {},
    {
      merchants: [{
        id: 'm1',
        ownerId: 'owner-1',
        secretHash: 'encrypted-secret',
        settings: {},
      }],
    },
  );
  const foreignToken = generateTestJwt(app, {
    merchantId: 'm2',
    ownerId: 'owner-2',
  });
  const denied = await app.inject({
    method: 'PATCH',
    url: '/api/merchants/m1/settings',
    headers: { authorization: `Bearer ${foreignToken}` },
    payload: { feeBps: 75 },
  });
  t.equal(denied.statusCode, 403, 'cross-merchant owner receives 403');

  const ownerToken = generateTestJwt(app, {
    merchantId: 'm1',
    ownerId: 'owner-1',
  });
  const allowed = await app.inject({
    method: 'PATCH',
    url: '/api/merchants/m1/settings',
    headers: { authorization: `Bearer ${ownerToken}` },
    payload: { feeBps: 75 },
  });
  t.equal(allowed.statusCode, 200, 'owner can update settings');
  t.notOk(
    'secretHash' in JSON.parse(allowed.body).data.merchant,
    'successful response omits secretHash',
  );
  await app.close();
  t.end();
});

test('POST restore enforces ownership, audits the restore, and omits secretHash', async (t) => {
  const { app, mockPrisma } = await createTestApp(
    {},
    {
      merchants: [{
        id: 'm1',
        ownerId: 'owner-1',
        deletedAt: new Date('2026-01-01T00:00:00.000Z'),
        secretHash: 'encrypted-secret',
      }],
    },
  );
  const foreignToken = generateTestJwt(app, {
    merchantId: 'm2',
    ownerId: 'owner-2',
  });
  const denied = await app.inject({
    method: 'POST',
    url: '/api/merchants/m1/restore',
    headers: { authorization: `Bearer ${foreignToken}` },
  });
  t.equal(denied.statusCode, 403, 'cross-merchant owner receives 403');
  t.equal(
    mockPrisma.store.auditLogs.length,
    0,
    'denied restore is not audited as a restore',
  );

  const ownerToken = generateTestJwt(app, {
    merchantId: 'm1',
    ownerId: 'owner-1',
  });
  const restored = await app.inject({
    method: 'POST',
    url: '/api/merchants/m1/restore',
    headers: { authorization: `Bearer ${ownerToken}` },
  });
  const body = JSON.parse(restored.body);
  t.equal(restored.statusCode, 200, 'owner can restore the merchant');
  t.notOk('secretHash' in body.merchant, 'response omits secretHash');
  t.equal(
    mockPrisma.store.auditLogs[0]?.action,
    'merchant.restored',
    'restore is audit logged',
  );
  t.equal(mockPrisma.store.merchants[0].deletedAt, null, 'merchant is restored');
  await app.close();
  t.end();
});

test('updating feeSchedules merges into existing settings and persists in DB', async (t) => {
  const { app, mockPrisma } = createTestApp({}, {
    merchants: [{ id: 'm1', settings: { tier: 'silver', autoSettle: true } }],
  });
  const token = generateTestJwt(app);

  const res = await app.inject({
    method: 'PATCH',
    url: '/api/merchants/m1/settings',
    headers: { authorization: `Bearer ${token}` },
    payload: { feeSchedules: [{ asset: 'USDC', bps: 50 }, { asset: 'EURT', bps: 75 }] },
  });

  t.equal(res.statusCode, 200, 'returns 200');
  const settings = JSON.parse(res.body as string).merchant.settings;
  t.deepEqual(settings.feeSchedules, [{ asset: 'USDC', bps: 50 }, { asset: 'EURT', bps: 75 }], 'feeSchedules is set');
  t.equal(settings.autoSettle, true, 'unrelated settings are preserved');

  const stored = await mockPrisma.merchant.findUnique({ where: { id: 'm1' } });
  t.deepEqual(stored.settings.feeSchedules, [{ asset: 'USDC', bps: 50 }, { asset: 'EURT', bps: 75 }], 'persisted feeSchedules in mock database');

  await app.close();
  t.end();
});

test('providing both feeBps and feeSchedules returns 422', async (t) => {
  const { app, mockPrisma } = createTestApp({}, {
    merchants: [{ id: 'm1', settings: {} }],
  });
  const token = generateTestJwt(app);

  const res = await app.inject({
    method: 'PATCH',
    url: '/api/merchants/m1/settings',
    headers: { authorization: `Bearer ${token}` },
    payload: { feeBps: 75, feeSchedules: [{ asset: 'USDC', bps: 50 }] },
  });

  t.equal(res.statusCode, 422, 'returns 422 when both feeBps and feeSchedules provided');
  const body = JSON.parse(res.body as string);
  t.ok(body.error.message.includes('Cannot provide both feeBps and feeSchedules'), 'error message mentions conflict');

  await app.close();
  t.end();
});

test('updating a missing merchant returns 404', async (t) => {
  const { app } = await createTestApp({}, { merchants: [] });
  const token = generateTestJwt(app);

  const res = await app.inject({
    method: 'PATCH',
    url: '/api/merchants/m1/settings',
    headers: { authorization: `Bearer ${token}` },
    payload: { feeBps: 75 },
  });

  t.equal(res.statusCode, 404, 'returns 404');
  await app.close();
  t.end();
});

test('an out-of-range feeBps is rejected', async (t) => {
  const { app } = await createTestApp({}, {
    merchants: [{ id: 'm1', settings: {} }],
  });
  const token = generateTestJwt(app);

  const res = await app.inject({
    method: 'PATCH',
    url: '/api/merchants/m1/settings',
    headers: { authorization: `Bearer ${token}` },
    payload: { feeBps: 20000 },
  });

  t.equal(res.statusCode, 400, 'returns 400 for feeBps above 10000');
  await app.close();
  t.end();
});

test('an out-of-range feeSchedules bps is rejected', async (t) => {
  const { app } = createTestApp({}, {
    merchants: [{ id: 'm1', settings: {} }],
  });
  const token = generateTestJwt(app);

  const res = await app.inject({
    method: 'PATCH',
    url: '/api/merchants/m1/settings',
    headers: { authorization: `Bearer ${token}` },
    payload: { feeSchedules: [{ asset: 'USDC', bps: 20000 }] },
  });

  t.equal(res.statusCode, 400, 'returns 400 for feeSchedules bps above 10000');
  await app.close();
  t.end();
});

test('feeSchedules requires asset and bps fields', async (t) => {
  const { app } = createTestApp({}, {
    merchants: [{ id: 'm1', settings: {} }],
  });
  const token = generateTestJwt(app);

  const res = await app.inject({
    method: 'PATCH',
    url: '/api/merchants/m1/settings',
    headers: { authorization: `Bearer ${token}` },
    payload: { feeSchedules: [{ asset: 'USDC' }] }, // missing bps
  });

  t.equal(res.statusCode, 400, 'returns 400 for missing bps');
  await app.close();
  t.end();
});
