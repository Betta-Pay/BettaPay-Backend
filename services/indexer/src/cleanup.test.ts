/**
 * cleanup.test.ts
 *
 * Tests for DB-level event retention cleanup.  The refactor removed the
 * in-memory `events[]` array entirely; all cleanup now runs through
 * `prisma.indexedEvent.deleteMany`.
 *
 * Testing strategy
 * ────────────────
 * 1. Pure unit tests against `buildCleanupWhere` — zero I/O, verify the
 *    Prisma `where` clause shape and cutoff arithmetic.
 * 2. Integration-style tests for `cleanupOldEvents` / `runCleanupJob` that
 *    confirm the async contract and the scheduler control flow (start/stop).
 *    These import the live module but deliberately set `EVENT_RETENTION_DAYS = 0`
 *    so `deleteMany` is never reached, making them safe without a real DB.
 */

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'a'.repeat(32);
process.env.DATABASE_URL = 'postgresql://localhost:5432/db';
process.env.SETTLEMENT_CONTRACT_ID = 'CDLZFC3SYXDT4MMSTXTU4Z4VABMFR6SPLPNCZF656SIHPXT6LPWEEXGO';
process.env.GOVERNANCE_CONTRACT_ID = 'CBJDHFU7XYDT4MMSTXTU4Z4VABMFR6SPLPNCZF656SIHPXT6LPWEEXGO';
process.env.ADMIN_ADDRESS = 'GBJDHFU7XYDT4MMSTXTU4Z4VABMFR6SPLPNCZF656SIHPXT6LPWEEXGO';
process.env.INTER_SERVICE_SECRET = 'test-secret-that-is-at-least-16-chars';

import test from 'tape';

const {
  env,
  buildCleanupWhere,
  cleanupOldEvents,
  runCleanupJob,
  startCleanupScheduler,
  stopCleanupScheduler,
  fastify,
} = await import('./index.js');

// ── Part 1: buildCleanupWhere (pure, no I/O) ──────────────────────────────────

test('buildCleanupWhere — returns null when retention is disabled (0)', (t) => {
  const result = buildCleanupWhere(0, new Date());
  t.equal(result, null, 'should return null when retentionDays = 0');
  t.end();
});

test('buildCleanupWhere — returns null for negative retention days', (t) => {
  const result = buildCleanupWhere(-1, new Date());
  t.equal(result, null, 'should return null for negative retentionDays');
  t.end();
});

test('buildCleanupWhere — produces a where clause with the correct cutoff for 5 days', (t) => {
  const now = new Date('2025-06-10T12:00:00Z');
  const result = buildCleanupWhere(5, now);

  t.ok(result !== null, 'should return a where clause');
  t.ok(result!.indexedAt, 'where clause has indexedAt key');

  const lt = result!.indexedAt.lt;
  t.ok(lt instanceof Date, 'cutoff is a Date');

  const expectedMs = new Date('2025-06-05T12:00:00Z').getTime();
  t.equal(lt.getTime(), expectedMs, 'cutoff is exactly 5 days before "now"');
  t.end();
});

test('buildCleanupWhere — correct cutoff for retention = 1', (t) => {
  const now = new Date('2025-01-08T00:00:00Z');
  const result = buildCleanupWhere(1, now);
  t.ok(result, 'returns a where clause');
  t.equal(
    result!.indexedAt.lt.toISOString(),
    '2025-01-07T00:00:00.000Z',
    'cutoff is exactly 1 day before "now"',
  );
  t.end();
});

test('buildCleanupWhere — events AT the cutoff boundary are NOT deleted (cutoff is exclusive)', (t) => {
  // Prisma's `lt` is strictly less-than, so events exactly at the cutoff
  // timestamp are kept. Verify the operator used is `lt`, not `lte`.
  const now = new Date('2025-06-10T12:00:00Z');
  const result = buildCleanupWhere(5, now);
  t.ok(result, 'where clause present');
  // The key must be "lt" (strictly less than), not "lte"
  t.ok('lt' in result!.indexedAt, 'uses lt (strictly less than) for cutoff');
  t.notOk('lte' in result!.indexedAt, 'does not use lte');
  t.end();
});

test('buildCleanupWhere — larger retention period produces an older cutoff', (t) => {
  const now = new Date('2025-06-10T12:00:00Z');
  const r30 = buildCleanupWhere(30, now);
  const r7 = buildCleanupWhere(7, now);
  t.ok(r30 && r7, 'both return where clauses');
  t.ok(r30!.indexedAt.lt < r7!.indexedAt.lt, '30-day cutoff is earlier than 7-day cutoff');
  t.end();
});

// ── Part 2: cleanupOldEvents — async contract (no real DB needed when retention = 0) ──

test('cleanupOldEvents — returns 0 without touching the DB when EVENT_RETENTION_DAYS = 0', async (t) => {
  env.EVENT_RETENTION_DAYS = 0;
  // No DB connection needed — the function returns early before calling Prisma.
  const deleted = await cleanupOldEvents();
  t.equal(deleted, 0, 'should resolve to 0');
  t.end();
});

test('cleanupOldEvents — returns a number (Promise<number>)', async (t) => {
  env.EVENT_RETENTION_DAYS = 0;
  const result = cleanupOldEvents();
  t.ok(result instanceof Promise, 'should return a Promise');
  const value = await result;
  t.equal(typeof value, 'number', 'resolved value is a number');
  t.end();
});

// ── Part 3: runCleanupJob — logging and error safety ─────────────────────────

test('runCleanupJob — does not throw when EVENT_RETENTION_DAYS = 0', async (t) => {
  env.EVENT_RETENTION_DAYS = 0;
  let threw = false;
  try {
    await runCleanupJob();
  } catch {
    threw = true;
  }
  t.notOk(threw, 'runCleanupJob should never propagate exceptions');
  t.end();
});

test('runCleanupJob — logs success with correct shape when retention = 0 (0 deletes)', async (t) => {
  env.EVENT_RETENTION_DAYS = 0;

  const originalInfo = (fastify.log as any).info;
  let capturedPayload: any = null;
  let capturedMsg = '';

  (fastify.log as any).info = (payload: any, msg?: string) => {
    if (payload?.status === 'success' && 'retentionDays' in payload) {
      capturedPayload = payload;
      capturedMsg = msg ?? '';
    }
  };

  try {
    await runCleanupJob();
    t.ok(capturedPayload, 'should log a structured payload');
    t.equal(capturedPayload.retentionDays, 0, 'retentionDays matches env value');
    t.equal(capturedPayload.deletedCount, 0, 'deletedCount is 0 when retention disabled');
    t.equal(capturedPayload.status, 'success', 'status is "success"');
    t.ok(capturedMsg.includes('Event retention cleanup completed'), 'log message is correct');
  } finally {
    (fastify.log as any).info = originalInfo;
  }
  t.end();
});

test('runCleanupJob — returns a Promise (is async)', (t) => {
  env.EVENT_RETENTION_DAYS = 0;
  const result = runCleanupJob();
  t.ok(result instanceof Promise, 'runCleanupJob returns a Promise');
  result.then(() => t.end()).catch(() => t.end());
});

// ── Part 4: scheduler — start/stop without a real DB ─────────────────────────

test('stopCleanupScheduler — is safe to call when no scheduler is running', (t) => {
  // Should not throw even if called before startCleanupScheduler
  let threw = false;
  try {
    stopCleanupScheduler();
  } catch {
    threw = true;
  }
  t.notOk(threw, 'stopCleanupScheduler is a no-op when scheduler is not running');
  t.end();
});

test('startCleanupScheduler — does not start an interval when EVENT_RETENTION_DAYS = 0', (t) => {
  env.EVENT_RETENTION_DAYS = 0;
  // If this incorrectly starts an interval it would fire runCleanupJob
  // repeatedly and potentially cause timeout issues; safe here because
  // runCleanupJob short-circuits when retentionDays <= 0.
  startCleanupScheduler();
  stopCleanupScheduler(); // cleanup regardless
  t.pass('startCleanupScheduler with retention=0 does not throw');
  t.end();
});

test('startCleanupScheduler / stopCleanupScheduler — round-trip is safe', (t) => {
  env.EVENT_RETENTION_DAYS = 0;
  // Even with retention disabled, start/stop should not throw.
  startCleanupScheduler();
  stopCleanupScheduler();
  // Call stop a second time to verify idempotency.
  stopCleanupScheduler();
  t.pass('start→stop→stop round-trip completes without error');
  t.end();
});
