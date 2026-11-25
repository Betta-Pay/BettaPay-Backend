import test from 'tape';
import { fastify, prisma, settlementQueue, redis, closeTestResources } from './index.js';
import { MOCK_MERCHANT_STANDARD } from './test-fixtures.js';
import {
  computeSettlementPayloadHash,
  settlementPayloadHash,
} from './settlement-idempotency.js';

process.env.NODE_ENV = 'test';

const AUTH_TOKEN = process.env.INTER_SERVICE_SECRET || 'dev-inter-service-secret';
const AUTH_HEADER = { 'x-service-token': AUTH_TOKEN };

// ─── Pure hash helpers ───────────────────────────────────────────────────────

test('payload hash: identical payloads hash identically', (t) => {
  const a = computeSettlementPayloadHash({ merchantId: 'm1', amount: '100.00', asset: 'USDC' });
  const b = computeSettlementPayloadHash({ merchantId: 'm1', amount: '100.00', asset: 'USDC' });
  t.equal(a, b, 'same fields → same hash');
  t.end();
});

test('payload hash: numerically equal amounts are canonicalised', (t) => {
  const a = computeSettlementPayloadHash({ merchantId: 'm1', amount: '100', asset: 'USDC' });
  const b = computeSettlementPayloadHash({ merchantId: 'm1', amount: '100.00', asset: 'USDC' });
  t.equal(a, b, '"100" and "100.00" are the same payload');
  t.end();
});

test('payload hash: different amount, merchant or asset changes the hash', (t) => {
  const base = computeSettlementPayloadHash({ merchantId: 'm1', amount: '100.00', asset: 'USDC' });
  t.notEqual(base, computeSettlementPayloadHash({ merchantId: 'm1', amount: '100.01', asset: 'USDC' }), 'amount');
  t.notEqual(base, computeSettlementPayloadHash({ merchantId: 'm2', amount: '100.00', asset: 'USDC' }), 'merchant');
  t.notEqual(base, computeSettlementPayloadHash({ merchantId: 'm1', amount: '100.00', asset: 'EURT' }), 'asset');
  t.end();
});

test('payload hash: settlement-derived hash matches the request hash', (t) => {
  const fromRequest = computeSettlementPayloadHash({ merchantId: 'm1', amount: '100.00', asset: 'USDC' });
  const fromRecord = settlementPayloadHash({ merchantId: 'm1', grossAmount: '100.00', asset: 'USDC' });
  t.equal(fromRequest, fromRecord, 'hashes agree');
  t.end();
});

// ─── POST /api/settlements replay behaviour ──────────────────────────────────

function setup() {
  const store = new Map<string, string>();
  const settlements = new Map<string, any>();

  prisma.merchant.findUnique = async () => MOCK_MERCHANT_STANDARD as any;
  prisma.$queryRaw = async () => [{ sum: null }];
  prisma.settlement.create = async (args: any) => {
    settlements.set(args.data.id, args.data);
    return args.data;
  };
  prisma.settlement.findUnique = async (args: any) => settlements.get(args.where.id) ?? null;
  settlementQueue.add = async () => ({} as any);

  redis.get = (async (key: string) => store.get(key) ?? null) as any;
  redis.set = (async (key: string, value: string, ..._args: any[]) => {
    const nx = _args.includes('NX');
    if (nx && store.has(key)) return null;
    store.set(key, value);
    return 'OK';
  }) as any;

  return { store, settlements };
}

function post(key: string, payload: Record<string, unknown>) {
  return fastify.inject({
    method: 'POST',
    url: '/api/settlements',
    headers: { ...AUTH_HEADER, 'idempotency-key': key },
    payload: { merchantId: MOCK_MERCHANT_STANDARD.id, ...payload },
  });
}

test('POST /api/settlements: identical replay returns the original settlement', async (t) => {
  const { settlements } = setup();

  const first = await post('idem-same-1', { amount: '100.00', asset: 'USDC' });
  t.equal(first.statusCode, 201, 'first request creates the settlement');
  const original = JSON.parse(first.body).data;

  const replay = await post('idem-same-1', { amount: '100.00', asset: 'USDC' });
  t.equal(replay.statusCode, 200, 'replay returns 200');
  t.equal(JSON.parse(replay.body).data.id, original.id, 'replay returns the original settlement');
  t.equal(settlements.size, 1, 'no second settlement was created');
  t.end();
});

test('POST /api/settlements: replay with a different amount returns 409', async (t) => {
  const { settlements } = setup();

  const first = await post('idem-diff-amount', { amount: '100.00', asset: 'USDC' });
  t.equal(first.statusCode, 201, 'first request creates the settlement');

  const replay = await post('idem-diff-amount', { amount: '250.00', asset: 'USDC' });
  t.equal(replay.statusCode, 409, 'mismatched amount → 409');
  t.equal(JSON.parse(replay.body).error.code, 'IDEMPOTENCY_PAYLOAD_MISMATCH', 'typed error code');
  t.equal(settlements.size, 1, 'no second settlement was created');
  t.end();
});

test('POST /api/settlements: replay with a different asset returns 409', async (t) => {
  setup();

  await post('idem-diff-asset', { amount: '100.00', asset: 'USDC' });
  const replay = await post('idem-diff-asset', { amount: '100.00', asset: 'EURT' });
  t.equal(replay.statusCode, 409, 'mismatched asset → 409');
  t.end();
});

test('POST /api/settlements: mismatch is detected even if the stored hash was evicted', async (t) => {
  const { store } = setup();

  await post('idem-evicted', { amount: '100.00', asset: 'USDC' });
  store.delete('idempotency:hash:idem-evicted');

  const mismatch = await post('idem-evicted', { amount: '999.00', asset: 'USDC' });
  t.equal(mismatch.statusCode, 409, 'falls back to the persisted settlement and returns 409');

  const match = await post('idem-evicted', { amount: '100.00', asset: 'USDC' });
  t.equal(match.statusCode, 200, 'matching replay still returns the original');
  t.end();
});

test('POST /api/settlements: different idempotency keys are independent', async (t) => {
  const { settlements } = setup();

  const a = await post('idem-key-a', { amount: '100.00', asset: 'USDC' });
  const b = await post('idem-key-b', { amount: '250.00', asset: 'USDC' });
  t.equal(a.statusCode, 201, 'key a creates');
  t.equal(b.statusCode, 201, 'key b creates');
  t.equal(settlements.size, 2, 'two settlements');
  t.end();
});

test('teardown: release shared service resources', async (t) => {
  await closeTestResources();
  t.pass('resources released');
  t.end();
});
