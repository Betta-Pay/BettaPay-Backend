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

const { fastify, prisma, webhookQueue } = await import('./index.js');

test('webhook test succeeds and stores result when mock server returns 200', async (t) => {
  await fastify.ready();
  webhookQueue.add = async () => ({
    waitUntilFinished: async () => {},
  } as any);
  
  let payload: any;
  const originalFetch = global.fetch;
  global.fetch = async (_url, init) => {
    payload = JSON.parse(String(init?.body));
    return new Response('', { status: 200 });
  };

  const id = 'wh_success';
  prisma.webhookSubscription.findUnique = async () => ({ id, url: 'https://example.com/webhook', signingSecret: null }) as any;
  let updatedData: any;
  prisma.webhookSubscription.update = async (args: any) => {
    updatedData = args.data;
    return {} as any;
  };

  try {
    const res = await fastify.inject({
      method: 'POST',
      url: `/api/webhooks/${id}/test`,
      headers: { 'x-service-token': 'test-service-secret-value' },
    });

    t.equal(res.statusCode, 200, 'endpoint returns 200');
    const body = JSON.parse(res.body);
    t.equal(body.success, true, 'test result succeeds');
    t.equal(body.statusCode, 200, 'stores response status code');
    t.equal(payload.type, 'test', 'sends test payload type');
    t.equal(payload.subscriptionId, id, 'sends subscription id');
    t.equal(payload.test, true, 'marks payload as test');
    t.ok(payload.timestamp, 'sends timestamp');
    t.equal(updatedData?.lastTestStatus, 'success', 'stores success status');
    t.equal(updatedData?.lastTestStatusCode, 200, 'stores success status code');
  } finally {
    global.fetch = originalFetch;
    t.end();
  }
});

test('webhook test fails and stores result when mock server returns 500', async (t) => {
  await fastify.ready();
  webhookQueue.add = async () => ({
    waitUntilFinished: async () => { throw new Error('HTTP 500 from webhook server'); },
  } as any);

  const originalFetch = global.fetch;
  global.fetch = async () => new Response('', { status: 500 });

  const id = 'wh_fail_500';
  prisma.webhookSubscription.findUnique = async () => ({ id, url: 'https://example.com/webhook', signingSecret: null }) as any;
  let updatedData: any;
  prisma.webhookSubscription.update = async (args: any) => {
    updatedData = args.data;
    return {} as any;
  };

  try {
    const res = await fastify.inject({
      method: 'POST',
      url: `/api/webhooks/${id}/test`,
      headers: { 'x-service-token': 'test-service-secret-value' },
    });

    t.equal(res.statusCode, 200, 'endpoint returns delivery result');
    const body = JSON.parse(res.body);
    t.equal(body.success, false, 'test result fails');
    t.equal(body.statusCode, 500, 'returns failing status code');
    t.equal(body.error, 'HTTP 500', 'returns HTTP error message');
    t.equal(updatedData?.lastTestStatus, 'failed', 'stores failed status');
    t.equal(updatedData?.lastTestStatusCode, 500, 'stores failed status code');
  } finally {
    global.fetch = originalFetch;
    t.end();
  }
});

test('webhook test fails without status code for unreachable URL', async (t) => {
  await fastify.ready();
  webhookQueue.add = async () => ({
    waitUntilFinished: async () => { throw new Error('connect ECONNREFUSED'); },
  } as any);
  
  const originalFetch = global.fetch;
  global.fetch = async () => { throw new Error('connect ECONNREFUSED'); };

  const id = 'wh_fail_network';
  prisma.webhookSubscription.findUnique = async () => ({ id, url: 'https://example.com/webhook', signingSecret: null }) as any;
  let updatedData: any;
  prisma.webhookSubscription.update = async (args: any) => {
    updatedData = args.data;
    return {} as any;
  };

  try {
    const res = await fastify.inject({
      method: 'POST',
      url: `/api/webhooks/${id}/test`,
      headers: { 'x-service-token': 'test-service-secret-value' },
    });

    t.equal(res.statusCode, 200, 'endpoint returns delivery result');
    const body = JSON.parse(res.body);
    t.equal(body.success, false, 'test result fails');
    t.notOk('statusCode' in body, 'does not return status code');
    t.equal(body.error, 'connect ECONNREFUSED', 'returns connection error');
    t.equal(updatedData?.lastTestStatus, 'failed', 'stores failed status');
    t.equal(updatedData?.lastTestStatusCode, null, 'stores null status code');
  } finally {
    global.fetch = originalFetch;
    t.end();
  }
});

test('webhook test returns 403 and does not mutate lastTestedAt for a cross-merchant caller (#624)', async (t) => {
  await fastify.ready();

  const id = 'wh_owned_by_mch_b';
  prisma.webhookSubscription.findUnique = async () => ({
    id,
    url: 'https://example.com/webhook',
    signingSecret: null,
    merchantId: 'mch_b',
  }) as any;
  let updateCalled = false;
  prisma.webhookSubscription.update = async () => {
    updateCalled = true;
    return {} as any;
  };

  try {
    const res = await fastify.inject({
      method: 'POST',
      url: `/api/webhooks/${id}/test?merchantId=mch_a`,
      headers: { 'x-service-token': 'test-service-secret-value' },
    });

    t.equal(res.statusCode, 403, 'cross-merchant test is forbidden');
    const body = JSON.parse(res.body);
    t.equal(body.error.code, 'FORBIDDEN', 'error code identifies the rejection');
    t.equal(updateCalled, false, 'lastTestedAt/lastTestStatus are not mutated');
  } finally {
    t.end();
  }
});

test('webhook test succeeds when the caller owns the subscription (#624)', async (t) => {
  await fastify.ready();
  webhookQueue.add = async () => ({
    waitUntilFinished: async () => {},
  } as any);

  const originalFetch = global.fetch;
  global.fetch = async () => new Response('', { status: 200 });

  const id = 'wh_owned_by_mch_a';
  prisma.webhookSubscription.findUnique = async () => ({
    id,
    url: 'https://example.com/webhook',
    signingSecret: null,
    merchantId: 'mch_a',
  }) as any;
  let updatedData: any;
  prisma.webhookSubscription.update = async (args: any) => {
    updatedData = args.data;
    return {} as any;
  };

  try {
    const res = await fastify.inject({
      method: 'POST',
      url: `/api/webhooks/${id}/test?merchantId=mch_a`,
      headers: { 'x-service-token': 'test-service-secret-value' },
    });

    t.equal(res.statusCode, 200, 'own-subscription test succeeds');
    t.equal(updatedData?.lastTestStatus, 'success', 'lastTestStatus is updated');
  } finally {
    global.fetch = originalFetch;
    t.end();
  }
});

test('webhook test returns 404 for non-existent subscription', async (t) => {
  await fastify.ready();
  prisma.webhookSubscription.findUnique = async () => null;

  try {
    const res = await fastify.inject({
      method: 'POST',
      url: '/api/webhooks/missing/test',
      headers: { 'x-service-token': 'test-service-secret-value' },
    });

    t.equal(res.statusCode, 404, 'missing subscription returns 404');
  } finally {
    t.end();
  }
});

test('cleanup', async (t) => {
  await fastify.close();
  t.end();
  process.exit(0);
});
