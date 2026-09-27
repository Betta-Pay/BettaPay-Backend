import test from 'tape';
import type { IndexerClient, IndexerEvent } from './clients/indexer-client.js';
import { validateEnv } from '@bettapay/validation';
import { buildApp } from './index.js';
import { createMockPrisma, generateTestJwt } from './test-utils.js';

const env = validateEnv(process.env);
const SERVICE_TOKEN = env.INTER_SERVICE_SECRET || 'inter-service-secret-value';

interface FakePayment {
  id: string;
  merchantId: string;
  status: 'initiated' | 'completed' | 'failed' | 'cancelled';
  amount: string;
  asset: string;
  createdAt: Date;
}

function makePayments(merchantId: string, count: number): FakePayment[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `${merchantId}_p${i}`,
    merchantId,
    status: 'completed',
    amount: '10.00',
    asset: 'USDC',
    createdAt: new Date(Date.now() - i * 60000),
  }));
}

function eventsFor(merchantId: string): IndexerEvent[] {
  return [
    {
      id: `evt_${merchantId}`,
      contractId: 'C1',
      topics: ['PaymentCompleted'],
      type: 'PaymentCompleted',
      rawValue: 'AAAA',
      ledger: 100,
      indexedAt: 'now',
    },
  ];
}

test('Payment listing: paginates and scopes to the authenticated merchant', async (t) => {
  const payments = [...makePayments('merchant-a', 2), ...makePayments('merchant-b', 3)];
  const app = buildApp({ prisma: createMockPrisma({ payments }) as any, logger: false });
  await app.ready();
  const token = generateTestJwt(app, { merchantId: 'merchant-a', ownerId: 'owner-a' });

  const res = await app.inject({
    method: 'GET',
    url: '/api/payments?merchantId=merchant-b',
    headers: { authorization: `Bearer ${token}` },
  });

  t.equal(res.statusCode, 200, 'returns 200');
  const body = JSON.parse(res.body);
  t.equal(body.data.length, 2, 'only merchant-a payments are returned');
  t.ok(
    body.data.every((p: FakePayment) => p.merchantId === 'merchant-a'),
    'foreign merchantId query param is ignored for JWT callers',
  );
  t.equal(body.pagination.total, 2, 'pagination total reflects only merchant-a payments');

  await app.close();
  t.end();
});

test('Payment listing: unauthenticated requests are rejected with 401', async (t) => {
  const app = buildApp({ prisma: createMockPrisma({ payments: makePayments('merchant-a', 2) }) as any, logger: false });
  await app.ready();

  const res = await app.inject({ method: 'GET', url: '/api/payments' });
  t.equal(res.statusCode, 401, 'returns 401 without any authentication');

  await app.close();
  t.end();
});

test('Payment listing: without includeEvents the indexer is never queried', async (t) => {
  let calls = 0;
  const indexer: IndexerClient = {
    async getPaymentEvents(merchantId) {
      calls += 1;
      return eventsFor(merchantId);
    },
  };
  const payments = makePayments('merchant-a', 5);
  const app = buildApp({
    prisma: createMockPrisma({ payments }) as any,
    indexerClient: indexer,
    logger: false,
  });
  await app.ready();
  const token = generateTestJwt(app, { merchantId: 'merchant-a', ownerId: 'owner-a' });

  const res = await app.inject({
    method: 'GET',
    url: '/api/payments',
    headers: { authorization: `Bearer ${token}` },
  });

  t.equal(res.statusCode, 200, 'returns 200');
  t.equal(calls, 0, 'indexer client is not called');
  const body = JSON.parse(res.body);
  t.equal(body.data.length, 5, 'still returns all payments');
  t.equal(body.data[0].events, undefined, 'no events field without includeEvents');

  await app.close();
  t.end();
});

test('Payment listing bulk enrichment: one indexer call per page regardless of page size (#553)', async (t) => {
  let calls = 0;
  const indexer: IndexerClient = {
    async getPaymentEvents(merchantId) {
      calls += 1;
      return eventsFor(merchantId);
    },
  };
  // 20 payments, all for the same merchant — the naive per-payment approach
  // would call the indexer 20 times.
  const payments = makePayments('merchant-a', 20);
  const app = buildApp({
    prisma: createMockPrisma({ payments }) as any,
    indexerClient: indexer,
    logger: false,
  });
  await app.ready();
  const token = generateTestJwt(app, { merchantId: 'merchant-a', ownerId: 'owner-a' });

  const res = await app.inject({
    method: 'GET',
    url: '/api/payments?includeEvents=true&limit=20',
    headers: { authorization: `Bearer ${token}` },
  });

  t.equal(res.statusCode, 200, 'returns 200');
  const body = JSON.parse(res.body);
  t.equal(body.data.length, 20, 'returns all 20 payments');
  t.equal(calls, 1, 'indexer is called exactly once for the whole page, not once per payment');
  t.ok(
    body.data.every((p: any) => Array.isArray(p.events) && p.events.length === 1),
    'every payment in the page is enriched with events',
  );

  await app.close();
  t.end();
});

test('Payment listing bulk enrichment: batches per unique merchantId, not per payment', async (t) => {
  let calls = 0;
  const seenMerchantIds: string[] = [];
  const indexer: IndexerClient = {
    async getPaymentEvents(merchantId) {
      calls += 1;
      seenMerchantIds.push(merchantId);
      return eventsFor(merchantId);
    },
  };
  // 2 merchants, 5 payments each = 10 payments across 2 distinct merchants.
  const payments = [...makePayments('merchant-a', 5), ...makePayments('merchant-b', 5)];
  const app = buildApp({
    prisma: createMockPrisma({ payments }) as any,
    indexerClient: indexer,
    logger: false,
  });
  await app.ready();

  const res = await app.inject({
    method: 'GET',
    url: '/api/payments?includeEvents=true&limit=10',
    headers: { 'x-service-token': SERVICE_TOKEN },
  });

  t.equal(res.statusCode, 200, 'returns 200');
  const body = JSON.parse(res.body);
  t.equal(body.data.length, 10, 'returns all 10 payments');
  t.equal(calls, 2, 'indexer is called once per unique merchantId, not once per payment');
  t.deepEqual(
    [...new Set(seenMerchantIds)].sort(),
    ['merchant-a', 'merchant-b'],
    'each distinct merchant is looked up exactly once',
  );

  await app.close();
  t.end();
});

test('Payment listing bulk enrichment: indexer unavailability degrades every payment to events: null', async (t) => {
  const indexer: IndexerClient = {
    async getPaymentEvents() {
      return null; // simulates indexer down / timeout
    },
  };
  const payments = makePayments('merchant-a', 3);
  const app = buildApp({
    prisma: createMockPrisma({ payments }) as any,
    indexerClient: indexer,
    logger: false,
  });
  await app.ready();
  const token = generateTestJwt(app, { merchantId: 'merchant-a', ownerId: 'owner-a' });

  const res = await app.inject({
    method: 'GET',
    url: '/api/payments?includeEvents=true',
    headers: { authorization: `Bearer ${token}` },
  });

  t.equal(res.statusCode, 200, 'still returns 200 despite indexer being down');
  const body = JSON.parse(res.body);
  t.equal(body.data.length, 3, 'payment data is still returned');
  t.ok(
    body.data.every((p: any) => p.events === null),
    'every payment gracefully degrades to events: null',
  );

  await app.close();
  t.end();
});
