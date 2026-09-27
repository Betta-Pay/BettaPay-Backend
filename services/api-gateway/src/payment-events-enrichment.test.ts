import test from 'tape';
import type { IndexerEvent } from './clients/indexer-client.js';
import { createTestApp, createMockIndexerClient } from './test-utils.js';

const PAYMENT = { id: 'pay_1', merchantId: 'merchant_1', status: 'completed', amount: '10.00', asset: 'USDC' };

const sampleEvents: IndexerEvent[] = [
  { id: 'evt_0', contractId: 'C1', topics: ['PaymentCompleted'], type: 'PaymentCompleted', rawValue: 'AAAA', ledger: 100, indexedAt: 'now' },
];

test('includeEvents=true enriches the payment with indexer events', async (t) => {
  let askedFor = '';
  const indexer = createMockIndexerClient({
    async getPaymentEvents(merchantId) {
      askedFor = merchantId;
      return sampleEvents;
    },
  });

  const { app } = await createTestApp({ indexerClient: indexer }, { payments: [PAYMENT] });
  const res = await app.inject({ method: 'GET', url: '/api/payments/pay_1?includeEvents=true' });
  const body = JSON.parse(res.body);

  t.equal(res.statusCode, 200, 'returns 200');
  t.equal(askedFor, 'merchant_1', 'queries indexer with the payment merchantId');
  t.equal(body.data.id, 'pay_1', 'still returns the payment');
  t.equal(body.data.events.length, 1, 'includes the on-chain events');
  await app.close();
  t.end();
});

test('indexer unavailability degrades to payment data with events: null', async (t) => {
  const indexer = createMockIndexerClient({
    async getPaymentEvents() {
      return null; // simulates indexer down / timeout
    },
  });

  const { app } = await createTestApp({ indexerClient: indexer }, { payments: [PAYMENT] });
  const res = await app.inject({ method: 'GET', url: '/api/payments/pay_1?includeEvents=true' });
  const body = JSON.parse(res.body);

  t.equal(res.statusCode, 200, 'still returns 200 despite indexer being down');
  t.equal(body.data.id, 'pay_1', 'payment data is returned');
  t.equal(body.data.events, null, 'events is null (gracefully degraded)');
  await app.close();
  t.end();
});

test('without includeEvents the indexer is not queried', async (t) => {
  let called = false;
  const indexer = createMockIndexerClient({
    async getPaymentEvents() {
      called = true;
      return sampleEvents;
    },
  });

  const { app } = await createTestApp({ indexerClient: indexer }, { payments: [PAYMENT] });
  const res = await app.inject({ method: 'GET', url: '/api/payments/pay_1' });
  const body = JSON.parse(res.body);

  t.equal(res.statusCode, 200, 'returns 200');
  t.notOk(called, 'indexer client is not called');
  t.equal(body.data.events, undefined, 'no events field on the default response');
  await app.close();
  t.end();
});

test('a missing payment returns 404 regardless of includeEvents', async (t) => {
  const indexer = createMockIndexerClient();
  const { app } = await createTestApp({ indexerClient: indexer }, { payments: [] });
  const res = await app.inject({ method: 'GET', url: '/api/payments/nope?includeEvents=true' });
  t.equal(res.statusCode, 404, 'returns 404 Not Found');
  await app.close();
  t.end();
});
