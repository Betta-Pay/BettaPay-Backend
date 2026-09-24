import test from 'tape';
import { createServiceAuth, validateEnv } from '@bettapay/validation';
import { buildApp } from './index.js';
import { createMockPrisma } from './test-utils.js';

// Ensure we have a valid inter-service secret for the app config
const env = validateEnv(process.env);
const SECRET = env.INTER_SERVICE_SECRET || 'inter-service-secret-value';

test('serviceAuth rejects requests with no x-service-token on gateway admin route (401)', async (t) => {
  const app = buildApp({ prisma: createMockPrisma() as any, logger: false });
  const res = await app.inject({ method: 'GET', url: '/api/admin/audit-log' });

  t.equal(res.statusCode, 401, 'missing token is unauthorized');
  t.equal(JSON.parse(res.body).error.code, 'UNAUTHORIZED', 'returns UNAUTHORIZED error code');
  await app.close();
  t.end();
});

test('serviceAuth rejects an incorrect token on gateway admin route (401)', async (t) => {
  const app = buildApp({ prisma: createMockPrisma() as any, logger: false });
  const res = await app.inject({
    method: 'GET',
    url: '/api/admin/audit-log',
    headers: { 'x-service-token': 'wrong-token' },
  });

  t.equal(res.statusCode, 401, 'wrong token is unauthorized');
  await app.close();
  t.end();
});

test('serviceAuth accepts the correct token on gateway admin route', async (t) => {
  const app = buildApp({ prisma: createMockPrisma() as any, logger: false });
  const res = await app.inject({
    method: 'GET',
    url: '/api/admin/audit-log',
    headers: { 'x-service-token': SECRET },
  });

  t.equal(res.statusCode, 200, 'valid token is accepted');
  await app.close();
  t.end();
});

test('serviceAuth rejects a token of a different length (no length leak) on gateway admin route', async (t) => {
  const app = buildApp({ prisma: createMockPrisma() as any, logger: false });
  const res = await app.inject({
    method: 'GET',
    url: '/api/admin/audit-log',
    headers: { 'x-service-token': SECRET + 'extra' },
  });

  t.equal(res.statusCode, 401, 'length mismatch is unauthorized');
  await app.close();
  t.end();
});

test('createServiceAuth throws when given an empty secret', (t) => {
  t.throws(() => createServiceAuth(''), /non-empty INTER_SERVICE_SECRET/, 'fails fast on empty secret');
  t.end();
});

test('createServiceAuth accepts an array of secrets for key rotation', (t) => {
  t.doesNotThrow(
    () => createServiceAuth(['old-secret-key-1234567890', 'new-secret-key-1234567890']),
    'accepts array of secrets for rotation',
  );
  t.end();
});

test('createServiceAuth throws when array is empty', (t) => {
  t.throws(() => createServiceAuth([]), /at least one non-empty/, 'fails fast on empty array');
  t.end();
});

test('createServiceAuth rejects dev/test secrets when NODE_ENV=production (#548)', (t) => {
  const original = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = 'production';
    t.throws(
      () => createServiceAuth('dev-inter-service-secret'),
      /development\/test value/,
      'rejects dev-prefixed secret in prod',
    );
    t.throws(
      () => createServiceAuth('inter-service-secret-value'),
      /development\/test value/,
      'rejects default placeholder in prod',
    );
    t.throws(
      () => createServiceAuth('test-secret-at-least-32-characters-long'),
      /development\/test value/,
      'rejects test-named secret in prod',
    );
    t.doesNotThrow(
      () => createServiceAuth('a-very-strong-production-inter-service-secret-key!'),
      'accepts a strong production secret',
    );
  } finally {
    process.env.NODE_ENV = original;
    t.end();
  }
});

test('serviceAuth accepts overlapping keys during rotation on gateway admin route', async (t) => {
  const oldSecret = 'old-gw-admin-secret-12345678';
  const newSecret = 'new-gw-admin-secret-12345678';
  const app = buildApp({ prisma: createMockPrisma() as any, logger: false, interServiceSecret: [oldSecret, newSecret] });

  const resOld = await app.inject({
    method: 'GET',
    url: '/api/admin/audit-log',
    headers: { 'x-service-token': oldSecret },
  });
  t.equal(resOld.statusCode, 200, 'old key accepted during rotation');

  const resNew = await app.inject({
    method: 'GET',
    url: '/api/admin/audit-log',
    headers: { 'x-service-token': newSecret },
  });
  t.equal(resNew.statusCode, 200, 'new key accepted during rotation');

  await app.close();
  t.end();
});
