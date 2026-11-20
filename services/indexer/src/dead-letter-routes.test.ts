/**
 * Issue #1063 — Validate positive limit on GET /api/admin/webhooks/dead-letter
 * and handle queue enqueue errors in POST /api/admin/webhooks/dead-letter/:id/replay.
 */

process.env.NODE_ENV = 'test';
process.env.METRICS_PORT = '0';
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

const { dlqQueue, fastify, prisma, webhookQueue } = await import('./index.js');

const AUTH_HEADERS = { 'x-service-token': 'test-service-secret-value' };

test('#1063: GET /api/admin/webhooks/dead-letter rejects negative and zero limit values with 400', async (t) => {
  await fastify.ready();

  for (const invalidLimit of ['-1', '-50', '0', '201', 'abc', '1.5']) {
    const res = await fastify.inject({
      method: 'GET',
      url: `/api/admin/webhooks/dead-letter?limit=${encodeURIComponent(invalidLimit)}`,
      headers: AUTH_HEADERS,
    });

    t.equal(res.statusCode, 400, `limit=${invalidLimit} returns HTTP 400`);
    const body = JSON.parse(res.body);
    t.equal(body.error?.code, 'VALIDATION_ERROR', `limit=${invalidLimit} returns VALIDATION_ERROR code`);
  }
  t.end();
});

test('#1063: GET /api/admin/webhooks/dead-letter accepts valid limit within [1, 200]', async (t) => {
  await fastify.ready();

  const originalGetJobs = dlqQueue.getJobs;
  const originalGetJobCounts = dlqQueue.getJobCounts;
  let capturedStart = -1;
  let capturedEnd = -1;

  dlqQueue.getJobs = (async (_types: unknown, start: number, end: number) => {
    capturedStart = start;
    capturedEnd = end;
    return [];
  }) as any;
  dlqQueue.getJobCounts = (async () => ({ failed: 0 })) as any;

  try {
    const res = await fastify.inject({
      method: 'GET',
      url: '/api/admin/webhooks/dead-letter?limit=25&offset=10',
      headers: AUTH_HEADERS,
    });

    t.equal(res.statusCode, 200, 'valid limit returns HTTP 200');
    const body = JSON.parse(res.body);
    t.equal(body.pagination?.limit, 25, 'pagination reflects parsed limit');
    t.equal(body.pagination?.offset, 10, 'pagination reflects parsed offset');
    t.equal(capturedStart, 10, 'dlqQueue.getJobs start is offset');
    t.equal(capturedEnd, 34, 'dlqQueue.getJobs end is offset + limit - 1');
  } finally {
    dlqQueue.getJobs = originalGetJobs;
    dlqQueue.getJobCounts = originalGetJobCounts;
  }
  t.end();
});

test('#1063: POST /api/admin/webhooks/dead-letter/:id/replay returns structured 503 on queue outage and keeps DLQ job', async (t) => {
  await fastify.ready();

  const originalGetJob = dlqQueue.getJob;
  const originalQueueAdd = webhookQueue.add;
  const originalFindUnique = prisma.webhookSubscription.findUnique;

  let removed = false;

  dlqQueue.getJob = (async (id: string) => ({
    id,
    data: {
      url: 'https://merchant.example/hook',
      event: { id: 'evt_dlq_outage' },
      subscriptionId: 'wh_sub_outage',
    },
    remove: async () => {
      removed = true;
    },
  })) as any;

  prisma.webhookSubscription.findUnique = (async () => ({
    signingSecret: null,
  })) as any;

  webhookQueue.add = (async () => {
    throw new Error('Redis connection lost: ECONNREFUSED');
  }) as any;

  try {
    const res = await fastify.inject({
      method: 'POST',
      url: '/api/admin/webhooks/dead-letter/dlq_outage_1/replay',
      headers: AUTH_HEADERS,
    });

    t.equal(res.statusCode, 503, 'queue outage returns HTTP 503');
    const body = JSON.parse(res.body);
    t.equal(body.error?.code, 'SERVICE_UNAVAILABLE', 'returns structured SERVICE_UNAVAILABLE error code');
    t.ok(typeof body.error?.message === 'string' && body.error.message.length > 0, 'includes error message');
    t.equal(removed, false, 'DLQ job is not removed when re-enqueue fails');
  } finally {
    dlqQueue.getJob = originalGetJob;
    webhookQueue.add = originalQueueAdd;
    prisma.webhookSubscription.findUnique = originalFindUnique;
  }
  t.end();
});

test.onFinish(() => {
  process.exit(0);
});
