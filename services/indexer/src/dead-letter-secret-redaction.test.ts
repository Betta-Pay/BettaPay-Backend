/**
 * Issue #1064 — Redact signingSecret before persisting failed jobs to
 * dead-letter storage, and re-fetch/decrypt it from the subscription record
 * during dead-letter replay.
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
import { encryptField } from '@bettapay/validation';

const {
  buildDeadLetterPayload,
  dlqQueue,
  fastify,
  prisma,
  webhookQueue,
  webhookWorker,
} = await import('./index.js');

const AUTH_HEADERS = { 'x-service-token': 'test-service-secret-value' };
const PLAINTEXT_SECRET = 'test-webhook-signing-value-1064';

test('#1064: buildDeadLetterPayload strips signingSecret while preserving delivery metadata', (t) => {
  const payload = buildDeadLetterPayload(
    {
      id: 'job_42',
      attemptsMade: 5,
      data: {
        url: 'https://merchant.example/webhook',
        event: { id: 'evt_1', type: 'PaymentCompleted' },
        signingSecret: PLAINTEXT_SECRET,
        subscriptionId: 'wh_sub_1',
        headers: { 'X-Custom-Header': 'abc' },
      },
    },
    new Error('HTTP 502 from merchant'),
  );

  t.equal('signingSecret' in payload, false, 'signingSecret key is absent from dead-letter payload');
  t.equal(payload.signingSecret, undefined, 'signingSecret value is undefined');
  t.equal(
    JSON.stringify(payload).includes(PLAINTEXT_SECRET),
    false,
    'plaintext secret does not appear anywhere in serialized payload',
  );
  t.equal(payload.url, 'https://merchant.example/webhook', 'url is preserved');
  t.equal(payload.subscriptionId, 'wh_sub_1', 'subscriptionId is preserved');
  t.deepEqual(payload.headers, { 'X-Custom-Header': 'abc' }, 'custom headers are preserved');
  t.equal(payload.error, 'HTTP 502 from merchant', 'error message is recorded');
  t.equal(payload.attempts, 5, 'attempts count is recorded');
  t.equal(payload.originalJobId, 'job_42', 'originalJobId is recorded');
  t.ok(typeof payload.failedAt === 'string', 'failedAt timestamp is recorded');
  t.end();
});

test('#1064: webhookWorker failed handler persists dead-letter record without signingSecret', async (t) => {
  const originalDlqAdd = dlqQueue.add;
  let capturedName: string | undefined;
  let capturedData: Record<string, unknown> | undefined;

  dlqQueue.add = (async (name: string, data: Record<string, unknown>) => {
    capturedName = name;
    capturedData = data;
    return { id: 'dlq_1' } as any;
  }) as any;

  try {
    const failedJob = {
      id: 'job_exhausted_1',
      attemptsMade: 5,
      opts: { attempts: 5 },
      data: {
        url: 'https://merchant.example/hook',
        event: { id: 'evt_99' },
        signingSecret: PLAINTEXT_SECRET,
        subscriptionId: 'wh_sub_99',
        headers: { Authorization: 'Bearer placeholder' },
      },
    };

    webhookWorker.emit('failed', failedJob as any, new Error('connect ETIMEDOUT'));
    await new Promise((resolve) => setTimeout(resolve, 25));

    t.equal(capturedName, 'failed-delivery', 'failed job was enqueued to dead-letter queue');
    t.ok(capturedData, 'dead-letter payload was captured');
    t.equal('signingSecret' in (capturedData ?? {}), false, 'signingSecret is omitted from DLQ record');
    t.equal(
      JSON.stringify(capturedData).includes(PLAINTEXT_SECRET),
      false,
      'plaintext secret is absent from serialized DLQ record',
    );
    t.equal(capturedData?.subscriptionId, 'wh_sub_99', 'subscriptionId is kept for replay lookup');
  } finally {
    dlqQueue.add = originalDlqAdd;
  }
  t.end();
});

test('#1064: dead-letter replay re-fetches and decrypts signingSecret from subscription by subscriptionId', async (t) => {
  await fastify.ready();

  const originalGetJob = dlqQueue.getJob;
  const originalQueueAdd = webhookQueue.add;
  const originalFindUnique = prisma.webhookSubscription.findUnique;

  let removed = false;
  let replayedPayload: Record<string, unknown> | undefined;
  let queriedId: string | undefined;

  dlqQueue.getJob = (async (id: string) => ({
    id,
    data: {
      url: 'https://merchant.example/hook',
      event: { id: 'evt_replay_1' },
      subscriptionId: 'wh_sub_encrypted',
      headers: { 'X-Idempotency-Key': 'idem-1' },
    },
    remove: async () => {
      removed = true;
    },
  })) as any;

  prisma.webhookSubscription.findUnique = (async (args: any) => {
    queriedId = args?.where?.id;
    return {
      signingSecret: encryptField(PLAINTEXT_SECRET),
    } as any;
  }) as any;

  webhookQueue.add = (async (_name: string, data: Record<string, unknown>) => {
    replayedPayload = data;
    return { id: 'replayed_job_1' } as any;
  }) as any;

  try {
    const res = await fastify.inject({
      method: 'POST',
      url: '/api/admin/webhooks/dead-letter/dlq_100/replay',
      headers: AUTH_HEADERS,
    });

    t.equal(res.statusCode, 200, 'replay returns 200');
    t.equal(queriedId, 'wh_sub_encrypted', 'looked up subscription by subscriptionId');
    t.equal(replayedPayload?.signingSecret, PLAINTEXT_SECRET, 'decrypted signingSecret passed to webhookQueue.add');
    t.deepEqual(replayedPayload?.headers, { 'X-Idempotency-Key': 'idem-1' }, 'headers preserved on replay');
    t.equal(removed, true, 'DLQ job removed after re-enqueue');
  } finally {
    dlqQueue.getJob = originalGetJob;
    webhookQueue.add = originalQueueAdd;
    prisma.webhookSubscription.findUnique = originalFindUnique;
  }
  t.end();
});

test('#1064: dead-letter replay falls back to subscription lookup by URL when subscriptionId is absent', async (t) => {
  await fastify.ready();

  const originalGetJob = dlqQueue.getJob;
  const originalQueueAdd = webhookQueue.add;
  const originalFindFirst = prisma.webhookSubscription.findFirst;

  let replayedPayload: Record<string, unknown> | undefined;
  let queriedUrl: string | undefined;

  dlqQueue.getJob = (async (id: string) => ({
    id,
    data: {
      url: 'https://merchant.example/legacy-hook',
      event: { id: 'evt_legacy_1' },
    },
    remove: async () => {},
  })) as any;

  prisma.webhookSubscription.findFirst = (async (args: any) => {
    queriedUrl = args?.where?.url;
    return {
      signingSecret: encryptField(PLAINTEXT_SECRET),
    } as any;
  }) as any;

  webhookQueue.add = (async (_name: string, data: Record<string, unknown>) => {
    replayedPayload = data;
    return { id: 'replayed_job_2' } as any;
  }) as any;

  try {
    const res = await fastify.inject({
      method: 'POST',
      url: '/api/admin/webhooks/dead-letter/dlq_legacy/replay',
      headers: AUTH_HEADERS,
    });

    t.equal(res.statusCode, 200, 'replay returns 200');
    t.equal(queriedUrl, 'https://merchant.example/legacy-hook', 'looked up subscription by url fallback');
    t.equal(replayedPayload?.signingSecret, PLAINTEXT_SECRET, 'decrypted signingSecret passed to webhookQueue.add');
  } finally {
    dlqQueue.getJob = originalGetJob;
    webhookQueue.add = originalQueueAdd;
    prisma.webhookSubscription.findFirst = originalFindFirst;
  }
  t.end();
});

test.onFinish(() => {
  process.exit(0);
});
