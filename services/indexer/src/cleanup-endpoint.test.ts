/**
 * Tests for POST /api/events/cleanup (#885): dry-run counting, deletion scoped
 * to expired rows only, and a stable response shape.
 *
 * Prisma is replaced with an in-memory event store that honours the
 * `indexedAt < cutoff` and `id notIn [...]` filters, so the tests observe what
 * actually survives a run rather than just which calls were made.
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

const { env, fastify, prisma, webhookQueue } = await import('./index.js');

const RETENTION_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const ROW_SIZE_BYTES = 100;
const AUTH = { 'x-service-token': 'test-service-secret-value' };

interface Row {
  id: string;
  indexedAt: Date;
}

const daysAgo = (days: number): Date => new Date(Date.now() - days * DAY_MS);

let rows: Row[] = [];

function seedRows(): void {
  rows = [
    { id: 'evt_expired_old', indexedAt: daysAgo(90) },
    { id: 'evt_expired_recent', indexedAt: daysAgo(RETENTION_DAYS + 1) },
    { id: 'evt_inside_window', indexedAt: daysAgo(RETENTION_DAYS - 1) },
    { id: 'evt_fresh', indexedAt: daysAgo(1) },
  ];
}

function matches(row: Row, where: any): boolean {
  if (where?.indexedAt?.lt && !(row.indexedAt < where.indexedAt.lt)) return false;
  if (where?.id?.notIn && where.id.notIn.includes(row.id)) return false;
  return true;
}

const original = {
  count: prisma.indexedEvent.count,
  findFirst: prisma.indexedEvent.findFirst,
  deleteMany: prisma.indexedEvent.deleteMany,
  queryRawUnsafe: prisma.$queryRawUnsafe,
  getJobs: webhookQueue.getJobs,
  retention: env.EVENT_RETENTION_DAYS,
};

function installFakes(): void {
  env.EVENT_RETENTION_DAYS = RETENTION_DAYS;
  seedRows();
  prisma.indexedEvent.count = (async ({ where }: any) =>
    rows.filter((r) => matches(r, where)).length) as any;
  prisma.indexedEvent.findFirst = (async ({ where }: any) => {
    const found = rows
      .filter((r) => matches(r, where))
      .sort((a, b) => a.indexedAt.getTime() - b.indexedAt.getTime())[0];
    return found ? { indexedAt: found.indexedAt } : null;
  }) as any;
  prisma.indexedEvent.deleteMany = (async ({ where }: any) => {
    const before = rows.length;
    rows = rows.filter((r) => !matches(r, where));
    return { count: before - rows.length };
  }) as any;
  prisma.$queryRawUnsafe = (async (_sql: string, cutoff: Date) => [
    { total_bytes: BigInt(rows.filter((r) => r.indexedAt < cutoff).length * ROW_SIZE_BYTES) },
  ]) as any;
  webhookQueue.getJobs = (async () => []) as any;
}

function restoreFakes(): void {
  prisma.indexedEvent.count = original.count;
  prisma.indexedEvent.findFirst = original.findFirst;
  prisma.indexedEvent.deleteMany = original.deleteMany;
  prisma.$queryRawUnsafe = original.queryRawUnsafe;
  webhookQueue.getJobs = original.getJobs;
  env.EVENT_RETENTION_DAYS = original.retention;
}

async function cleanup(query = ''): Promise<{ status: number; body: any }> {
  await fastify.ready();
  const res = await fastify.inject({
    method: 'POST',
    url: `/api/events/cleanup${query}`,
    headers: AUTH,
  });
  return { status: res.statusCode, body: JSON.parse(res.body) };
}

const ALL_FIELDS = ['deletedCount', 'oldestEventDate', 'retentionDays', 'status', 'totalSizeBytes', 'wouldDelete'];

const ids = (): string[] => rows.map((r) => r.id).sort();

test('dry-run returns the expired count and leaves every row in place', async (t) => {
  installFakes();
  try {
    const before = ids();
    const { status, body } = await cleanup('?dryRun=true');

    t.equal(status, 200, 'responds 200');
    t.equal(body.wouldDelete, 2, 'wouldDelete counts only the expired rows');
    t.equal(body.totalSizeBytes, 2 * ROW_SIZE_BYTES, 'totalSizeBytes covers only the expired rows');
    t.equal(body.retentionDays, RETENTION_DAYS, 'retentionDays reflects the configured window');
    t.equal(
      body.oldestEventDate,
      rows.find((r) => r.id === 'evt_expired_old')!.indexedAt.toISOString(),
      'oldestEventDate is the oldest expired row',
    );
    t.deepEqual(ids(), before, 'row set is unchanged after a dry-run');
  } finally {
    restoreFakes();
  }
  t.end();
});

test('real run deletes exactly the expired rows and reports that count', async (t) => {
  installFakes();
  try {
    const { status, body } = await cleanup();

    t.equal(status, 200, 'responds 200');
    t.equal(body.status, 'completed', 'status is completed');
    t.equal(body.deletedCount, 2, 'deletedCount equals the number of expired rows');
    t.deepEqual(
      ids(),
      ['evt_fresh', 'evt_inside_window'],
      'only the rows inside the retention window remain',
    );
  } finally {
    restoreFakes();
  }
  t.end();
});

test('a row inside the retention window survives a real run', async (t) => {
  installFakes();
  try {
    await cleanup();
    t.ok(ids().includes('evt_inside_window'), 'row one day inside the window is kept');
    t.ok(ids().includes('evt_fresh'), 'fresh row is kept');
    t.notOk(ids().includes('evt_expired_recent'), 'row one day past the window is deleted');
  } finally {
    restoreFakes();
  }
  t.end();
});

test('without a dryRun query param the endpoint performs a real run', async (t) => {
  installFakes();
  try {
    const { body } = await cleanup();

    t.equal(body.status, 'completed', 'response is a real-run response');
    t.equal(ids().length, 2, 'expired rows were actually deleted');
  } finally {
    restoreFakes();
  }
  t.end();
});

test('the dry-run count previews exactly what a real run then deletes', async (t) => {
  installFakes();
  try {
    const preview = await cleanup('?dryRun=true');
    const real = await cleanup();

    t.equal(preview.body.wouldDelete, real.body.deletedCount, 'preview count equals deleted count');
  } finally {
    restoreFakes();
  }
  t.end();
});

test('a second real run is a no-op once the expired rows are gone', async (t) => {
  installFakes();
  try {
    await cleanup();
    const again = await cleanup();

    t.equal(again.body.deletedCount, 0, 'nothing left to delete');
    t.equal(ids().length, 2, 'surviving rows are untouched');
  } finally {
    restoreFakes();
  }
  t.end();
});

test('dry-run and real run have identical fields, differing only in status', async (t) => {
  installFakes();
  try {
    const dry = await cleanup('?dryRun=true');
    const real = await cleanup();
    t.deepEqual(Object.keys(dry.body).sort(), Object.keys(real.body).sort(), 'same field names');
    t.equal(dry.body.status, 'dry-run', 'dry-run status');
    t.equal(real.body.status, 'completed', 'real-run status');
    t.equal(dry.body.deletedCount, 0, 'dry-run deletes nothing');
    t.equal(real.body.wouldDelete, dry.body.wouldDelete, 'real run reports the same preview count');
    t.equal(real.body.deletedCount, dry.body.wouldDelete, 'deleted count equals previewed count');
  } finally {
    restoreFakes();
  }
  t.end();
});

test('response shape is stable across calls in each mode', async (t) => {
  installFakes();
  try {
    const dry1 = await cleanup('?dryRun=true');
    const dry2 = await cleanup('?dryRun=true');
    t.deepEqual(
      Object.keys(dry1.body).sort(),
      ALL_FIELDS,
      'dry-run exposes the documented fields',
    );
    t.deepEqual(Object.keys(dry2.body).sort(), Object.keys(dry1.body).sort(), 'dry-run keys are stable');

    const real1 = await cleanup();
    const real2 = await cleanup();
    t.deepEqual(
      Object.keys(real1.body).sort(),
      ALL_FIELDS,
      'real run exposes the documented fields',
    );
    t.deepEqual(Object.keys(real2.body).sort(), Object.keys(real1.body).sort(), 'real-run keys are stable');
  } finally {
    restoreFakes();
  }
  t.end();
});

test.onFinish(() => {
  // The indexer module opens Redis/queue connections at import time.
  process.exit(0);
});
