import test from 'tape';
import { createTestApp, generateTestJwt } from './test-utils.js';

const MERCHANT_ID = 'merchant-a';

interface FakeRedis {
  store: Map<string, string>;
  setCalls: Array<{ key: string; value: string; args: unknown[] }>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ...args: unknown[]): Promise<'OK'>;
  del(key: string): Promise<number>;
  incr(key: string): Promise<number>;
  decr(key: string): Promise<number>;
  expire(key: string, ttl: number): Promise<number>;
  quit(): Promise<void>;
  disconnect(): void;
}

function createFakeRedis(): FakeRedis {
  const store = new Map<string, string>();
  const counters = new Map<string, number>();
  const setCalls: Array<{ key: string; value: string; args: unknown[] }> = [];

  return {
    store,
    setCalls,
    async get(key) {
      return store.get(key) ?? null;
    },
    async set(key, value, ...args) {
      setCalls.push({ key, value, args });
      store.set(key, value);
      return 'OK';
    },
    async del(key) {
      return store.delete(key) ? 1 : 0;
    },
    async incr(key) {
      const next = (counters.get(key) ?? 0) + 1;
      counters.set(key, next);
      return next;
    },
    async decr(key) {
      const next = (counters.get(key) ?? 0) - 1;
      counters.set(key, next);
      return next;
    },
    async expire() {
      return 1;
    },
    async quit() {},
    disconnect() {},
  };
}

function payment(id: string, status: string, merchantId = MERCHANT_ID) {
  return {
    id,
    merchantId,
    status,
    amount: '10.00',
    asset: 'USDC',
    createdAt: new Date('2026-10-01T00:00:00.000Z'),
  };
}

async function setup(payments: ReturnType<typeof payment>[]) {
  const redis = createFakeRedis();
  const { app, mockPrisma } = await createTestApp(
    {
      redis: redis as any,
      domainEventsQueue: { add: async () => ({}) } as any,
    },
    { payments },
  );
  const token = generateTestJwt(app, { merchantId: MERCHANT_ID, ownerId: 'owner-a' });
  return { app, mockPrisma, redis, token };
}

test('bulk-cancel: replaying with the same Idempotency-Key returns the stored summary (#917)', async (t) => {
  const { app, mockPrisma, redis, token } = await setup([
    payment('pay_1', 'initiated'),
    payment('pay_2', 'initiated'),
    payment('pay_3', 'cancelled'),
    payment('pay_foreign', 'initiated', 'merchant-b'),
  ]);

  const request = {
    method: 'POST' as const,
    url: '/api/payments/bulk-cancel',
    headers: { authorization: `Bearer ${token}`, 'idempotency-key': 'bulk-key-1', 'x-csrf-check': '1' },
    payload: { paymentIds: ['pay_1', 'pay_2', 'pay_3', 'pay_foreign'] },
  };

  const first = await app.inject(request);
  t.equal(first.statusCode, 200, 'first request returns 200');
  const firstSummary = JSON.parse(first.body);
  t.equal(firstSummary.cancelled, 3, 'initiated and already-cancelled rows count as cancelled');
  t.equal(firstSummary.skipped, 1, 'foreign merchant row is skipped');
  t.deepEqual(
    firstSummary.items.map((item: any) => [item.id, item.status]),
    [
      ['pay_1', 'cancelled'],
      ['pay_2', 'cancelled'],
      ['pay_3', 'cancelled'],
      ['pay_foreign', 'skipped'],
    ],
    'per-item statuses are reported in input order',
  );
  t.deepEqual(firstSummary.cancelledIds, ['pay_1', 'pay_2', 'pay_3'], 'already-cancelled id appears as cancelled');

  // Mutate state between calls so a recomputation would not match the first
  // response: remove one payment and move another out of "cancelled".
  mockPrisma.store.payments = mockPrisma.store.payments.filter((p: any) => p.id !== 'pay_1');
  const pay2 = mockPrisma.store.payments.find((p: any) => p.id === 'pay_2');
  pay2.status = 'completed';

  const second = await app.inject(request);
  t.equal(second.statusCode, 200, 'replay returns 200');
  t.deepEqual(JSON.parse(second.body), firstSummary, 'replay is byte-for-byte the original summary');

  const stored = redis.setCalls.find((call) => call.key.endsWith('bulk-key-1'));
  t.ok(stored, 'summary is persisted under the idempotency key');
  t.deepEqual(stored?.args, ['EX', 86400], 'summary uses the existing 24h idempotency TTL');

  await app.close();
  t.end();
});

test('bulk-cancel: a fresh Idempotency-Key performs a new cancel and reports already-cancelled items as cancelled (#917)', async (t) => {
  const { app, mockPrisma, token } = await setup([
    payment('pay_old', 'cancelled'),
    payment('pay_new', 'initiated'),
  ]);

  const res = await app.inject({
    method: 'POST',
    url: '/api/payments/bulk-cancel',
    headers: { authorization: `Bearer ${token}`, 'idempotency-key': 'bulk-key-fresh', 'x-csrf-check': '1' },
    payload: { paymentIds: ['pay_old', 'pay_new'] },
  });

  t.equal(res.statusCode, 200, 'returns 200');
  const summary = JSON.parse(res.body);
  t.deepEqual(summary.cancelledIds.sort(), ['pay_new', 'pay_old'], 'fresh key cancels the newly initiated row');
  t.equal(summary.errors, 0, 'already-cancelled rows are not errors');
  t.equal(
    mockPrisma.store.payments.find((p: any) => p.id === 'pay_new')?.status,
    'cancelled',
    'the newly initiated payment is persisted as cancelled',
  );

  await app.close();
  t.end();
});

test('bulk-cancel: request without an Idempotency-Key still works and does not write a summary (#917)', async (t) => {
  const { app, redis, token } = await setup([payment('pay_1', 'initiated')]);

  const res = await app.inject({
    method: 'POST',
    url: '/api/payments/bulk-cancel',
    headers: { authorization: `Bearer ${token}`, 'x-csrf-check': '1' },
    payload: { paymentIds: ['pay_1'] },
  });

  t.equal(res.statusCode, 200, 'returns 200');
  t.equal(JSON.parse(res.body).cancelled, 1, 'cancels the payment');
  t.equal(
    redis.setCalls.filter((call) => call.key.startsWith('idempotency:bulk-cancel:')).length,
    0,
    'no summary is stored without a key',
  );

  await app.close();
  t.end();
});
