import test from 'tape';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  createMockPrisma,
  generateTestJwt,
  createTestApp,
  createMockSettlementClient,
  createMockFxClient,
  createMockIndexerClient,
} from './test-utils.js';

// ── Centralized mock-client builders (issue #557) ───────────────────────────

test('mock builders: settlement client exposes the real client surface', (t) => {
  const client = createMockSettlementClient();
  t.equal(typeof client.createSettlement, 'function', 'createSettlement is a function');
  t.end();
});

test('mock builders: settlement client has a consistent default response', async (t) => {
  const first = await createMockSettlementClient().createSettlement({
    merchantId: 'merch_1',
    grossAmount: '50.00',
    asset: 'USDC',
  });
  const second = await createMockSettlementClient().createSettlement({
    merchantId: 'merch_1',
    grossAmount: '50.00',
    asset: 'USDC',
  });

  t.equal(first.status, 201, 'default status is 201');
  t.equal(first.contentType, 'application/json', 'default content type is json');
  t.equal(first.body.data.id, 'set_mock_1', 'stable mock settlement id');
  t.equal(first.body.data.merchantId, 'merch_1', 'echoes merchantId');
  // Strip the volatile createdAt timestamp before comparing consistency.
  const { createdAt: _a, ...firstRest } = first.body.data;
  const { createdAt: _b, ...secondRest } = second.body.data;
  t.same(secondRest, firstRest, 'defaults are consistent across instances');
  t.end();
});

test('mock builders: settlement client honours overrides', async (t) => {
  const client = createMockSettlementClient({
    createSettlement: async () => ({ status: 504, body: { error: 'down' }, contentType: 'application/json' }),
  });
  const result = await client.createSettlement({});
  t.equal(result.status, 504, 'override is used');
  t.end();
});

test('mock builders: fx client exposes getQuote with a consistent default quote', async (t) => {
  const client = createMockFxClient();
  t.equal(typeof client.getQuote, 'function', 'getQuote is a function');

  const quote = await client.getQuote({ from: 'USDC', to: 'NGN', amount: '10.00' });
  t.ok(quote, 'returns a quote');
  t.equal(quote?.quoteId, 'quote_mock_1', 'stable mock quote id');
  t.equal(quote?.from, 'USDC', 'echoes from');
  t.equal(quote?.to, 'NGN', 'echoes to');
  t.equal(quote?.amount, '10.00', 'echoes amount');
  t.ok(quote?.result, 'result is present');
  t.ok(quote?.rate, 'rate is present');
  t.ok(quote?.cachedAt && quote?.expiresAt, 'timestamps are present');
  t.end();
});

test('mock builders: fx client defaults are deterministic (no fixture drift)', async (t) => {
  const a = await createMockFxClient().getQuote({ from: 'USDC', to: 'NGN', amount: '10.00' });
  const b = await createMockFxClient().getQuote({ from: 'USDC', to: 'NGN', amount: '10.00' });
  t.same(b, a, 'two instances produce the identical quote');
  t.end();
});

test('mock builders: indexer client exposes getPaymentEvents with empty default', async (t) => {
  const client = createMockIndexerClient();
  t.equal(typeof client.getPaymentEvents, 'function', 'getPaymentEvents is a function');
  const events = await client.getPaymentEvents('merchant_1');
  t.same(events, [], 'defaults to no events (indexer empty)');
  t.end();
});

test('consistency: createTestApp wires the centralized mock clients by default', async (t) => {
  const { app } = await createTestApp({}, {
    merchants: [
      { id: 'merch_1', settings: {} },
      { id: 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H', settings: {}, deletedAt: null, status: 'active' },
    ],
    supportedAssets: [{ code: 'USDC', contractId: 'C1', decimals: 6, name: 'USD Coin', isActive: true }],
  });

  // Default fx client backs payment creation with convertTo
  const paymentRes = await app.inject({
    method: 'POST',
    url: '/api/payments',
    headers: { authorization: `Bearer ${generateTestJwt(app)}` },
    payload: {
      merchantId: 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H',
      amount: '10.00',
      asset: 'USDC',
      convertTo: 'NGN',
    },
  });
  t.equal(paymentRes.statusCode, 201, 'payment creation succeeds with default fx mock');
  const paymentBody = JSON.parse(paymentRes.body);
  t.equal(paymentBody.data.fxQuote.quoteId, 'quote_mock_1', 'default fx mock quote is served');

  // Default settlement client backs settlement creation
  const settlementRes = await app.inject({
    method: 'POST',
    url: '/api/settlements',
    headers: { authorization: `Bearer ${generateTestJwt(app)}` },
    payload: {
      merchantId: 'merch_1',
      items: [{ amount: '50.00', asset: 'USDC' }],
    },
  });
  t.equal(settlementRes.statusCode, 201, 'settlement creation succeeds with default settlement mock');
  const settlementBody = JSON.parse(settlementRes.body);
  t.equal(settlementBody.data.id, 'set_mock_1', 'default settlement mock response is served');

  // Default indexer client enriches payment queries with an empty event list
  const eventsRes = await app.inject({ method: 'GET', url: '/api/payments/nope?includeEvents=true' });
  t.equal(eventsRes.statusCode, 404, 'unrelated 404 still works');

  await app.close();
  t.end();
});

test('consistency: test files do not redefine inline client mocks (single source of truth)', (t) => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const testFiles = fs
    .readdirSync(here)
    .filter((f) => f.endsWith('.test.ts'))
    .filter((f) => f !== 'test-utils.test.ts');

  // Inline mock client declarations that must only ever live in test-utils.ts.
  const inlineDeclPatterns = [
    /const\s+mockSettlementClient\s*=\s*{/,
    /const\s+mockFxClient\s*=\s*{/,
    /const\s+mockIndexerClient\s*=\s*{/,
    /const\s+indexer\s*:\s*IndexerClient\s*=\s*{/,
  ];

  const offenders: string[] = [];
  for (const file of testFiles) {
    const source = fs.readFileSync(path.join(here, file), 'utf8');
    for (const pattern of inlineDeclPatterns) {
      if (pattern.test(source)) {
        offenders.push(`${file} matches ${pattern}`);
      }
    }
  }

  t.same(offenders, [], 'no test file defines its own mock clients — use the builders in test-utils.ts');
  t.end();
});

test('mockPrisma: payment model - findUnique returns correct record', async (t) => {
  const initialPayments = [
    { id: 'pay_1', status: 'initiated', amount: '10.00', asset: 'USDC' },
    { id: 'pay_2', status: 'completed', amount: '20.00', asset: 'USDC' },
  ];
  const mockPrisma = createMockPrisma({ payments: initialPayments }) as any;

  const found = await mockPrisma.payment.findUnique({ where: { id: 'pay_1' } });
  t.ok(found, 'should find payment');
  t.equal(found.id, 'pay_1', 'should have correct id');
  t.equal(found.status, 'initiated', 'should have correct status');

  const missing = await mockPrisma.payment.findUnique({ where: { id: 'pay_missing' } });
  t.equal(missing, null, 'should return null for missing payment');

  t.end();
});

test('mockPrisma: payment model - findFirst matches criteria', async (t) => {
  const initialPayments = [
    { id: 'pay_1', status: 'initiated', idempotencyKey: 'key_1', idempotencyKeyExpiresAt: new Date(Date.now() + 60000) },
    { id: 'pay_2', status: 'completed', idempotencyKey: 'key_2', idempotencyKeyExpiresAt: new Date(Date.now() - 1000) },
  ];
  const mockPrisma = createMockPrisma({ payments: initialPayments }) as any;

  // Non-expired idempotency key lookup
  const found = await mockPrisma.payment.findFirst({
    where: {
      idempotencyKey: 'key_1',
      idempotencyKeyExpiresAt: { gt: new Date() },
    },
  });
  t.ok(found, 'should find non-expired key');
  t.equal(found.id, 'pay_1');

  // Expired key lookup should fail search criteria in findFirst
  const expired = await mockPrisma.payment.findFirst({
    where: {
      idempotencyKey: 'key_2',
      idempotencyKeyExpiresAt: { gt: new Date() },
    },
  });
  t.equal(expired, null, 'should not find expired key due to filter');

  t.end();
});

test('mockPrisma: payment model - findMany filters correctly', async (t) => {
  const initialPayments = [
    { id: 'pay_1', merchantId: 'm1', amount: '10.00' },
    { id: 'pay_2', merchantId: 'm2', amount: '20.00' },
    { id: 'pay_3', merchantId: 'm1', amount: '30.00' },
  ];
  const mockPrisma = createMockPrisma({ payments: initialPayments }) as any;

  const all = await mockPrisma.payment.findMany();
  t.equal(all.length, 3, 'should return all payments when no filter');

  const filtered = await mockPrisma.payment.findMany({ where: { merchantId: 'm1' } });
  t.equal(filtered.length, 2, 'should filter by merchantId');
  t.equal(filtered[0].id, 'pay_1');
  t.equal(filtered[1].id, 'pay_3');

  t.end();
});

test('mockPrisma: payment model - create appends and returns record', async (t) => {
  const mockPrisma = createMockPrisma() as any;

  const created = await mockPrisma.payment.create({
    data: {
      merchantId: 'm1',
      amount: '50.00',
      asset: 'EURT',
    },
  });

  t.ok(created.id, 'should auto-generate id');
  t.equal(created.merchantId, 'm1');
  t.equal(created.amount, '50.00');
  t.equal(created.status, 'initiated', 'should default status to initiated');

  const inDB = await mockPrisma.payment.findUnique({ where: { id: created.id } });
  t.ok(inDB, 'should persist created record');

  t.end();
});

test('mockPrisma: payment model - update changes existing record', async (t) => {
  const initialPayments = [{ id: 'pay_1', status: 'initiated', amount: '10.00' }];
  const mockPrisma = createMockPrisma({ payments: initialPayments }) as any;

  const updated = await mockPrisma.payment.update({
    where: { id: 'pay_1' },
    data: { status: 'completed' },
  });

  t.equal(updated.status, 'completed', 'should return updated record');
  
  const inDB = await mockPrisma.payment.findUnique({ where: { id: 'pay_1' } });
  t.equal(inDB.status, 'completed', 'should persist updates');

  t.end();
});

test('mockPrisma: merchant model - findUnique returns correct merchant', async (t) => {
  const merchants = [
    { id: 'm1', name: 'Merchant One', deletedAt: null },
    { id: 'm2', name: 'Merchant Two', deletedAt: new Date() },
  ];
  const mockPrisma = createMockPrisma({ merchants }) as any;

  const m1 = await mockPrisma.merchant.findUnique({ where: { id: 'm1' } });
  t.equal(m1.name, 'Merchant One');

  t.end();
});

test('mockPrisma: merchant model - findFirst respects soft deletion checks', async (t) => {
  const merchants = [
    { id: 'm1', name: 'Merchant One', deletedAt: null },
    { id: 'm2', name: 'Merchant Two', deletedAt: new Date() },
  ];
  const mockPrisma = createMockPrisma({ merchants }) as any;

  const active = await mockPrisma.merchant.findFirst({ where: { id: 'm1', deletedAt: null } });
  t.ok(active);

  const softDeleted = await mockPrisma.merchant.findFirst({ where: { id: 'm2', deletedAt: null } });
  t.equal(softDeleted, null, 'should filter out soft-deleted merchant');

  t.end();
});

test('mockPrisma: settlement model - create and update lifecycle', async (t) => {
  const mockPrisma = createMockPrisma() as any;

  const created = await mockPrisma.settlement.create({
    data: {
      merchantId: 'm1',
      totalAmount: '100.00',
    },
  });

  t.equal(created.status, 'PENDING');

  const updated = await mockPrisma.settlement.update({
    where: { id: created.id },
    data: { status: 'COMPLETED', completedAt: new Date() },
  });

  t.equal(updated.status, 'COMPLETED');
  t.ok(updated.completedAt);

  t.end();
});

test('mockPrisma: auditLog model - create and query', async (t) => {
  const mockPrisma = createMockPrisma() as any;

  await mockPrisma.auditLog.create({
    data: {
      entityType: 'payment',
      action: 'payment.created',
      entityId: 'pay_1',
    },
  });

  await mockPrisma.auditLog.create({
    data: {
      entityType: 'merchant',
      action: 'merchant.updated',
      entityId: 'm1',
    },
  });

  const count = await mockPrisma.auditLog.count();
  t.equal(count, 2, 'should count all logs');

  const paymentLogs = await mockPrisma.auditLog.findMany({ where: { entityType: 'payment' } });
  t.equal(paymentLogs.length, 1);
  t.equal(paymentLogs[0].action, 'payment.created');

  t.end();
});

test('mockPrisma: $transaction executes block successfully', async (t) => {
  const mockPrisma = createMockPrisma() as any;

  const result = await mockPrisma.$transaction(async (tx: any) => {
    const payment = await tx.payment.create({
      data: { amount: '10.00', asset: 'USDC' },
    });
    return payment;
  });

  t.ok(result.id);
  t.equal(result.amount, '10.00');

  t.end();
});

test('test-utils: createTestApp setup app instance with default mockPrisma', async (t) => {
  const { app, mockPrisma } = await createTestApp();
  t.ok(app, 'app should be defined');
  t.ok(mockPrisma, 'mockPrisma should be defined');
  await app.close();
  t.end();
});

test('test-utils: generateTestJwt returns valid signed token', async (t) => {
  const { app } = await createTestApp();
  const token = generateTestJwt(app, { merchantId: 'm100', ownerId: 'owner100' });
  t.ok(token, 'should return a token');

  const decoded = app.jwt.decode(token) as any;
  t.equal(decoded.merchantId, 'm100');
  t.equal(decoded.ownerId, 'owner100');

  await app.close();
  t.end();
});
