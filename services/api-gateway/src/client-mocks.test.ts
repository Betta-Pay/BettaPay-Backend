import test from 'tape';
import {
  createTestApp,
  generateTestJwt,
  createMockSettlementClient,
  createMockFxClient,
  createMockIndexerClient,
} from './test-utils.js';
import { SettlementEngineUnavailableError } from './clients/settlement-client.js';
import { MOCK_MERCHANT_ACTIVE, MOCK_SUPPORTED_ASSET_USDC } from './test-fixtures.js';

test('client-mocks: settlementClient throwing SettlementEngineUnavailableError returns 504', async (t) => {
  const settlementClient = createMockSettlementClient({
    createSettlement: async () => {
      throw new SettlementEngineUnavailableError('settlement-engine down');
    },
  });

  const { app } = await createTestApp(
    {
      settlementClient: settlementClient as any,
    },
    {
      merchants: [{ id: 'merch_1', settings: {} }],
      supportedAssets: [MOCK_SUPPORTED_ASSET_USDC],
    },
  );

  const token = generateTestJwt(app);

  const res = await app.inject({
    method: 'POST',
    url: '/api/settlements',
    headers: {
      authorization: `Bearer ${token}`,
    },
    payload: {
      merchantId: 'merch_1',
      items: [{ amount: '50.00', asset: 'USDC' }],
    },
  });

  t.equal(res.statusCode, 504, 'returns 504 Gateway Timeout');
  const body = JSON.parse(res.body);
  t.equal(body.error.code, 'GATEWAY_TIMEOUT');
  t.equal(body.error.message, 'Settlement engine unavailable');

  await app.close();
  t.end();
});

test('client-mocks: settlementClient throwing unexpected error returns 500', async (t) => {
  const settlementClient = createMockSettlementClient({
    createSettlement: async () => {
      throw new Error('Unexpected network split');
    },
  });

  const { app } = await createTestApp(
    {
      settlementClient: settlementClient as any,
    },
    {
      merchants: [{ id: 'merch_1', settings: {} }],
      supportedAssets: [MOCK_SUPPORTED_ASSET_USDC],
    },
  );

  const token = generateTestJwt(app);

  const res = await app.inject({
    method: 'POST',
    url: '/api/settlements',
    headers: {
      authorization: `Bearer ${token}`,
    },
    payload: {
      merchantId: 'merch_1',
      items: [{ amount: '50.00', asset: 'USDC' }],
    },
  });

  t.equal(res.statusCode, 500, 'returns 500 Internal Server Error');

  await app.close();
  t.end();
});

test('client-mocks: fxClient returning null falls back gracefully on payment creation', async (t) => {
  const fxClient = createMockFxClient({
    getQuote: async () => null, // mock quote lookup failure / unavailable
  });

  const { app } = await createTestApp(
    {
      fxClient: fxClient as any,
    },
    {
      merchants: [{ ...MOCK_MERCHANT_ACTIVE }],
    },
  );

  const token = generateTestJwt(app);

  const res = await app.inject({
    method: 'POST',
    url: '/api/payments',
    headers: {
      authorization: `Bearer ${token}`,
    },
    payload: {
      merchantId: MOCK_MERCHANT_ACTIVE.id,
      amount: '10.00',
      asset: 'USDC',
      convertTo: 'EURT',
    },
  });

  t.equal(res.statusCode, 201, 'succeeds with 201 Created');
  const body = JSON.parse(res.body);
  t.equal(body.data.fxQuote, null, 'fxQuote should be null in response');
  t.equal(body.data.status, 'initiated', 'payment session still initialized');

  await app.close();
  t.end();
});

test('client-mocks: indexerClient returning null falls back gracefully on payment query', async (t) => {
  const indexerClient = createMockIndexerClient({
    getPaymentEvents: async () => null, // mock indexer down
  });

  const PAYMENT = { id: 'pay_1', merchantId: 'merchant_1', status: 'completed', amount: '10.00', asset: 'USDC' };

  const { app } = await createTestApp(
    {
      indexerClient: indexerClient as any,
    },
    {
      payments: [PAYMENT],
    },
  );

  const res = await app.inject({
    method: 'GET',
    url: '/api/payments/pay_1?includeEvents=true',
  });

  t.equal(res.statusCode, 200, 'returns 200 OK');
  const body = JSON.parse(res.body);
  t.equal(body.data.events, null, 'events field is null on indexer failure');

  await app.close();
  t.end();
});
