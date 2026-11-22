import test from 'tape';
import { createTestApp, generateTestJwt } from './test-utils.js';
import { ErrorCodes } from '@bettapay/validation';

test('POST /api/merchants catches Prisma P2002 unique constraint violation and returns HTTP 409', async (t) => {
  let createAttempts = 0;
  const mockPrismaOverride = {
    $transaction: async (cb: any) => {
      createAttempts += 1;
      const error: any = new Error('Unique constraint failed on the fields: (`id`)');
      error.code = 'P2002';
      error.meta = { target: ['id'] };
      throw error;
    },
  };

  const { app } = await createTestApp({
    prisma: mockPrismaOverride as any,
  });
  const token = generateTestJwt(app);

  const res = await app.inject({
    method: 'POST',
    url: '/api/merchants',
    headers: {
      authorization: `Bearer ${token}`,
      'x-csrf-check': '1',
    },
    payload: {
      id: 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H',
      name: 'Duplicate Merchant LLC',
      ownerId: 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H',
    },
  });

  t.equal(res.statusCode, 409, 'returns HTTP 409 Conflict instead of 500 on P2002');
  const body = JSON.parse(res.body);
  t.ok(body.error, 'returns structured error envelope');
  t.equal(body.error.code, ErrorCodes.CONFLICT, 'returns CONFLICT error code');
  t.match(body.error.message, /already exists/i, 'returns clear error message');
  t.equal(createAttempts, 1, 'transaction was attempted');

  await app.close();
  t.end();
});

test('POST /api/merchants unhandled non-P2002 errors still bubble up as 500', async (t) => {
  const mockPrismaOverride = {
    $transaction: async () => {
      const error: any = new Error('Database connection failed');
      error.code = 'P1001';
      throw error;
    },
  };

  const { app } = await createTestApp({
    prisma: mockPrismaOverride as any,
  });
  const token = generateTestJwt(app);

  const res = await app.inject({
    method: 'POST',
    url: '/api/merchants',
    headers: {
      authorization: `Bearer ${token}`,
      'x-csrf-check': '1',
    },
    payload: {
      id: 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H',
      name: 'Fatal Error Merchant',
      ownerId: 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H',
    },
  });

  t.equal(res.statusCode, 500, 'non-P2002 errors still return 500 Internal Server Error');
  const body = JSON.parse(res.body);
  t.equal(body.error.code, ErrorCodes.INTERNAL_ERROR);

  await app.close();
  t.end();
});
