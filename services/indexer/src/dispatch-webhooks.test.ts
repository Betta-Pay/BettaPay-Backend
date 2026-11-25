/**
 * Issue #1053 — Atomically claim and paginate dispatchPendingWebhookDeliveries.
 *
 * Verifies:
 *   1. Backlogs larger than 100 pending deliveries are drained across batches.
 *   2. Per-tick cap bounds the number of deliveries dispatched in a single call.
 *   3. Concurrent dispatchPendingWebhookDeliveries runs never double-enqueue the same delivery.
 *   4. Failed queue.add calls roll the delivery status back to pending.
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

const { dispatchPendingWebhookDeliveries } = await import('./index.js');

interface DeliveryRow {
  id: string;
  url: string;
  event: Record<string, unknown>;
  signingSecret: string | null;
  subscriptionId: string;
  headers: Record<string, string> | null;
  status: string;
  processedAt: Date | null;
  createdAt: Date;
}

function createInMemoryDeliveryStore(count: number) {
  const rows: DeliveryRow[] = Array.from({ length: count }, (_, idx) => ({
    id: `del_${idx + 1}`,
    url: `https://merchant.example.com/hook/${idx + 1}`,
    event: { id: `evt_${idx + 1}`, type: 'PaymentCompleted' },
    signingSecret: null,
    subscriptionId: `sub_${idx + 1}`,
    headers: null,
    status: 'pending',
    processedAt: null,
    createdAt: new Date(1_700_000_000_000 + idx),
  }));

  return {
    rows,
    async findMany(args: {
      where: { status: string };
      orderBy: { createdAt: 'asc' };
      take: number;
    }) {
      return rows
        .filter((r) => r.status === args.where.status)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        .slice(0, args.take)
        .map((r) => ({ ...r }));
    },
    async updateMany(args: {
      where: { id: string; status: string };
      data: { status: string; processedAt?: Date | null };
    }) {
      const row = rows.find(
        (r) => r.id === args.where.id && r.status === args.where.status,
      );
      if (!row) {
        return { count: 0 };
      }
      row.status = args.data.status;
      if (args.data.processedAt !== undefined) {
        row.processedAt = args.data.processedAt;
      }
      return { count: 1 };
    },
  };
}

test('#1053: drains backlogs larger than 100 pending deliveries across batches', async (t) => {
  const store = createInMemoryDeliveryStore(250);
  const enqueuedIds: string[] = [];

  await dispatchPendingWebhookDeliveries({
    store,
    queue: {
      add: async (_name, _data, opts) => {
        enqueuedIds.push(String(opts?.jobId));
        return {} as any;
      },
    },
    decrypt: (v) => v,
    log: { warn: () => {} },
  });

  t.equal(enqueuedIds.length, 250, 'all 250 pending deliveries are enqueued');
  t.equal(
    store.rows.filter((r) => r.status === 'processed').length,
    250,
    'all 250 deliveries transitioned to processed',
  );
  t.end();
});

test('#1053: respects maxPerTick cap when backlog exceeds cap', async (t) => {
  const store = createInMemoryDeliveryStore(250);
  const enqueuedIds: string[] = [];

  await dispatchPendingWebhookDeliveries({
    store,
    queue: {
      add: async (_name, _data, opts) => {
        enqueuedIds.push(String(opts?.jobId));
        return {} as any;
      },
    },
    decrypt: (v) => v,
    log: { warn: () => {} },
    batchSize: 50,
    maxPerTick: 120,
  });

  t.equal(enqueuedIds.length, 120, 'stops at maxPerTick cap (120)');
  t.equal(
    store.rows.filter((r) => r.status === 'pending').length,
    130,
    'remaining 130 deliveries stay pending for next tick',
  );
  t.end();
});

test('#1053: concurrent dispatchPendingWebhookDeliveries runs never double-enqueue', async (t) => {
  const store = createInMemoryDeliveryStore(150);
  const enqueuedIds: string[] = [];

  const queue = {
    add: async (_name: string, _data: unknown, opts?: { jobId?: string }) => {
      // Yield to interleave concurrent dispatchers
      await Promise.resolve();
      enqueuedIds.push(String(opts?.jobId));
      return {} as any;
    },
  };

  await Promise.all([
    dispatchPendingWebhookDeliveries({
      store,
      queue: queue as any,
      decrypt: (v) => v,
      log: { warn: () => {} },
    }),
    dispatchPendingWebhookDeliveries({
      store,
      queue: queue as any,
      decrypt: (v) => v,
      log: { warn: () => {} },
    }),
  ]);

  const unique = new Set(enqueuedIds);
  t.equal(enqueuedIds.length, 150, 'total enqueues equal exactly 150');
  t.equal(unique.size, 150, 'no delivery was double-enqueued');
  t.end();
});

test('#1053: rolls back claimed status to pending if queue.add fails', async (t) => {
  const store = createInMemoryDeliveryStore(2);
  const warnings: string[] = [];

  await dispatchPendingWebhookDeliveries({
    store,
    queue: {
      add: async (_name, _data, opts) => {
        if (opts?.jobId === 'indexed-event-delivery-del_1') {
          throw new Error('Redis unavailable');
        }
        return {} as any;
      },
    },
    decrypt: (v) => v,
    log: {
      warn: (_obj, msg) => {
        warnings.push(msg);
      },
    },
  });

  t.equal(store.rows[0].status, 'pending', 'failed delivery rolled back to pending');
  t.equal(store.rows[0].processedAt, null, 'processedAt cleared on rollback');
  t.equal(store.rows[1].status, 'processed', 'successful delivery remains processed');
  t.equal(warnings.length, 1, 'warning logged for failed enqueue');
  t.end();
});
