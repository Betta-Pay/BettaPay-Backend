/**
 * Issue #907 — Require a service token on the admin audit-log route.
 *
 * GET /api/admin/audit-log is protected by serviceAuth and must return 401
 * for any caller that does not supply a valid x-service-token header.
 */
import test from 'tape';
import { buildApp } from './index.js';
import { createMockPrisma, createTestApp } from './test-utils.js';

const AUTH_TOKEN = process.env.INTER_SERVICE_SECRET || 'dev-inter-service-secret';

async function withApp(fn: (app: ReturnType<typeof buildApp>) => Promise<void>) {
  const app = buildApp({ prisma: createMockPrisma() as any, logger: false });
  await app.ready();
  try {
    await fn(app);
  } finally {
    await app.close();
  }
}

test('GET /api/admin/audit-log: returns 401 without a service token (#907)', async (t) => {
  await withApp(async (app) => {
    const res = await app.inject({ method: 'GET', url: '/api/admin/audit-log' });
    t.equal(res.statusCode, 401, 'returns 401 when no x-service-token is provided');
    const body = JSON.parse(res.body);
    t.equal(body.error.code, 'UNAUTHORIZED', 'error code is UNAUTHORIZED');
  });
  t.end();
});

test('GET /api/admin/audit-log: returns 401 with an incorrect service token (#907)', async (t) => {
  await withApp(async (app) => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/audit-log',
      headers: { 'x-service-token': 'wrong-token-value' },
    });
    t.equal(res.statusCode, 401, 'returns 401 for an invalid token');
  });
  t.end();
});

test('GET /api/admin/audit-log: returns 200 with a valid service token (#907)', async (t) => {
  await withApp(async (app) => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/audit-log',
      headers: { 'x-service-token': AUTH_TOKEN },
    });
    t.notEqual(res.statusCode, 401, 'valid service token is not rejected');
    t.notEqual(res.statusCode, 403, 'valid service token is not forbidden');
  });
  t.end();
});

test('GET /api/admin/audit-log: rejects malformed and reversed date ranges', async (t) => {
  await withApp(async (app) => {
    for (const range of [
      'startDate=not-a-date',
      'endDate=2026-02-30',
      'startDate=2026-12-31&endDate=2026-01-01',
    ]) {
      const res = await app.inject({
        method: 'GET',
        url: `/api/admin/audit-log?${range}`,
        headers: { 'x-service-token': AUTH_TOKEN },
      });
      t.equal(res.statusCode, 400, `${range} returns 400`);
    }
  });
  t.end();
});

test('GET /api/admin/audit-log: valid ISO date range filters records', async (t) => {
  const { app } = await createTestApp(
    {},
    {
      auditLogs: [
        { id: 'old', createdAt: new Date('2026-01-01T00:00:00.000Z') },
        { id: 'in-range', createdAt: new Date('2026-02-01T12:00:00.000Z') },
        { id: 'new', createdAt: new Date('2026-03-01T00:00:00.000Z') },
      ],
    },
  );
  const res = await app.inject({
    method: 'GET',
    url: '/api/admin/audit-log?startDate=2026-02-01&endDate=2026-02-28',
    headers: { 'x-service-token': AUTH_TOKEN },
  });
  const body = JSON.parse(res.body);
  t.equal(res.statusCode, 200, 'returns 200 for a valid range');
  t.deepEqual(body.data.map((row: { id: string }) => row.id), ['in-range']);
  await app.close();
  t.end();
});
