import test from 'tape';
import { fastify, prisma, settlementQueue, redis, closeTestResources } from './index.js';
import { MOCK_MERCHANT_STANDARD } from './test-fixtures.js';

process.env.NODE_ENV = 'test';

const AUTH_TOKEN = process.env.INTER_SERVICE_SECRET || 'dev-inter-service-secret';
const AUTH_HEADER = { 'x-service-token': AUTH_TOKEN };

function setup(merchant: unknown) {
  const store = new Map<string, string>();
  const created: any[] = [];

  prisma.merchant.findUnique = async () => merchant as any;
  prisma.$queryRaw = async () => [{ sum: '0' }];
  prisma.$transaction = async (cb: any) => cb(prisma);
  prisma.settlementBatch.create = async (args: any) => args.data;
  prisma.settlement.create = async (args: any) => {
    created.push(args.data);
    return args.data;
  };
  settlementQueue.add = async () => ({} as any);
  settlementQueue.addBulk = async () => [] as any;

  redis.get = (async (key: string) => store.get(key) ?? null) as any;
  redis.set = (async (key: string, value: string, ...args: any[]) => {
    if (args.includes('NX') && store.has(key)) return null;
    store.set(key, value);
    return 'OK';
  }) as any;
  redis.del = (async (...keys: string[]) => {
    let n = 0;
    for (const k of keys) if (store.delete(k)) n++;
    return n;
  }) as any;

  return { store, created };
}

function postBulk(key: string, payload: Record<string, unknown>) {
  return fastify.inject({
    method: 'POST',
    url: '/api/settlements/bulk',
    headers: { ...AUTH_HEADER, 'idempotency-key': key },
    payload,
  });
}

// ─── Idempotency lock on 4xx ─────────────────────────────────────────────────

test('bulk idempotency: 400 (empty batch) releases the lock so a corrected retry succeeds', async (t) => {
  const { store } = setup(MOCK_MERCHANT_STANDARD);

  const bad = await postBulk('bulk-idem-400', { merchantId: MOCK_MERCHANT_STANDARD.id, settlements: [] });
  t.equal(bad.statusCode, 400, 'empty batch → 400');
  t.notOk(store.has('idempotency:bulk:bulk-idem-400'), 'idempotency lock was released');

  const good = await postBulk('bulk-idem-400', {
    merchantId: MOCK_MERCHANT_STANDARD.id,
    settlements: [{ amount: '100.00', asset: 'USDC' }],
  });
  t.equal(good.statusCode, 201, 'corrected retry with the same key is accepted immediately');
  t.equal(JSON.parse(good.body).data.created, 1, 'settlement created');
  t.end();
});

test('bulk idempotency: 404 (unknown merchant) releases the lock', async (t) => {
  const { store } = setup(null);

  const res = await postBulk('bulk-idem-404', {
    merchantId: 'merch_missing_404',
    settlements: [{ amount: '100.00', asset: 'USDC' }],
  });
  t.equal(res.statusCode, 404, 'unknown merchant → 404');
  t.notOk(store.has('idempotency:bulk:bulk-idem-404'), 'idempotency lock was released');
  t.end();
});

test('bulk idempotency: a successful request keeps its lock and replays the cached response', async (t) => {
  const { store, created } = setup(MOCK_MERCHANT_STANDARD);
  const payload = {
    merchantId: MOCK_MERCHANT_STANDARD.id,
    settlements: [{ amount: '100.00', asset: 'USDC' }],
  };

  const first = await postBulk('bulk-idem-ok', payload);
  t.equal(first.statusCode, 201, 'first request creates');
  t.ok(store.has('idempotency:bulk:bulk-idem-ok'), 'lock is kept after success');

  const replay = await postBulk('bulk-idem-ok', payload);
  t.equal(replay.statusCode, 200, 'identical replay returns cached response');
  t.equal(created.length, 1, 'no duplicate settlement created');
  t.end();
});

test('bulk idempotency: a request that lost the race does not release the winner\'s lock', async (t) => {
  const { store } = setup(MOCK_MERCHANT_STANDARD);
  const payload = { merchantId: MOCK_MERCHANT_STANDARD.id, settlements: [] as unknown[] };

  // Another in-flight request already holds the lock with a different hash.
  store.set('idempotency:bulk:bulk-idem-race', 'other-hash');

  const res = await postBulk('bulk-idem-race', payload);
  t.equal(res.statusCode, 409, 'mismatched payload → 409');
  t.equal(store.get('idempotency:bulk:bulk-idem-race'), 'other-hash', 'foreign lock is untouched');
  t.end();
});

// ─── feeSnapshot ─────────────────────────────────────────────────────────────

test('bulk: created settlements persist feeSnapshot', async (t) => {
  const { created } = setup(MOCK_MERCHANT_STANDARD);

  const res = await postBulk('bulk-fee-snapshot', {
    merchantId: MOCK_MERCHANT_STANDARD.id,
    settlements: [
      { amount: '100.00', asset: 'USDC' },
      { amount: '200.00', asset: 'USDC' },
    ],
  });
  t.equal(res.statusCode, 201, 'bulk request accepted');
  t.equal(created.length, 2, 'two settlements created');
  for (const row of created) {
    t.ok(row.feeSnapshot, 'feeSnapshot is persisted');
    t.equal(row.feeSnapshot.feeBpsApplied, row.feeBps, 'snapshot matches the applied fee rate');
    t.equal(typeof row.feeSnapshot.feeVersion, 'string', 'snapshot carries feeVersion');
  }
  t.end();
});

// ─── Exact decimal daily limits ──────────────────────────────────────────────

test('bulk: daily limit uses exact decimal math (0.10 + 0.20 fits a 0.30 limit)', async (t) => {
  const merchant = {
    ...MOCK_MERCHANT_STANDARD,
    id: 'merch_exactmath',
    settings: { feeBps: 100, dailySettlementLimit: '0.30' },
  };
  setup(merchant);

  const res = await postBulk('bulk-exact-1', {
    merchantId: merchant.id,
    settlements: [
      { amount: '0.10', asset: 'USDC' },
      { amount: '0.20', asset: 'USDC' },
    ],
  });
  const body = JSON.parse(res.body);
  t.equal(res.statusCode, 201, 'accepted');
  t.equal(body.data.created, 2, 'both settlements fit exactly at the limit (float math would reject the second)');
  t.deepEqual(body.data.errors, [], 'no limit errors');
  t.end();
});

test('bulk: daily limit still rejects the item that exceeds it by the smallest unit', async (t) => {
  const merchant = {
    ...MOCK_MERCHANT_STANDARD,
    id: 'merch_exactmath2',
    settings: { feeBps: 100, dailySettlementLimit: '0.30' },
  };
  setup(merchant);

  const res = await postBulk('bulk-exact-2', {
    merchantId: merchant.id,
    settlements: [
      { amount: '0.10', asset: 'USDC' },
      { amount: '0.2000001', asset: 'USDC' },
    ],
  });
  const body = JSON.parse(res.body);
  t.equal(body.data.created, 1, 'only the first fits');
  t.equal(body.data.errors.length, 1, 'one error');
  t.ok(body.data.errors[0].reason.includes('Daily settlement limit exceeded'), 'reports the daily limit');
  t.end();
});

test('teardown: release shared service resources', async (t) => {
  await closeTestResources();
  t.pass('resources released');
  t.end();
});
