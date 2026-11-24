import test from 'tape';
import crypto from 'crypto';
import { createTestApp, generateTestJwt } from './test-utils.js';
import { MOCK_MERCHANT_ACTIVE } from './test-fixtures.js';
import {
  readIdempotencyKey,
  IDEMPOTENCY_KEY_MAX_LEN,
  IdempotencyKeyValidationError,
} from './index.js';

const MERCHANT_ID = MOCK_MERCHANT_ACTIVE.id;
const CSRF = { 'x-csrf-check': '1' };

test('1. First request without Idempotency-Key creates a payment (201)', async (t) => {
  const { app, mockPrisma } = await createTestApp({}, { merchants: [{ ...MOCK_MERCHANT_ACTIVE }] });
  const token = generateTestJwt(app);

  const res = await app.inject({
    method: 'POST',
    url: '/api/payments',
    headers: { authorization: `Bearer ${token}`, ...CSRF },
    payload: { merchantId: MERCHANT_ID, amount: '10.00', asset: 'USDC' },
  });

  t.equal(res.statusCode, 201, 'returns 201');
  const body = JSON.parse(res.body);
  t.ok(body.data.id, 'payment has an id');
  t.equal(body.data.status, 'initiated', 'status is initiated');
  t.notOk(body.data.idempotencyKey, 'no idempotencyKey stored when not provided');

  const stored = await mockPrisma.payment.findUnique({ where: { id: body.data.id } });
  t.ok(stored, 'persisted in mock database');

  await app.close();
  t.end();
});

test('2. First request with Idempotency-Key creates a payment (201)', async (t) => {
  const { app, mockPrisma } = await createTestApp({}, { merchants: [{ ...MOCK_MERCHANT_ACTIVE }] });
  const token = generateTestJwt(app);
  const key = crypto.randomUUID();

  const res = await app.inject({
    method: 'POST',
    url: '/api/payments',
    headers: {
      authorization: `Bearer ${token}`,
      'idempotency-key': key,
      ...CSRF,
    },
    payload: { merchantId: MERCHANT_ID, amount: '10.00', asset: 'USDC' },
  });

  t.equal(res.statusCode, 201, 'returns 201');
  const body = JSON.parse(res.body);
  t.equal(body.data.idempotencyKey, key, 'idempotencyKey is stored on the payment');

  const stored = await mockPrisma.payment.findUnique({ where: { id: body.data.id } });
  t.equal(stored.idempotencyKey, key, 'persisted idempotencyKey in DB');

  await app.close();
  t.end();
});

test('3. Duplicate request with same Idempotency-Key returns existing payment (200)', async (t) => {
  const key = crypto.randomUUID();
  const existingPayment = {
    id: 'pay_existing_1',
    merchantId: MERCHANT_ID,
    amount: '10.00',
    asset: 'USDC',
    status: 'initiated',
    idempotencyKey: key,
    idempotencyKeyExpiresAt: new Date(Date.now() + 86400000),
  };
  const { app } = await createTestApp({}, {
    merchants: [{ ...MOCK_MERCHANT_ACTIVE }],
    payments: [existingPayment],
  });
  const token = generateTestJwt(app);

  const res = await app.inject({
    method: 'POST',
    url: '/api/payments',
    headers: {
      authorization: `Bearer ${token}`,
      'idempotency-key': key,
      ...CSRF,
    },
    payload: { merchantId: MERCHANT_ID, amount: '10.00', asset: 'USDC' },
  });

  t.equal(res.statusCode, 200, 'duplicate request returns 200');
  const body = JSON.parse(res.body);
  t.equal(body.data.id, 'pay_existing_1', 'returns existing payment id');
  t.equal(body.data.idempotencyKey, key, 'same idempotency key');

  await app.close();
  t.end();
});

test('4. Requests without Idempotency-Key always create new payments', async (t) => {
  const { app, mockPrisma } = await createTestApp({}, { merchants: [{ ...MOCK_MERCHANT_ACTIVE }] });
  const token = generateTestJwt(app);

  const r1 = await app.inject({
    method: 'POST',
    url: '/api/payments',
    headers: { authorization: `Bearer ${token}`, ...CSRF },
    payload: { merchantId: MERCHANT_ID, amount: '10.00', asset: 'USDC' },
  });

  const r2 = await app.inject({
    method: 'POST',
    url: '/api/payments',
    headers: { authorization: `Bearer ${token}`, ...CSRF },
    payload: { merchantId: MERCHANT_ID, amount: '10.00', asset: 'USDC' },
  });

  t.equal(r1.statusCode, 201, 'first request is 201');
  t.equal(r2.statusCode, 201, 'second request is 201');
  t.equal(mockPrisma.store.payments.length, 2, 'two separate payments created in DB');

  await app.close();
  t.end();
});

test('5. TTL expiration — expired key is treated as absent, new payment is created (201)', async (t) => {
  const key = crypto.randomUUID();
  const expiredPayment = {
    id: 'pay_old',
    merchantId: MERCHANT_ID,
    amount: '10.00',
    asset: 'USDC',
    status: 'initiated',
    idempotencyKey: key,
    idempotencyKeyExpiresAt: new Date(Date.now() - 1000), // expired
  };

  const { app, mockPrisma } = await createTestApp({}, {
    merchants: [{ ...MOCK_MERCHANT_ACTIVE }],
    payments: [expiredPayment],
  });
  const token = generateTestJwt(app);

  const res = await app.inject({
    method: 'POST',
    url: '/api/payments',
    headers: {
      authorization: `Bearer ${token}`,
      'idempotency-key': key,
      ...CSRF,
    },
    payload: { merchantId: MERCHANT_ID, amount: '10.00', asset: 'USDC' },
  });

  t.equal(res.statusCode, 201, 'returns 201 for expired key');
  const body = JSON.parse(res.body);
  t.notEqual(body.data.id, 'pay_old', 'created a new payment');
  t.equal(mockPrisma.store.payments.length, 2, 'new record added to DB');

  await app.close();
  t.end();
});

test('6. Idempotency-Key exceeding 255 characters is rejected (400)', async (t) => {
  const { app } = await createTestApp({}, { merchants: [{ ...MOCK_MERCHANT_ACTIVE }] });
  const token = generateTestJwt(app);
  const longKey = 'a'.repeat(256);

  const res = await app.inject({
    method: 'POST',
    url: '/api/payments',
    headers: {
      authorization: `Bearer ${token}`,
      'idempotency-key': longKey,
      ...CSRF,
    },
    payload: { merchantId: MERCHANT_ID, amount: '10.00', asset: 'USDC' },
  });

  t.equal(res.statusCode, 400, 'returns 400 for oversized key');
  t.equal(JSON.parse(res.body).error.code, 'VALIDATION_ERROR', 'returns VALIDATION_ERROR code');
  t.ok(JSON.parse(res.body).error.message.includes('255'), 'error message mentions 255 character limit');

  await app.close();
  t.end();
});

test('7. Duplicate Idempotency-Key headers (array) are rejected with HTTP 400 (#977)', async (t) => {
  const { app } = await createTestApp({}, { merchants: [{ ...MOCK_MERCHANT_ACTIVE }] });
  const token = generateTestJwt(app);

  const res = await app.inject({
    method: 'POST',
    url: '/api/payments',
    headers: {
      authorization: `Bearer ${token}`,
      'idempotency-key': ['key-one', 'key-two'] as any,
      ...CSRF,
    },
    payload: { merchantId: MERCHANT_ID, amount: '10.00', asset: 'USDC' },
  });

  t.equal(res.statusCode, 400, 'returns HTTP 400 for duplicate/array header');
  const body = JSON.parse(res.body);
  t.equal(body.error.code, 'VALIDATION_ERROR', 'returns VALIDATION_ERROR');
  t.match(body.error.message, /single string/i, 'error message explains single string required');

  await app.close();
  t.end();
});

test('8. readIdempotencyKey unit tests (#977)', (t) => {
  // Empty / absent cases
  t.equal(readIdempotencyKey({ headers: {} } as any), null, 'absent header returns null');
  t.equal(readIdempotencyKey({ headers: { 'idempotency-key': '' } } as any), null, 'empty header returns null');
  t.equal(readIdempotencyKey({ headers: { 'idempotency-key': '   ' } } as any), null, 'whitespace-only header returns null');

  // Valid key
  t.equal(
    readIdempotencyKey({ headers: { 'idempotency-key': 'valid-key-123' } } as any),
    'valid-key-123',
    'returns trimmed string for valid key',
  );
  t.equal(
    readIdempotencyKey({ headers: { 'idempotency-key': '  trimmed-key  ' } } as any),
    'trimmed-key',
    'trims whitespace from valid key',
  );

  // Exact max length bound
  const exactKey = 'k'.repeat(IDEMPOTENCY_KEY_MAX_LEN);
  t.equal(
    readIdempotencyKey({ headers: { 'idempotency-key': exactKey } } as any),
    exactKey,
    'accepts key exactly at IDEMPOTENCY_KEY_MAX_LEN limit',
  );

  // Array-valued header rejected
  t.throws(
    () => readIdempotencyKey({ headers: { 'idempotency-key': ['k1', 'k2'] } } as any),
    (err: any) => err instanceof IdempotencyKeyValidationError && err.statusCode === 400 && err.code === 'VALIDATION_ERROR',
    'throws IdempotencyKeyValidationError for array header',
  );

  // Oversized key rejected
  const oversizedKey = 'k'.repeat(IDEMPOTENCY_KEY_MAX_LEN + 1);
  t.throws(
    () => readIdempotencyKey({ headers: { 'idempotency-key': oversizedKey } } as any),
    (err: any) => err instanceof IdempotencyKeyValidationError && err.statusCode === 400 && err.message.includes('255'),
    'throws IdempotencyKeyValidationError for oversized key',
  );

  t.end();
});
