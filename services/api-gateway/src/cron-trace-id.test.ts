/**
 * Issue #894 — Propagate trace IDs into cron runs.
 *
 * Both autoExpireAbandonedPayments and reclaimExpiredIdempotencyKeys emit a
 * traceId UUID in their log entries so cron activity can be correlated across
 * services without relying on a request ID (crons have no HTTP request).
 */
import test from 'tape';
import { autoExpireAbandonedPayments } from './abandoned-payments-cron.js';
import { reclaimExpiredIdempotencyKeys } from './idempotency-key-cleanup-cron.js';

// Minimal Prisma stubs
function makePrisma(): any {
  return {
    payment: {
      findMany: async () => [],
      updateMany: async () => ({ count: 0 }),
    },
    settlement: {
      updateMany: async () => ({ count: 0 }),
    },
  };
}

// Logger that captures structured log objects
function makeCapturingLogger() {
  const logs: object[] = [];
  const logger: any = {
    info: (obj: object | string, _msg?: string) => {
      if (typeof obj === 'object') logs.push(obj);
    },
    warn: (obj: object | string, _msg?: string) => {
      if (typeof obj === 'object') logs.push(obj);
    },
    error: (obj: object | string, _msg?: string) => {
      if (typeof obj === 'object') logs.push(obj);
    },
    debug: () => {},
    trace: () => {},
    child: () => logger,
  };
  return { logger, logs };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

test('#894: autoExpireAbandonedPayments emits traceId in log entries', async (t) => {
  const { logger, logs } = makeCapturingLogger();
  const prisma = makePrisma();

  await autoExpireAbandonedPayments(prisma, logger, 24);

  const withTraceId = logs.filter((l: any) => typeof l.traceId === 'string');
  t.ok(withTraceId.length > 0, 'at least one log entry contains a traceId field');

  const traceId = (withTraceId[0] as any).traceId;
  t.ok(UUID_RE.test(traceId), 'traceId is a valid UUID v4');
  t.end();
});

test('#894: autoExpireAbandonedPayments uses the same traceId throughout one run', async (t) => {
  const { logger, logs } = makeCapturingLogger();
  const prisma = makePrisma();

  await autoExpireAbandonedPayments(prisma, logger, 24);

  const traceIds = logs
    .filter((l: any) => typeof l.traceId === 'string')
    .map((l: any) => l.traceId);

  const unique = new Set(traceIds);
  t.ok(unique.size <= 1, 'all log entries within a single run share the same traceId');
  t.end();
});

test('#894: reclaimExpiredIdempotencyKeys emits traceId in log entries', async (t) => {
  const { logger, logs } = makeCapturingLogger();
  const prisma = makePrisma();

  await reclaimExpiredIdempotencyKeys(prisma, logger);

  const withTraceId = logs.filter((l: any) => typeof l.traceId === 'string');
  t.ok(withTraceId.length > 0, 'at least one log entry contains a traceId field');

  const traceId = (withTraceId[0] as any).traceId;
  t.ok(UUID_RE.test(traceId), 'traceId is a valid UUID v4');
  t.end();
});

test('#894: consecutive cron runs get distinct traceIds', async (t) => {
  const { logger: l1, logs: logs1 } = makeCapturingLogger();
  const { logger: l2, logs: logs2 } = makeCapturingLogger();
  const prisma = makePrisma();

  await autoExpireAbandonedPayments(prisma, l1, 24);
  await autoExpireAbandonedPayments(prisma, l2, 24);

  const id1 = (logs1.find((l: any) => l.traceId) as any)?.traceId;
  const id2 = (logs2.find((l: any) => l.traceId) as any)?.traceId;

  t.ok(id1 && id2, 'both runs produced a traceId');
  t.notEqual(id1, id2, 'consecutive runs have different traceIds');
  t.end();
});
