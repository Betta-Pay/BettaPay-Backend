import test from 'tape';
import { fastify, prisma, closeTestResources } from './index.js';

process.env.NODE_ENV = 'test';

const VALID_TOKEN = process.env.INTER_SERVICE_SECRET || 'dev-inter-service-secret';

const PROTECTED_ROUTES = [
  { method: 'POST', url: '/api/settlements', payload: {} },
  { method: 'POST', url: '/api/settlements/set_does_not_exist/retry' },
  { method: 'GET', url: '/api/settlements/reconcile' },
  { method: 'GET', url: '/api/settlements/reconcile/report' },
] as const;

for (const route of PROTECTED_ROUTES) {
  const label = `${route.method} ${route.url}`;

  test(`serviceAuth: ${label} rejects a missing token with 401`, async (t) => {
    const res = await fastify.inject({
      method: route.method,
      url: route.url,
      payload: 'payload' in route ? route.payload : undefined,
    });
    t.equal(res.statusCode, 401, 'returns 401 when x-service-token is absent');
    t.equal(JSON.parse(res.body).error.code, 'UNAUTHORIZED', 'error code is UNAUTHORIZED');
    t.end();
  });

  test(`serviceAuth: ${label} rejects an invalid token with 401`, async (t) => {
    const res = await fastify.inject({
      method: route.method,
      url: route.url,
      headers: { 'x-service-token': 'not-the-real-service-secret' },
      payload: 'payload' in route ? route.payload : undefined,
    });
    t.equal(res.statusCode, 401, 'returns 401 when x-service-token is wrong');
    t.end();
  });
}

test('serviceAuth: a valid token passes the auth gate on the retry route', async (t) => {
  const p = prisma as any;
  const savedFindUnique = p.settlement.findUnique;
  p.settlement.findUnique = async () => null;
  try {
    const res = await fastify.inject({
      method: 'POST',
      url: '/api/settlements/set_does_not_exist/retry',
      headers: { 'x-service-token': VALID_TOKEN },
    });
    t.equal(res.statusCode, 404, 'request reaches the handler (settlement not found)');
  } finally {
    p.settlement.findUnique = savedFindUnique;
  }
  t.end();
});

test('teardown: release shared service resources', async (t) => {
  await closeTestResources();
  t.pass('resources released');
  t.end();
});
