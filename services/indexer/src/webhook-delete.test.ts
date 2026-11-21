/**
 * Route tests for optional merchantId ownership enforcement on DELETE /api/webhooks/:id (#1061).
 */

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'a'.repeat(32);
process.env.DATABASE_URL = 'postgresql://localhost:5432/db';
process.env.SETTLEMENT_CONTRACT_ID = 'CDLZFC3SYXDT4MMSTXTU4Z4VABMFR6SPLPNCZF656SIHPXT6LPWEEXGO';
process.env.GOVERNANCE_CONTRACT_ID = 'CBJDHFU7XYDT4MMSTXTU4Z4VABMFR6SPLPNCZF656SIHPXT6LPWEEXGO';
process.env.ADMIN_ADDRESS = 'GBJDHFU7XYDT4MMSTXTU4Z4VABMFR6SPLPNCZF656SIHPXT6LPWEEXGO';
process.env.INTER_SERVICE_SECRET = 'test-service-secret-value';
process.env.GOOGLE_CLIENT_ID = 'test-google-client-id';
process.env.ADMIN_SECRET = 'test-admin-secret';
process.env.FIELD_ENCRYPTION_KEY = 'b'.repeat(32);

import test from 'tape';

const { fastify, prisma, cacheState } = await import('./index.js');

const AUTH = { 'x-service-token': 'test-service-secret-value' };

test('DELETE /api/webhooks/:id rejects cross-merchant deletion via query param with 403 (#1061)', async (t) => {
  await fastify.ready();
  const origFindUnique = prisma.webhookSubscription.findUnique;
  const origTx = prisma.$transaction;

  let deleted = false;
  cacheState.subscriptions = { data: [], cachedAt: Date.now() };
  prisma.webhookSubscription.findUnique = (async () => ({
    id: 'wh_owned_b',
    url: 'https://example.com/webhook',
    merchantId: 'mch_b',
  })) as any;
  prisma.$transaction = (async () => {
    deleted = true;
  }) as any;

  try {
    const res = await fastify.inject({
      method: 'DELETE',
      url: '/api/webhooks/wh_owned_b?merchantId=mch_a',
      headers: AUTH,
    });

    t.equal(res.statusCode, 403, 'returns 403 when query merchantId does not match owner');
    const body = JSON.parse(res.body);
    t.equal(body.error?.code, 'FORBIDDEN', 'returns FORBIDDEN error code');
    t.equal(deleted, false, 'does not delete the subscription');
    t.ok(cacheState.subscriptions !== null, 'does not invalidate subscription cache');
  } finally {
    prisma.webhookSubscription.findUnique = origFindUnique;
    prisma.$transaction = origTx;
  }
  t.end();
});

test('DELETE /api/webhooks/:id rejects cross-merchant deletion via x-merchant-id header with 403 (#1061)', async (t) => {
  await fastify.ready();
  const origFindUnique = prisma.webhookSubscription.findUnique;
  const origTx = prisma.$transaction;

  let deleted = false;
  prisma.webhookSubscription.findUnique = (async () => ({
    id: 'wh_owned_b',
    url: 'https://example.com/webhook',
    merchantId: 'mch_b',
  })) as any;
  prisma.$transaction = (async () => {
    deleted = true;
  }) as any;

  try {
    const res = await fastify.inject({
      method: 'DELETE',
      url: '/api/webhooks/wh_owned_b',
      headers: { ...AUTH, 'x-merchant-id': 'mch_a' },
    });

    t.equal(res.statusCode, 403, 'returns 403 when x-merchant-id header does not match owner');
    const body = JSON.parse(res.body);
    t.equal(body.error?.code, 'FORBIDDEN', 'returns FORBIDDEN error code');
    t.equal(deleted, false, 'does not delete the subscription');
  } finally {
    prisma.webhookSubscription.findUnique = origFindUnique;
    prisma.$transaction = origTx;
  }
  t.end();
});

test('DELETE /api/webhooks/:id rejects merchant-scoped deletion of unowned global subscription with 403 (#1061)', async (t) => {
  await fastify.ready();
  const origFindUnique = prisma.webhookSubscription.findUnique;
  const origTx = prisma.$transaction;

  let deleted = false;
  prisma.webhookSubscription.findUnique = (async () => ({
    id: 'wh_global',
    url: 'https://example.com/webhook',
    merchantId: null,
  })) as any;
  prisma.$transaction = (async () => {
    deleted = true;
  }) as any;

  try {
    const res = await fastify.inject({
      method: 'DELETE',
      url: '/api/webhooks/wh_global?merchantId=mch_a',
      headers: AUTH,
    });

    t.equal(res.statusCode, 403, 'returns 403 when merchant caller tries to delete unowned webhook');
    t.equal(deleted, false, 'does not delete the global subscription');
  } finally {
    prisma.webhookSubscription.findUnique = origFindUnique;
    prisma.$transaction = origTx;
  }
  t.end();
});

test('DELETE /api/webhooks/:id succeeds with 204 when merchantId matches via query or header (#1061)', async (t) => {
  await fastify.ready();
  const origFindUnique = prisma.webhookSubscription.findUnique;
  const origTx = prisma.$transaction;

  const deletedIds: string[] = [];
  prisma.webhookSubscription.findUnique = (async ({ where }: any) => ({
    id: where.id,
    url: 'https://example.com/webhook',
    merchantId: 'mch_a',
  })) as any;
  prisma.$transaction = (async (fn: any) => {
    const tx = {
      webhookSubscription: {
        delete: async ({ where }: any) => {
          deletedIds.push(where.id);
          return {};
        },
      },
      auditLog: {
        create: async () => ({}),
      },
    };
    return fn(tx);
  }) as any;

  try {
    cacheState.subscriptions = { data: [], cachedAt: Date.now() };
    const resQuery = await fastify.inject({
      method: 'DELETE',
      url: '/api/webhooks/wh_owned_a1?merchantId=mch_a',
      headers: AUTH,
    });
    t.equal(resQuery.statusCode, 204, 'returns 204 when query merchantId matches');
    t.equal(cacheState.subscriptions, null, 'invalidates subscription cache');

    cacheState.subscriptions = { data: [], cachedAt: Date.now() };
    const resHeader = await fastify.inject({
      method: 'DELETE',
      url: '/api/webhooks/wh_owned_a2',
      headers: { ...AUTH, 'x-merchant-id': 'mch_a' },
    });
    t.equal(resHeader.statusCode, 204, 'returns 204 when x-merchant-id header matches');
    t.deepEqual(deletedIds, ['wh_owned_a1', 'wh_owned_a2'], 'deletes both matching subscriptions');
  } finally {
    prisma.webhookSubscription.findUnique = origFindUnique;
    prisma.$transaction = origTx;
  }
  t.end();
});

test('DELETE /api/webhooks/:id returns 404 when subscription does not exist (#1061)', async (t) => {
  await fastify.ready();
  const origFindUnique = prisma.webhookSubscription.findUnique;
  prisma.webhookSubscription.findUnique = (async () => null) as any;

  try {
    const res = await fastify.inject({
      method: 'DELETE',
      url: '/api/webhooks/wh_missing?merchantId=mch_a',
      headers: AUTH,
    });

    t.equal(res.statusCode, 404, 'returns 404 for non-existent subscription');
    const body = JSON.parse(res.body);
    t.equal(body.error?.code, 'NOT_FOUND', 'returns NOT_FOUND error code');
  } finally {
    prisma.webhookSubscription.findUnique = origFindUnique;
  }
  t.end();
});

test.onFinish(() => {
  process.exit(process.exitCode ?? 0);
});
