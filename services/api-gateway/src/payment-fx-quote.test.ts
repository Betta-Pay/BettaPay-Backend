import test from 'tape';
import { createTestApp, generateTestJwt, createMockFxClient } from './test-utils.js';
import { MOCK_MERCHANT_ACTIVE } from './test-fixtures.js';

test('POST /api/payments fetches an FX quote when convertTo is provided', async (t) => {
  let quoteRequest: { from: string; to: string; amount: string } | undefined;
  const mockFxClient = createMockFxClient({
    getQuote: async (request: { from: string; to: string; amount: string }) => {
      quoteRequest = request;
      return { quoteId: 'quote_1', result: '15455.0000' };
    },
  });

  const { app, mockPrisma } = await createTestApp(
    { fxClient: mockFxClient as any },
    { merchants: [{ ...MOCK_MERCHANT_ACTIVE }] },
  );
  const token = generateTestJwt(app);

  const res = await app.inject({
    method: 'POST',
    url: '/api/payments',
    headers: { authorization: `Bearer ${token}` },
    payload: {
      merchantId: MOCK_MERCHANT_ACTIVE.id,
      amount: '10.00',
      asset: 'USDC',
      convertTo: 'NGN',
    },
  });

  const body = JSON.parse(res.body);
  t.equal(res.statusCode, 201, 'creates the payment');
  t.same(quoteRequest, { from: 'USDC', to: 'NGN', amount: '10.00' }, 'requests the matching quote');
  t.equal(body.data.fxQuote.quoteId, 'quote_1', 'includes the quote in the response');

  const stored = await mockPrisma.payment.findUnique({ where: { id: body.data.id } });
  t.ok(stored, 'persists payment in mock database');

  await app.close();
  t.end();
});

test('POST /api/payments does not call FX when convertTo is absent', async (t) => {
  let calls = 0;
  const mockFxClient = createMockFxClient({
    getQuote: async () => {
      calls += 1;
      return { quoteId: 'quote_1' };
    },
  });

  const { app } = await createTestApp(
    { fxClient: mockFxClient as any },
    { merchants: [{ ...MOCK_MERCHANT_ACTIVE }] },
  );
  const token = generateTestJwt(app);

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

  const body = JSON.parse(res.body);
  t.equal(res.statusCode, 201, 'creates the payment');
  t.equal(calls, 0, 'does not call fx-engine');
  t.notOk('fxQuote' in body.data, 'preserves the legacy response shape');

  await app.close();
  t.end();
});

test('POST /api/payments still creates payment when FX quote is unavailable', async (t) => {
  const mockFxClient = createMockFxClient({
    getQuote: async () => null,
  });

  const { app } = await createTestApp(
    { fxClient: mockFxClient as any },
    { merchants: [{ ...MOCK_MERCHANT_ACTIVE }] },
  );
  const token = generateTestJwt(app);

  const res = await app.inject({
    method: 'POST',
    url: '/api/payments',
    headers: { authorization: `Bearer ${token}` },
    payload: {
      merchantId: MOCK_MERCHANT_ACTIVE.id,
      amount: '10.00',
      asset: 'USDC',
      convertTo: 'EURT',
    },
  });

  const body = JSON.parse(res.body);
  t.equal(res.statusCode, 201, 'creates the payment despite quote failure');
  t.equal(body.data.fxQuote, null, 'surfaces graceful fallback in the response');
  t.equal(body.data.status, 'initiated', 'payment remains initiated');

  await app.close();
  t.end();
});
