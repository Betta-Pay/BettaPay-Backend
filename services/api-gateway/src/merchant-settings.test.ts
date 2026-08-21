import test from 'tape';
import { createTestApp, generateTestJwt } from './test-utils.js';

test('authorization: PATCH /api/merchants/:id/settings returns 401 without JWT', async (t) => {
  const { app } = createTestApp({}, {
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
  const { app, mockPrisma } = createTestApp({}, {
    merchants: [{ id: 'm1', settings: { tier: 'silver', autoSettle: true } }],
  });
  await app.ready();
  const token = generateTestJwt(app);

  const res = await app.inject({
    method: 'PATCH',
    url: '/api/merchants/m1/settings',
    headers: { authorization: `Bearer ${token}` },
    payload: { feeBps: 75 },
  });

  t.equal(res.statusCode, 200, 'returns 200');
  const settings = JSON.parse(res.body as string).data.merchant.settings;
  t.equal(settings.feeBps, 75, 'feeBps is set');
  t.equal(settings.autoSettle, true, 'unrelated settings are preserved');

  const stored = await mockPrisma.merchant.findUnique({ where: { id: 'm1' } });
  t.equal(stored.settings.feeBps, 75, 'persisted feeBps in mock database');

  await app.close();
  t.end();
});

test('updating a missing merchant returns 404', async (t) => {
  const { app } = createTestApp({}, { merchants: [] });
  await app.ready();
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
  const { app } = createTestApp({}, {
    merchants: [{ id: 'm1', settings: {} }],
  });
  await app.ready();
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

test('invalid business settings formats are rejected', async (t) => {
  const { app } = createTestApp({}, {
    merchants: [{ id: 'm1', settings: {} }],
  });
  await app.ready();
  const token = generateTestJwt(app);

  // 1. Invalid email format
  const resEmail = await app.inject({
    method: 'PATCH',
    url: '/api/merchants/m1/settings',
    headers: { authorization: `Bearer ${token}` },
    payload: { supportEmail: 'not-an-email' },
  });
  t.equal(resEmail.statusCode, 400, 'should reject invalid supportEmail format');

  // 2. businessName exceeds length cap (100 characters)
  const resName = await app.inject({
    method: 'PATCH',
    url: '/api/merchants/m1/settings',
    headers: { authorization: `Bearer ${token}` },
    payload: { businessName: 'a'.repeat(101) },
  });
  t.equal(resName.statusCode, 400, 'should reject overly long businessName');

  // 3. supportAddress exceeds length cap (255 characters)
  const resAddress = await app.inject({
    method: 'PATCH',
    url: '/api/merchants/m1/settings',
    headers: { authorization: `Bearer ${token}` },
    payload: { supportAddress: 'a'.repeat(256) },
  });
  t.equal(resAddress.statusCode, 400, 'should reject overly long supportAddress');

  // 4. tier exceeds length cap (50 characters)
  const resTier = await app.inject({
    method: 'PATCH',
    url: '/api/merchants/m1/settings',
    headers: { authorization: `Bearer ${token}` },
    payload: { tier: 'a'.repeat(51) },
  });
  t.equal(resTier.statusCode, 400, 'should reject overly long tier');

  await app.close();
  t.end();
});

test('XSS HTML payload in settings free-text fields is escaped and neutralized', async (t) => {
  const { app, mockPrisma } = createTestApp({}, {
    merchants: [{ id: 'm1', settings: {} }],
  });
  await app.ready();
  const token = generateTestJwt(app);

  const res = await app.inject({
    method: 'PATCH',
    url: '/api/merchants/m1/settings',
    headers: { authorization: `Bearer ${token}` },
    payload: {
      businessName: '<script>alert("xss")</script> Betta',
      supportAddress: '<a href="javascript:void(0)">Main Rd</a>',
      tier: '<b>Gold</b>',
      supportEmail: 'support@betta.com',
    },
  });

  t.equal(res.statusCode, 200, 'accepts valid payload structure');
  
  const settings = JSON.parse(res.body as string).data.merchant.settings;
  t.equal(settings.businessName, '&lt;script&gt;alert(&quot;xss&quot;)&lt;&#x2F;script&gt; Betta', 'businessName HTML is escaped');
  t.equal(settings.supportAddress, '&lt;a href=&quot;javascript:void(0)&quot;&gt;Main Rd&lt;&#x2F;a&gt;', 'supportAddress HTML is escaped');
  t.equal(settings.tier, '&lt;b&gt;Gold&lt;&#x2F;b&gt;', 'tier HTML is escaped');

  const stored = await mockPrisma.merchant.findUnique({ where: { id: 'm1' } });
  t.equal(stored.settings.businessName, '&lt;script&gt;alert(&quot;xss&quot;)&lt;&#x2F;script&gt; Betta', 'persisted businessName is escaped');

  await app.close();
  t.end();
});
