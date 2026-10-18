/**
 * Issue #908 — Timing-safe comparison for the admin API key.
 *
 * createAdminApiKeyAuth returns a preValidation hook that accepts requests with
 * a matching x-admin-api-key header and rejects all others with 401, using a
 * constant-time comparison to prevent timing-based key enumeration.
 */
import test from 'node:test';
import assert from 'node:assert';
import Fastify from 'fastify';
import { createAdminApiKeyAuth } from './plugins.js';

const ADMIN_SECRET = 'a'.repeat(32);

function buildAdminApp(secret = ADMIN_SECRET) {
  const app = Fastify({ logger: false });
  const adminAuth = createAdminApiKeyAuth(secret);
  app.decorate('adminAuth', adminAuth);
  app.get('/admin/ip-score', { preValidation: [adminAuth] }, async () => ({ ok: true }));
  return app;
}

test('#908: request with correct x-admin-api-key is accepted', async () => {
  const app = buildAdminApp();
  const res = await app.inject({
    method: 'GET',
    url: '/admin/ip-score',
    headers: { 'x-admin-api-key': ADMIN_SECRET },
  });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(JSON.parse(res.body).ok, true);
  await app.close();
});

test('#908: request without x-admin-api-key header is rejected with 401', async () => {
  const app = buildAdminApp();
  const res = await app.inject({ method: 'GET', url: '/admin/ip-score' });
  assert.strictEqual(res.statusCode, 401);
  const body = JSON.parse(res.body);
  assert.strictEqual(body.error.code, 'UNAUTHORIZED');
  await app.close();
});

test('#908: request with wrong x-admin-api-key is rejected with 401', async () => {
  const app = buildAdminApp();
  const res = await app.inject({
    method: 'GET',
    url: '/admin/ip-score',
    headers: { 'x-admin-api-key': 'wrong-secret-value-here-wrong-secret-value' },
  });
  assert.strictEqual(res.statusCode, 401);
  await app.close();
});

test('#908: createAdminApiKeyAuth throws when secret is too short', () => {
  assert.throws(
    () => createAdminApiKeyAuth('short'),
    /at least 32 characters/,
  );
});

test('#908: createAdminApiKeyAuth throws when secret is empty', () => {
  assert.throws(
    () => createAdminApiKeyAuth(''),
    /at least 32 characters/,
  );
});
