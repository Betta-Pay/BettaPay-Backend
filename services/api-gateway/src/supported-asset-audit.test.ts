/**
 * Issue #613: PATCH/DELETE /api/admin/assets/:code already wrote an
 * AuditLog row (asset.updated / asset.deleted), but always logged
 * `{ before: null, after: ... }` — so forensics could see the new state but
 * never what changed, e.g. whether isActive flipped true -> false. Both
 * routes now capture the prior row (a findUnique before PATCH, and the
 * value delete() itself returns before DELETE) and log it as `before`.
 */

import test from 'tape';
import { createTestApp } from './test-utils.js';
import { validateEnv } from '@bettapay/validation';

const env = validateEnv(process.env);
const SECRET = env.INTER_SERVICE_SECRET || 'inter-service-secret-value';

test('PATCH /api/admin/assets/:code audit-logs the prior isActive value, not null', async (t) => {
  const { app, mockPrisma } = await createTestApp(
    {},
    { supportedAssets: [{ code: 'USDC', isActive: true }] },
  );

  const res = await app.inject({
    method: 'PATCH',
    url: '/api/admin/assets/USDC',
    headers: { 'x-service-token': SECRET, 'x-csrf-check': '1' },
    payload: { isActive: false },
  });

  t.equal(res.statusCode, 200, 'returns 200');

  const entries = await mockPrisma.auditLog.findMany({ where: { entityType: 'SupportedAsset' } });
  t.equal(entries.length, 1, 'one audit row written');
  t.equal(entries[0].action, 'asset.updated', 'action is asset.updated');
  t.equal(entries[0].changes.before?.isActive, true, 'before.isActive captures the prior value');
  t.equal(entries[0].changes.after?.isActive, false, 'after.isActive captures the new value');

  await app.close();
  t.end();
});

test('DELETE /api/admin/assets/:code audit-logs the deleted row, not null', async (t) => {
  const { app, mockPrisma } = await createTestApp(
    {},
    { supportedAssets: [{ code: 'USDC', isActive: true }] },
  );

  const res = await app.inject({
    method: 'DELETE',
    url: '/api/admin/assets/USDC',
    headers: { 'x-service-token': SECRET, 'x-csrf-check': '1' },
  });

  t.equal(res.statusCode, 204, 'returns 204');

  const entries = await mockPrisma.auditLog.findMany({ where: { entityType: 'SupportedAsset' } });
  t.equal(entries.length, 1, 'one audit row written');
  t.equal(entries[0].action, 'asset.deleted', 'action is asset.deleted');
  t.equal(entries[0].changes.before?.code, 'USDC', 'before captures the deleted row');
  t.equal(entries[0].changes.after, null, 'after is null for a delete');

  await app.close();
  t.end();
});

test('GET /api/admin/audit-log?entityType=SupportedAsset surfaces the toggle', async (t) => {
  const { app } = await createTestApp(
    {},
    { supportedAssets: [{ code: 'USDC', isActive: true }] },
  );

  await app.inject({
    method: 'PATCH',
    url: '/api/admin/assets/USDC',
    headers: { 'x-service-token': SECRET, 'x-csrf-check': '1' },
    payload: { isActive: false },
  });

  const res = await app.inject({
    method: 'GET',
    url: '/api/admin/audit-log?entityType=SupportedAsset',
    headers: { 'x-service-token': SECRET },
  });

  t.equal(res.statusCode, 200, 'returns 200');
  const body = JSON.parse(res.body as string);
  t.equal(body.data.length, 1, 'the toggle is visible via the admin audit-log endpoint');
  t.equal(body.data[0].entityId, 'USDC', 'entityId is the asset code');

  await app.close();
  t.end();
});
