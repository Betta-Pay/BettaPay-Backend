/**
 * Issue #1060 — Exclude signingSecret from GET /api/webhooks response.
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

const { fastify, prisma } = await import('./index.js');

const AUTH_HEADERS = { 'x-service-token': 'test-service-secret-value' };

test('#1060: GET /api/webhooks uses explicit select excluding signingSecret and preserves metadata', async (t) => {
  await fastify.ready();

  const originalFindMany = prisma.webhookSubscription.findMany;
  let capturedArgs: Record<string, any> | undefined;

  const mockRow = {
    id: 'wh_1234567890abcdef',
    url: 'https://merchant.example.com/webhooks',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    merchantId: 'merchant_1',
    headers: { 'X-Custom-Header': 'value' },
    lastTestedAt: new Date('2026-01-02T00:00:00.000Z'),
    lastTestStatus: 'success',
    lastTestStatusCode: 200,
  };

  prisma.webhookSubscription.findMany = (async (args: any) => {
    capturedArgs = args;
    const select = args?.select ?? {};
    // Simulate Prisma projecting only selected fields
    const projected: Record<string, unknown> = {};
    const source: Record<string, unknown> = {
      ...mockRow,
      signingSecret: 'enc:v1:should-never-be-returned',
    };
    for (const [key, enabled] of Object.entries(select)) {
      if (enabled) {
        projected[key] = source[key];
      }
    }
    return [projected];
  }) as any;

  try {
    const res = await fastify.inject({
      method: 'GET',
      url: '/api/webhooks',
      headers: AUTH_HEADERS,
    });

    t.equal(res.statusCode, 200, 'returns HTTP 200');
    t.ok(capturedArgs?.select, 'Prisma findMany is called with explicit select');
    t.equal(
      Boolean(capturedArgs?.select?.signingSecret),
      false,
      'signingSecret is excluded from Prisma select',
    );

    const body = JSON.parse(res.body);
    t.equal(Array.isArray(body), true, 'response body is an array');
    t.equal(body.length, 1, 'returns one subscription');
    t.equal('signingSecret' in body[0], false, 'signingSecret is absent from response item');
    t.equal(body[0].id, mockRow.id, 'id is preserved');
    t.equal(body[0].url, mockRow.url, 'url is preserved');
    t.equal(body[0].merchantId, mockRow.merchantId, 'merchantId is preserved');
    t.deepEqual(body[0].headers, mockRow.headers, 'headers is preserved');
    t.equal(body[0].lastTestStatus, mockRow.lastTestStatus, 'lastTestStatus is preserved');
    t.equal(body[0].lastTestStatusCode, mockRow.lastTestStatusCode, 'lastTestStatusCode is preserved');
  } finally {
    prisma.webhookSubscription.findMany = originalFindMany;
  }

  t.end();
});
