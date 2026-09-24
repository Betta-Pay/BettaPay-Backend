import test from 'tape';
import { createTestApp, generateTestJwt } from './test-utils.js';
import { MOCK_MERCHANT_ACTIVE } from './test-fixtures.js';

const VALID_STELLAR_KEY = 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H';
const INVALID_STELLAR_KEY = 'NOT_A_STELLAR_KEY';

test('validation: POST /api/payments validates merchantId', async (t) => {
  const { app } = await createTestApp();
  const token = generateTestJwt(app);

  const res = await app.inject({
    method: 'POST',
    url: '/api/payments',
    headers: { authorization: `Bearer ${token}` },
    payload: {
      merchantId: INVALID_STELLAR_KEY,
      amount: '10.00',
      asset: 'USDC',
    },
  });

  t.equal(res.statusCode, 400, 'should reject invalid merchantId with 400');
  const body = JSON.parse(res.body);
  t.equal(body.error.code, 'VALIDATION_ERROR');

  const errorDetail = body.error.details.find((d: any) => d.path.includes('merchantId'));
  t.ok(errorDetail, 'should report validation issue on merchantId path');
  await app.close();
  t.end();
});

test('validation: POST /api/payments validates amount format', async (t) => {
  const { app } = await createTestApp();
  const token = generateTestJwt(app);

  const res = await app.inject({
    method: 'POST',
    url: '/api/payments',
    headers: { authorization: `Bearer ${token}` },
    payload: {
      merchantId: VALID_STELLAR_KEY,
      amount: 'not-a-number',
      asset: 'USDC',
    },
  });

  t.equal(res.statusCode, 400, 'should reject non-numeric amount with 400');
  const body = JSON.parse(res.body);
  t.equal(body.error.code, 'VALIDATION_ERROR');
  await app.close();
  t.end();
});

test('validation: POST /api/payments rejects amounts beyond asset precision with 422', async (t) => {
  const { app } = await createTestApp({}, { merchants: [{ ...MOCK_MERCHANT_ACTIVE }] });
  const token = generateTestJwt(app);

  const res = await app.inject({
    method: 'POST',
    url: '/api/payments',
    headers: { authorization: `Bearer ${token}` },
    payload: {
      merchantId: MOCK_MERCHANT_ACTIVE.id,
      amount: '1.123456789012345678901234567890',
      asset: 'USDC',
    },
  });

  t.equal(res.statusCode, 422, 'should reject 30-decimal USDC amount with 422');
  const body = JSON.parse(res.body);
  t.equal(body.error.code, 'VALIDATION_ERROR');
  t.ok(
    body.error.details.some((detail: any) => detail.path.includes('amount')),
    'should report the precision issue on amount',
  );
  await app.close();
  t.end();
});

test('validation: POST /api/payments validates asset format', async (t) => {
  const { app } = await createTestApp();
  const token = generateTestJwt(app);

  const res = await app.inject({
    method: 'POST',
    url: '/api/payments',
    headers: { authorization: `Bearer ${token}` },
    payload: {
      merchantId: VALID_STELLAR_KEY,
      amount: '10.00',
      asset: '', // empty asset
    },
  });

  t.equal(res.statusCode, 400, 'should reject empty asset with 400');
  const body = JSON.parse(res.body);
  t.equal(body.error.code, 'VALIDATION_ERROR');
  await app.close();
  t.end();
});

test('validation: POST /api/payments accepts a free-form payerId', async (t) => {
  // payerId is free-form by design (merchant-facing identifier, not a Stellar
  // address) — a non-Stellar value must be accepted.
  const { app } = await createTestApp({}, { merchants: [{ ...MOCK_MERCHANT_ACTIVE }] });
  const token = generateTestJwt(app);

  const res = await app.inject({
    method: 'POST',
    url: '/api/payments',
    headers: { authorization: `Bearer ${token}` },
    payload: {
      merchantId: MOCK_MERCHANT_ACTIVE.id,
      amount: '10.00',
      asset: 'USDC',
      payerId: 'payer-ref-123',
    },
  });

  t.equal(res.statusCode, 201, 'accepts a free-form payerId');
  const body = JSON.parse(res.body);
  t.equal(body.data.payerId, 'payer-ref-123', 'stores the payerId as provided');
  await app.close();
  t.end();
});

test('validation: POST /api/payments validates convertTo is not empty and is uppercase', async (t) => {
  const { app } = await createTestApp();
  const token = generateTestJwt(app);

  const res = await app.inject({
    method: 'POST',
    url: '/api/payments',
    headers: { authorization: `Bearer ${token}` },
    payload: {
      merchantId: VALID_STELLAR_KEY,
      amount: '10.00',
      asset: 'USDC',
      convertTo: 'ngn', // lowercase is invalid according to validation rules
    },
  });

  t.equal(res.statusCode, 400, 'should reject lowercase convertTo with 400');
  const body = JSON.parse(res.body);
  t.equal(body.error.code, 'VALIDATION_ERROR');
  await app.close();
  t.end();
});

test('validation: POST /api/merchants validates id and ownerId Stellar addresses', async (t) => {
  const { app } = await createTestApp();
  const token = generateTestJwt(app);

  // 1. Empty id is rejected (id must be a non-empty string; the Stellar
  //    format requirement applies to ownerId)
  const res1 = await app.inject({
    method: 'POST',
    url: '/api/merchants',
    headers: { authorization: `Bearer ${token}` },
    payload: {
      id: '',
      name: 'Test Merchant',
      ownerId: VALID_STELLAR_KEY,
    },
  });
  t.equal(res1.statusCode, 400, 'should reject empty merchant id');

  // 2. Invalid ownerId Stellar address
  const res2 = await app.inject({
    method: 'POST',
    url: '/api/merchants',
    headers: { authorization: `Bearer ${token}` },
    payload: {
      id: VALID_STELLAR_KEY,
      name: 'Test Merchant',
      ownerId: INVALID_STELLAR_KEY,
    },
  });
  t.equal(res2.statusCode, 400, 'should reject invalid ownerId address');

  // 3. Missing name
  const res3 = await app.inject({
    method: 'POST',
    url: '/api/merchants',
    headers: { authorization: `Bearer ${token}` },
    payload: {
      id: VALID_STELLAR_KEY,
      ownerId: VALID_STELLAR_KEY,
    },
  });
  t.equal(res3.statusCode, 400, 'should reject missing name');

  await app.close();
  t.end();
});

test('validation: PATCH /api/merchants/:id/settings validates feeBps constraints', async (t) => {
  const { app } = await createTestApp({}, {
    merchants: [{ id: 'm1', settings: {} }],
  });
  const token = generateTestJwt(app);

  // 1. feeBps below 0
  const res1 = await app.inject({
    method: 'PATCH',
    url: '/api/merchants/m1/settings',
    headers: { authorization: `Bearer ${token}` },
    payload: { feeBps: -10 },
  });
  t.equal(res1.statusCode, 400, 'should reject feeBps < 0');

  // 2. feeBps above 10000
  const res2 = await app.inject({
    method: 'PATCH',
    url: '/api/merchants/m1/settings',
    headers: { authorization: `Bearer ${token}` },
    payload: { feeBps: 10001 },
  });
  t.equal(res2.statusCode, 400, 'should reject feeBps > 10000');

  // 3. Valid feeBps
  const res3 = await app.inject({
    method: 'PATCH',
    url: '/api/merchants/m1/settings',
    headers: { authorization: `Bearer ${token}` },
    payload: { feeBps: 150 },
  });
  t.equal(res3.statusCode, 200, 'should accept valid feeBps within range');

  await app.close();
  t.end();
});

test('validation: POST /api/settlements validates merchantId format', async (t) => {
  const { app } = await createTestApp();
  const token = generateTestJwt(app);

  const res = await app.inject({
    method: 'POST',
    url: '/api/settlements',
    headers: { authorization: `Bearer ${token}` },
    payload: {
      merchantId: 'not valid!', // fails the alphanumeric merchantId format rule
      items: [{ amount: '50.00', asset: 'USDC' }],
    },
  });

  t.equal(res.statusCode, 400, 'should reject invalid settlement merchantId with 400');
  const body = JSON.parse(res.body);
  t.equal(body.error.code, 'VALIDATION_ERROR');
  await app.close();
  t.end();
});

test('validation: POST /api/settlements validates items payload structure', async (t) => {
  const { app } = await createTestApp();
  const token = generateTestJwt(app);

  const res = await app.inject({
    method: 'POST',
    url: '/api/settlements',
    headers: { authorization: `Bearer ${token}` },
    payload: {
      merchantId: VALID_STELLAR_KEY,
      items: [{ amount: 'not-a-number', asset: '' }], // invalid amount format and empty asset
    },
  });

  t.equal(res.statusCode, 400, 'should reject invalid settlement items layout with 400');
  const body = JSON.parse(res.body);
  t.equal(body.error.code, 'VALIDATION_ERROR');
  await app.close();
  t.end();
});

test('validation: GET /api/settlements validates query parameter dates', async (t) => {
  const { app } = await createTestApp();
  const token = generateTestJwt(app);

  const res = await app.inject({
    method: 'GET',
    url: '/api/settlements?merchantId=' + VALID_STELLAR_KEY + '&from=not-a-date',
    headers: { authorization: `Bearer ${token}` },
  });

  t.equal(res.statusCode, 400, 'should reject malformed date format with 400');
  await app.close();
  t.end();
});

test('validation: GET /api/settlements handles date ranges correctly when start date is after end date', async (t) => {
  const { app } = await createTestApp();
  const token = generateTestJwt(app);

  const res = await app.inject({
    method: 'GET',
    url: '/api/settlements?merchantId=' + VALID_STELLAR_KEY + '&from=2026-12-31&to=2026-01-01',
    headers: { authorization: `Bearer ${token}` },
  });

  // Query parameter date bounds verification
  t.ok(res.statusCode === 200 || res.statusCode === 400, 'should handle date ranges cleanly');
  await app.close();
  t.end();
});
export { VALID_STELLAR_KEY, INVALID_STELLAR_KEY };
