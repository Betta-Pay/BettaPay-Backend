import test from 'tape';
import { validateEnv } from '@bettapay/validation';
import { buildApp } from './index.js';
import { createMockPrisma, generateTestJwt } from './test-utils.js';

const env = validateEnv(process.env);
const SERVICE_TOKEN = env.INTER_SERVICE_SECRET || 'inter-service-secret-value';

interface FakeSettlement {
  id: string;
  merchantId: string;
  totalAmount: string;
  grossAmount: string;
  feeAmount: string;
  netAmount: string;
  feeBps: number;
  asset: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  initiatedAt: Date;
  completedAt?: Date;
}

function makeSettlements(merchantId: string, count: number): FakeSettlement[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `${merchantId}_s${i}`,
    merchantId,
    totalAmount: '100.00',
    grossAmount: '100.00',
    feeAmount: '0.00',
    netAmount: '100.00',
    feeBps: 0,
    asset: 'USDC',
    status: 'completed',
    initiatedAt: new Date(Date.now() - i * 60000),
  }));
}

test('Settlement listing pagination: page 1 of 3 (13 total, limit 5)', async (t) => {
  const settlements = makeSettlements('merchant-1', 13);
  const app = buildApp({ prisma: createMockPrisma({ settlements }) as any, logger: false });
  await app.ready();
  const token = generateTestJwt(app, { merchantId: 'merchant-1', ownerId: 'owner-1' });

  const res = await app.inject({
    method: 'GET',
    url: '/api/settlements?page=1&limit=5',
    headers: { authorization: `Bearer ${token}` },
  });

  t.equal(res.statusCode, 200, 'returns 200');
  const body = JSON.parse(res.body);
  t.equal(body.data.length, 5, 'returns 5 records');
  t.equal(body.pagination.page, 1, 'page is 1');
  t.equal(body.pagination.limit, 5, 'limit is 5');
  t.equal(body.pagination.total, 13, 'total is 13');
  t.equal(body.pagination.totalPages, 3, 'totalPages is 3');
  t.equal(body.pagination.hasNext, true, 'hasNext is true');
  t.equal(body.pagination.hasPrev, false, 'hasPrev is false');

  await app.close();
  t.end();
});

test('Settlement listing pagination: page 3 of 3 (13 total, limit 5)', async (t) => {
  const settlements = makeSettlements('merchant-1', 13);
  const app = buildApp({ prisma: createMockPrisma({ settlements }) as any, logger: false });
  await app.ready();
  const token = generateTestJwt(app, { merchantId: 'merchant-1', ownerId: 'owner-1' });

  const res = await app.inject({
    method: 'GET',
    url: '/api/settlements?page=3&limit=5',
    headers: { authorization: `Bearer ${token}` },
  });

  t.equal(res.statusCode, 200, 'returns 200');
  const body = JSON.parse(res.body);
  t.equal(body.data.length, 3, 'returns the remaining 3 records');
  t.equal(body.pagination.page, 3, 'page is 3');
  t.equal(body.pagination.totalPages, 3, 'totalPages is 3');
  t.equal(body.pagination.hasNext, false, 'hasNext is false');
  t.equal(body.pagination.hasPrev, true, 'hasPrev is true');

  await app.close();
  t.end();
});

test('Settlement listing pagination: total 0 gives totalPages 0 and hasNext false', async (t) => {
  const app = buildApp({ prisma: createMockPrisma({ settlements: [] }) as any, logger: false });
  await app.ready();
  const token = generateTestJwt(app, { merchantId: 'merchant-empty', ownerId: 'owner-1' });

  const res = await app.inject({
    method: 'GET',
    url: '/api/settlements',
    headers: { authorization: `Bearer ${token}` },
  });

  t.equal(res.statusCode, 200, 'returns 200');
  const body = JSON.parse(res.body);
  t.equal(body.pagination.total, 0, 'total is 0');
  t.equal(body.pagination.totalPages, 0, 'totalPages is 0, not 1');
  t.equal(body.pagination.hasNext, false, 'hasNext is false');

  await app.close();
  t.end();
});

test('Settlement listing pagination: limit above 100 is rejected with 400', async (t) => {
  const settlements = makeSettlements('merchant-1', 5);
  const app = buildApp({ prisma: createMockPrisma({ settlements }) as any, logger: false });
  await app.ready();
  const token = generateTestJwt(app, { merchantId: 'merchant-1', ownerId: 'owner-1' });

  const res = await app.inject({
    method: 'GET',
    url: '/api/settlements?limit=101',
    headers: { authorization: `Bearer ${token}` },
  });

  t.equal(res.statusCode, 400, 'returns 400 for limit above the maximum');

  await app.close();
  t.end();
});

test('Settlement listing scope: merchant JWT ignores a foreign merchantId query param', async (t) => {
  const settlements = [...makeSettlements('merchant-a', 2), ...makeSettlements('merchant-b', 3)];
  const app = buildApp({ prisma: createMockPrisma({ settlements }) as any, logger: false });
  await app.ready();
  const token = generateTestJwt(app, { merchantId: 'merchant-a', ownerId: 'owner-a' });

  const res = await app.inject({
    method: 'GET',
    url: '/api/settlements?merchantId=merchant-b',
    headers: { authorization: `Bearer ${token}` },
  });

  t.equal(res.statusCode, 200, 'returns 200');
  const body = JSON.parse(res.body);
  t.equal(body.data.length, 2, 'only merchant-a settlements are returned');
  t.ok(
    body.data.every((s: FakeSettlement) => s.merchantId === 'merchant-a'),
    'no merchant-b settlements leak into the response'
  );
  t.equal(body.pagination.total, 2, 'total reflects only merchant-a settlements');

  await app.close();
  t.end();
});

test('Settlement listing scope: service-auth may filter by merchantId', async (t) => {
  const settlements = [...makeSettlements('merchant-a', 2), ...makeSettlements('merchant-b', 3)];
  const app = buildApp({ prisma: createMockPrisma({ settlements }) as any, logger: false });

  const res = await app.inject({
    method: 'GET',
    url: '/api/settlements?merchantId=merchant-a',
    headers: { 'x-service-token': SERVICE_TOKEN },
  });

  t.equal(res.statusCode, 200, 'returns 200');
  const body = JSON.parse(res.body);
  t.equal(body.data.length, 2, 'returns merchant-a settlements');
  t.ok(
    body.data.every((s: FakeSettlement) => s.merchantId === 'merchant-a'),
    'only merchant-a settlements are returned'
  );

  await app.close();
  t.end();
});

test('Settlement listing scope: unauthenticated requests are rejected with 401', async (t) => {
  const settlements = makeSettlements('merchant-a', 2);
  const app = buildApp({ prisma: createMockPrisma({ settlements }) as any, logger: false });

  const res = await app.inject({
    method: 'GET',
    url: '/api/settlements',
  });

  t.equal(res.statusCode, 401, 'returns 401 without any authentication');

  await app.close();
  t.end();
});

test('Settlement listing parses includeDeleted strictly and restricts deleted records', async (t) => {
  const settlements = makeSettlements('deleted-merchant', 1);
  const app = buildApp({
    prisma: createMockPrisma({
      settlements,
      merchants: [{ id: 'deleted-merchant', deletedAt: new Date() }],
    }) as any,
    logger: false,
  });
  await app.ready();
  const token = generateTestJwt(app, {
    merchantId: 'deleted-merchant',
    ownerId: 'owner-1',
  });

  const falseValue = await app.inject({
    method: 'GET',
    url: '/api/settlements?includeDeleted=false',
    headers: { authorization: `Bearer ${token}` },
  });
  t.equal(falseValue.statusCode, 200, 'includeDeleted=false is accepted');
  t.equal(JSON.parse(falseValue.body).data.length, 0, 'false excludes deleted merchants');

  const forbidden = await app.inject({
    method: 'GET',
    url: '/api/settlements?includeDeleted=true',
    headers: { authorization: `Bearer ${token}` },
  });
  t.equal(forbidden.statusCode, 403, 'non-admin JWT cannot include deleted settlements');

  const serviceAdmin = await app.inject({
    method: 'GET',
    url: '/api/settlements?includeDeleted=true',
    headers: { 'x-service-token': SERVICE_TOKEN },
  });
  t.equal(serviceAdmin.statusCode, 200, 'service-auth admin can include deleted settlements');
  t.equal(JSON.parse(serviceAdmin.body).data.length, 1, 'admin receives deleted settlement');

  const adminJwt = generateTestJwt(app, {
    merchantId: process.env.ADMIN_ADDRESS || 'GA_TEST',
    ownerId: 'admin',
  });
  const adminJwtResponse = await app.inject({
    method: 'GET',
    url: '/api/settlements?includeDeleted=true',
    headers: { authorization: `Bearer ${adminJwt}` },
  });
  t.equal(adminJwtResponse.statusCode, 200, 'admin JWT can include deleted settlements');
  t.equal(JSON.parse(adminJwtResponse.body).data.length, 1, 'admin JWT is not merchant-scoped');

  const invalid = await app.inject({
    method: 'GET',
    url: '/api/settlements?includeDeleted=yes',
    headers: { authorization: `Bearer ${token}` },
  });
  t.equal(invalid.statusCode, 400, 'non-boolean includeDeleted is rejected');
  await app.close();
  t.end();
});

test('Settlement listing rejects page offsets above the maximum', async (t) => {
  const app = buildApp({ prisma: createMockPrisma() as any, logger: false });
  await app.ready();
  const token = generateTestJwt(app, {
    merchantId: 'merchant-1',
    ownerId: 'owner-1',
  });
  const res = await app.inject({
    method: 'GET',
    url: '/api/settlements?page=1002&limit=100',
    headers: { authorization: `Bearer ${token}` },
  });
  t.equal(res.statusCode, 400, 'excessive page offset returns 400');
  await app.close();
  t.end();
});
