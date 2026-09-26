import test from 'tape';
import crypto from 'crypto';
import sinon from 'sinon';
import { createTestApp, generateTestJwt } from './test-utils.js';
import { MOCK_MERCHANT_ACTIVE } from './test-fixtures.js';

const MERCHANT_ID = MOCK_MERCHANT_ACTIVE.id;

test('POST /api/payments emits domain event on payment creation', async (t) => {
  const addStub = sinon.stub().resolves();
  const mockQueue = {
    add: addStub,
    close: sinon.stub().resolves(),
  };

  const { app, mockPrisma } = await createTestApp(
    { domainEventsQueue: mockQueue as any },
    { merchants: [{ ...MOCK_MERCHANT_ACTIVE }] },
  );
  const token = generateTestJwt(app);
  const testTraceId = 'trace-' + crypto.randomUUID();

  const res = await app.inject({
    method: 'POST',
    url: '/api/payments',
    headers: {
      authorization: `Bearer ${token}`,
      origin: 'http://localhost:3000',
      'x-trace-id': testTraceId,
    },
    payload: { merchantId: MERCHANT_ID, amount: '25.00', asset: 'USDC' },
  });

  t.equal(res.statusCode, 201, 'returns 201');
  const body = JSON.parse(res.body);
  t.ok(body.data?.id, 'payment has an id');
  t.equal(body.data?.status, 'initiated', 'status is initiated');

  t.equal(addStub.callCount, 1, 'domainEvents.add called once');
  const [eventName, eventData, eventOpts] = addStub.firstCall.args;
  t.equal(eventName, 'payment.created', 'event name is payment.created');
  t.equal(eventData.type, 'payment.created', 'event type is payment.created');
  t.equal(eventData.id, body.data.id, 'event id matches payment id');
  t.equal(eventData.merchantId, MERCHANT_ID, 'event merchantId matches');
  t.equal(eventData.amount, '25.00', 'event amount matches');
  t.equal(eventData.asset, 'USDC', 'event asset matches');
  t.equal(eventData.traceId, testTraceId, 'event carries traceId from request');
  t.ok(eventData.occurredAt, 'event carries occurredAt timestamp');
  t.deepEqual(eventOpts, { removeOnComplete: 10_000 }, 'removeOnComplete option is 10,000');

  const stored = await mockPrisma.payment.findUnique({ where: { id: body.data.id } });
  t.ok(stored, 'persisted in database');

  await app.close();
  t.end();
});

test('POST /api/payments best-effort emit — failure to emit does not fail 201', async (t) => {
  const addStub = sinon.stub().rejects(new Error('Redis connection failed'));
  const mockQueue = {
    add: addStub,
    close: sinon.stub().resolves(),
  };

  const { app, mockPrisma } = await createTestApp(
    { domainEventsQueue: mockQueue as any },
    { merchants: [{ ...MOCK_MERCHANT_ACTIVE }] },
  );
  const token = generateTestJwt(app);

  const res = await app.inject({
    method: 'POST',
    url: '/api/payments',
    headers: {
      authorization: `Bearer ${token}`,
      origin: 'http://localhost:3000',
    },
    payload: { merchantId: MERCHANT_ID, amount: '50.00', asset: 'USDC' },
  });

  t.equal(res.statusCode, 201, 'returns 201 despite emit failure');
  const body = JSON.parse(res.body);
  t.ok(body.data?.id, 'payment id returned');
  t.equal(body.data?.amount, '50.00', 'amount matches');

  t.equal(addStub.callCount, 1, 'domainEvents.add was attempted');

  const stored = await mockPrisma.payment.findUnique({ where: { id: body.data.id } });
  t.ok(stored, 'payment was committed to database');

  await app.close();
  t.end();
});
