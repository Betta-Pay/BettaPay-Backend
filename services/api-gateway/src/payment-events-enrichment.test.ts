import test from 'tape';
import type { IndexerEvent } from './clients/indexer-client.js';
import {
  createTestApp,
  createMockIndexerClient,
  generateTestJwt,
} from './test-utils.js';
import { validateEnv } from '@bettapay/validation';

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

function paymentEvent(
  id: string,
  ledger: number,
  indexedAt: string,
  paymentId: string | null,
  topics: string[] = ['PaymentCompleted'],
): IndexerEvent {
  return {
    id,
    contractId: 'C1',
    topics,
    type: 'PaymentCompleted',
    rawValue: 'AAAA',
    decodedPayload: paymentId
      ? { payload: { payment: { id: paymentId } } }
      : { payload: { payment: { id: 'some_other_payment' } } },
    ledger,
    indexedAt,
  };
}

test('GET /api/payments/:id/events orders by ledger then timestamp and filters to the payment (#916)', async (t) => {
  const events = [
    paymentEvent('evt_ledger_2_late', 102, '2026-10-02T12:00:01.000Z', 'pay_1'),
    paymentEvent('evt_ledger_1_late', 101, '2026-10-02T12:00:02.000Z', 'pay_1'),
    paymentEvent('evt_ledger_1_early', 101, '2026-10-02T12:00:00.000Z', 'pay_1'),
    paymentEvent('evt_other_payment', 100, '2026-10-02T11:59:00.000Z', null),
    paymentEvent('evt_topic_match', 103, '2026-10-02T12:00:03.000Z', null, ['PaymentCompleted', 'pay_1']),
  ];
  const indexer = createMockIndexerClient({ async getPaymentEvents() { return events; } });
  const { app } = await createTestApp({ indexerClient: indexer }, { payments: [PAYMENT] });
  const token = generateTestJwt(app, { merchantId: 'merchant_1', ownerId: 'owner_1' });

  const res = await app.inject({
    method: 'GET',
    url: '/api/payments/pay_1/events',
    headers: { authorization: `Bearer ${token}` },
  });

  t.equal(res.statusCode, 200, 'returns 200 for the owning merchant');
  const body = JSON.parse(res.body);
  t.deepEqual(
    body.data.map((event: any) => event.id),
    ['evt_ledger_1_early', 'evt_ledger_1_late', 'evt_ledger_2_late', 'evt_topic_match'],
    'events are ledger-ascending, then timestamp-ascending, and only match this payment',
  );

  await app.close();
  t.end();
});

test('GET /api/payments/:id/events returns 404 for unknown ids and non-owners (#916)', async (t) => {
  let indexerCalls = 0;
  const indexer = createMockIndexerClient({
    async getPaymentEvents() {
      indexerCalls += 1;
      return [];
    },
  });
  const { app } = await createTestApp({ indexerClient: indexer }, { payments: [PAYMENT] });
  const nonOwner = generateTestJwt(app, { merchantId: 'merchant_2', ownerId: 'owner_2' });

  const unknown = await app.inject({ method: 'GET', url: '/api/payments/nope/events' });
  t.equal(unknown.statusCode, 401, 'unauthenticated request is rejected');

  const notOwned = await app.inject({
    method: 'GET',
    url: '/api/payments/pay_1/events',
    headers: { authorization: `Bearer ${nonOwner}` },
  });
  t.equal(notOwned.statusCode, 404, 'a non-owning merchant receives 404 (no existence leak)');

  const missing = await app.inject({
    method: 'GET',
    url: '/api/payments/pay_missing/events',
    headers: { authorization: `Bearer ${generateTestJwt(app, { merchantId: 'merchant_1' })}` },
  });
  t.equal(missing.statusCode, 404, 'an unknown payment id receives 404');
  t.equal(indexerCalls, 0, 'the indexer is not queried for unauthorized or missing payments');

  await app.close();
  t.end();
});

test('GET /api/payments/:id/events allows the configured admin and degrades honestly when the indexer is down (#916)', async (t) => {
  const env = validateEnv(process.env);
  const indexer = createMockIndexerClient({
    async getPaymentEvents() {
      return [paymentEvent('evt_1', 10, '2026-10-02T12:00:00.000Z', 'pay_1')];
    },
  });
  const { app } = await createTestApp({ indexerClient: indexer }, { payments: [PAYMENT] });
  const admin = generateTestJwt(app, { merchantId: env.ADMIN_ADDRESS, ownerId: 'admin' });

  const adminRes = await app.inject({
    method: 'GET',
    url: '/api/payments/pay_1/events',
    headers: { authorization: `Bearer ${admin}` },
  });
  t.equal(adminRes.statusCode, 200, 'admin may read any existing payment');

  const downIndexer = createMockIndexerClient({ async getPaymentEvents() { return null; } });
  const { app: downApp } = await createTestApp(
    { indexerClient: downIndexer },
    { payments: [PAYMENT] },
  );
  const owner = generateTestJwt(downApp, { merchantId: 'merchant_1', ownerId: 'owner_1' });
  const downRes = await downApp.inject({
    method: 'GET',
    url: '/api/payments/pay_1/events',
    headers: { authorization: `Bearer ${owner}` },
  });
  t.equal(downRes.statusCode, 503, 'indexer outage is a 503, not a fabricated empty trail');

  await app.close();
  await downApp.close();
  t.end();
});
