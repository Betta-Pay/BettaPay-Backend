import test from 'tape';
import { fastify, prisma, settlementQueue, closeTestResources } from './index.js';
import { MOCK_MERCHANT_STANDARD } from './test-fixtures.js';

// Setup environment variable for tests
process.env.NODE_ENV = 'test';

const AUTH_TOKEN = process.env.INTER_SERVICE_SECRET || 'dev-inter-service-secret';
const AUTH_HEADER = { 'x-service-token': AUTH_TOKEN };

function resetMocks() {
  prisma.merchant.findUnique = async () => null;
  prisma.$queryRaw = async () => [{ sum: null }];
  prisma.$transaction = async (cb: any) => cb(prisma);
  prisma.settlement.create = async (args: any) => args.data;
  prisma.settlement.findMany = async () => [];
  settlementQueue.add = async () => ({} as any);
  settlementQueue.addBulk = async () => [] as any;
}

test('bulk-e2e: complete successful pipeline simulation', async (t) => {
  resetMocks();

  const createdRecords: any[] = [];
  const enqueuedJobs: any[] = [];

  prisma.merchant.findUnique = async () => MOCK_MERCHANT_STANDARD as any;
  prisma.settlement.create = async (args: any) => {
    createdRecords.push(args.data);
    return args.data;
  };
  settlementQueue.addBulk = async (jobs: any[]) => {
    for (const job of jobs) enqueuedJobs.push(job.data);
    return jobs.map(() => ({ id: 'job_test_123' })) as any;
  };

  const payload = {
    merchantId: MOCK_MERCHANT_STANDARD.id,
    settlements: [
      { amount: '100.00', asset: 'USDC' },
      { amount: '200.00', asset: 'USDC' },
    ],
  };

  // 1. Post request to trigger bulk creation
  const postRes = await fastify.inject({
    method: 'POST',
    url: '/api/settlements/bulk',
    headers: AUTH_HEADER,
    payload,
  });

  t.equal(postRes.statusCode, 201, 'should return 201 Created');
  const postBody = JSON.parse(postRes.body);
  t.ok(postBody.batchId, 'should return a valid batch ID');
  t.equal(postBody.created, 2);

  // 2. Fetch tracking status immediately
  prisma.settlement.findMany = async () => {
    return createdRecords; // Mock reading the newly created records
  };

  const statusRes = await fastify.inject({
    method: 'GET',
    url: `/api/settlements/batch/${postBody.batchId}/status`,
    headers: AUTH_HEADER,
  });

  t.equal(statusRes.statusCode, 200, 'should return 200 OK');
  const statusBody = JSON.parse(statusRes.body);
  t.equal(statusBody.batchId, postBody.batchId);
  t.equal(statusBody.total, 2);
  t.equal(statusBody.pending, 2, 'all newly created bulk items should start as pending');

  t.end();
});

test('bulk-e2e: pipeline status changes after partial completions', async (t) => {
  resetMocks();

  const batchId = 'batch_e2e_partial_123';
  const settlements = [
    { id: 's1', status: 'completed', batchId },
    { id: 's2', status: 'failed', batchId },
    { id: 's3', status: 'pending', batchId },
  ];

  prisma.settlement.findMany = async (args: any) => {
    t.equal(args.where.batchId, batchId);
    return settlements as any[];
  };

  const res = await fastify.inject({
    method: 'GET',
    url: `/api/settlements/batch/${batchId}/status`,
    headers: AUTH_HEADER,
  });

  t.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  t.equal(body.data.batchId, batchId);
  t.equal(body.data.total, 3);
  t.equal(body.data.completed, 1);
  t.equal(body.data.failed, 1);
  t.equal(body.data.pending, 1);
  t.equal(body.data.status, 'processing', 'batch with mixed states should be marked as processing');

  t.end();
});
export {};

// Closes module-scope Fastify/Redis/BullMQ/Prisma handles so the tape
// process exits instead of hanging (see closeTestResources in index.ts).
test('teardown: release shared service resources', async (t) => {
  await closeTestResources();
  t.pass('resources released');
  t.end();
});
