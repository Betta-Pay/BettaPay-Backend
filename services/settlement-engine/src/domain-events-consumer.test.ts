import test from 'tape';
import type { Job } from 'bullmq';
import { createDomainEventProcessor, type MirrorDelegate } from './domain-events-consumer.js';

const silentLog = {
  child() {
    return silentLog;
  },
  info() {},
  debug() {},
};

const job = (data: unknown) => ({ data }) as Job<any>;

const paymentCreated = {
  type: 'payment.created',
  id: 'pay_1',
  merchantId: 'm_1',
  amount: '10.00',
  asset: 'USDC',
  traceId: 't_1',
};

test('payment.created upserts into the mirror and is idempotent on redelivery', async (t) => {
  const rows = new Map<string, Record<string, unknown>>();
  const mirror: MirrorDelegate = {
    async upsert({ where, update, create }) {
      const existing = rows.get(where.id);
      rows.set(where.id, existing ? { ...existing, ...update } : create);
    },
  };
  const process = createDomainEventProcessor(() => mirror, silentLog);

  await process(job(paymentCreated));
  await process(job(paymentCreated));

  t.equal(rows.size, 1, 'redelivery does not duplicate the row');
  t.deepEqual(rows.get('pay_1'), {
    id: 'pay_1',
    merchantId: 'm_1',
    amount: '10.00',
    asset: 'USDC',
    status: 'initiated',
  });
  t.end();
});

test('missing mirror table is a guarded no-op', async (t) => {
  const process = createDomainEventProcessor(() => undefined, silentLog);
  await process(job(paymentCreated));
  t.pass('no throw when paymentMirror delegate is absent');
  t.end();
});

test('upsert failure never crashes the worker', async (t) => {
  const mirror: MirrorDelegate = {
    async upsert() {
      throw new Error('relation "PaymentMirror" does not exist');
    },
  };
  const process = createDomainEventProcessor(() => mirror, silentLog);
  await process(job(paymentCreated));
  t.pass('upsert rejection is swallowed');
  t.end();
});

test('unknown event types and malformed payloads are ignored', async (t) => {
  let calls = 0;
  const mirror: MirrorDelegate = {
    async upsert() {
      calls += 1;
    },
  };
  const process = createDomainEventProcessor(() => mirror, silentLog);
  await process(job({ type: 'payment.updated', id: 'pay_1' }));
  await process(job({ type: 'payment.created' }));
  await process(job(undefined));
  t.equal(calls, 0, 'no upsert for ignored events');
  t.end();
});
