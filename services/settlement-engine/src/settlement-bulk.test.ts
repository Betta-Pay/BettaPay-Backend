import test from 'tape';
import crypto from 'node:crypto';
import { fastify, prisma, settlementQueue, redis, closeTestResources } from './index.js';
import {
  MOCK_MERCHANT_STANDARD,
  MOCK_MERCHANT_TIGHT_LIMITS,
  BATCH_VALID_STANDARD,
  BATCH_WITH_MIN_LIMIT_VIOLATION,
  BATCH_WITH_MAX_LIMIT_VIOLATION,
  BATCH_WITH_DAILY_LIMIT_VIOLATION,
  BATCH_WITH_INVALID_AMOUNTS,
} from './test-fixtures.js';

// Setup environment variable for tests
process.env.NODE_ENV = 'test';

// Helper to reset mocks
function resetMocks() {
  prisma.merchant.findUnique = async () => null;
  prisma.$queryRaw = async () => [{ sum: null }];
  prisma.$transaction = async (cb: any) => cb(prisma);
  prisma.settlement.create = async (args: any) => args.data;
  prisma.settlement.findMany = async () => [];
  settlementQueue.add = async () => ({} as any);
  settlementQueue.addBulk = async () => [] as any;
  redis.set = async () => 'OK' as any;
  redis.get = async () => null as any;
}

const AUTH_TOKEN = process.env.INTER_SERVICE_SECRET || 'dev-inter-service-secret';
const AUTH_HEADER = { 'x-service-token': AUTH_TOKEN };

test('POST /api/settlements/bulk: rejects anonymous callers with 401 before idempotency logic', async (t) => {
  resetMocks();

  const res = await fastify.inject({
    method: 'POST',
    url: '/api/settlements/bulk',
    headers: {
      'idempotency-key': 'idem-anon-123',
    },
    payload: {
      merchantId: 'merch_1',
      settlements: [{ amount: '10.00', asset: 'USDC' }],
    },
  });

  t.equal(res.statusCode, 401, 'should return 401 Unauthorized for anonymous caller');
  const body = JSON.parse(res.body);
  t.equal(body.error.code, 'UNAUTHORIZED');
  t.end();
});

test('GET /api/settlements/batch/:batchId/status: rejects anonymous callers with 401', async (t) => {
  resetMocks();

  const res = await fastify.inject({
    method: 'GET',
    url: '/api/settlements/batch/batch_test123/status',
  });

  t.equal(res.statusCode, 401, 'should return 401 Unauthorized for anonymous caller');
  const body = JSON.parse(res.body);
  t.equal(body.error.code, 'UNAUTHORIZED');
  t.end();
});

test('POST /api/settlements/bulk: rejects batch size > 100', async (t) => {
  resetMocks();
  
  const settlements = Array.from({ length: 101 }, () => ({
    amount: '10.00',
    asset: 'USDC',
  }));

  const res = await fastify.inject({
    method: 'POST',
    url: '/api/settlements/bulk',
    headers: AUTH_HEADER,
    payload: {
      merchantId: 'merch_1',
      settlements,
    },
  });

  t.equal(res.statusCode, 400, 'should return 400 Bad Request');
  const body = JSON.parse(res.body);
  t.equal(body.error.code, 'VALIDATION_ERROR');
  t.equal(body.error.message, 'Batch size exceeds maximum limit of 100 settlements');
  t.end();
});

test('POST /api/settlements/bulk: returns 404 if merchant not found', async (t) => {
  resetMocks();

  const res = await fastify.inject({
    method: 'POST',
    url: '/api/settlements/bulk',
    headers: AUTH_HEADER,
    payload: {
      merchantId: 'merch_non_existent',
      settlements: BATCH_VALID_STANDARD,
    },
  });

  t.equal(res.statusCode, 404, 'returns 404 Not Found');
  const body = JSON.parse(res.body);
  t.equal(body.error.code, 'NOT_FOUND');
  t.end();
});

test('POST /api/settlements/bulk: processes valid batch successfully', async (t) => {
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

  const res = await fastify.inject({
    method: 'POST',
    url: '/api/settlements/bulk',
    headers: AUTH_HEADER,
    payload: {
      merchantId: MOCK_MERCHANT_STANDARD.id,
      settlements: BATCH_VALID_STANDARD,
    },
  });

  t.equal(res.statusCode, 201, 'should return 201 Created');
  const body = JSON.parse(res.body);

  t.ok(body.data.batchId.startsWith('batch_'), 'batchId should be generated');
  t.equal(body.data.total, 3, 'should report correct total count');
  t.equal(body.data.created, 3, 'should report correct created count');
  t.equal(body.data.errors.length, 0, 'should have no errors');

  t.equal(createdRecords.length, 3, 'should write 3 database records');
  t.equal(enqueuedJobs.length, 3, 'should enqueue 3 BullMQ jobs');
  t.equal(createdRecords[0].batchId, body.data.batchId, 'records should share batchId');
  t.end();
});

test('POST /api/settlements/bulk: handles partial failures (min amount violation)', async (t) => {
  resetMocks();

  const createdRecords: any[] = [];
  prisma.merchant.findUnique = async () => MOCK_MERCHANT_STANDARD as any;
  prisma.settlement.create = async (args: any) => {
    createdRecords.push(args.data);
    return args.data;
  };

  const res = await fastify.inject({
    method: 'POST',
    url: '/api/settlements/bulk',
    headers: AUTH_HEADER,
    payload: {
      merchantId: MOCK_MERCHANT_STANDARD.id,
      settlements: BATCH_WITH_MIN_LIMIT_VIOLATION,
    },
  });

  t.equal(res.statusCode, 201, 'returns 201 Created');
  const body = JSON.parse(res.body);

  t.equal(body.data.total, 3, 'total settlements is 3');
  t.equal(body.data.created, 2, 'created count is 2 due to 1 limit violation');
  t.equal(body.data.errors.length, 1, 'contains 1 error description');
  t.equal(body.data.errors[0].index, 1, 'error occurred at index 1');
  t.ok(body.data.errors[0].reason.includes('below minimum'), 'reports below minimum error');
  t.equal(createdRecords.length, 2, 'only 2 records created in DB');
  t.end();
});

test('POST /api/settlements/bulk: handles partial failures (max amount violation)', async (t) => {
  resetMocks();

  const createdRecords: any[] = [];
  prisma.merchant.findUnique = async () => MOCK_MERCHANT_STANDARD as any;
  prisma.settlement.create = async (args: any) => {
    createdRecords.push(args.data);
    return args.data;
  };

  const res = await fastify.inject({
    method: 'POST',
    url: '/api/settlements/bulk',
    headers: AUTH_HEADER,
    payload: {
      merchantId: MOCK_MERCHANT_STANDARD.id,
      settlements: BATCH_WITH_MAX_LIMIT_VIOLATION,
    },
  });

  t.equal(res.statusCode, 201, 'returns 201');
  const body = JSON.parse(res.body);

  t.equal(body.data.total, 3);
  t.equal(body.data.created, 2);
  t.equal(body.data.errors.length, 1);
  t.equal(body.data.errors[0].index, 1);
  t.ok(body.data.errors[0].reason.includes('exceeds maximum'), 'reports exceeds maximum error');
  t.end();
});

test('POST /api/settlements/bulk: handles daily limits aggregation check', async (t) => {
  resetMocks();

  prisma.merchant.findUnique = async () => MOCK_MERCHANT_STANDARD as any;
  // Current daily total is already 5000.00
  prisma.$queryRaw = async () => [{ sum: '5000.00' }];

  const res = await fastify.inject({
    method: 'POST',
    url: '/api/settlements/bulk',
    headers: AUTH_HEADER,
    payload: {
      merchantId: MOCK_MERCHANT_STANDARD.id,
      settlements: BATCH_WITH_DAILY_LIMIT_VIOLATION,
    },
  });

  t.equal(res.statusCode, 201);
  const body = JSON.parse(res.body);

  t.equal(body.data.total, 3);
  // Item 0 (4000) fits (5000+4000 <= 10000)
  // Item 1 (5000) fails (5000+4000+5000 > 10000)
  // Item 2 (2000) fails cumulative daily check (5000+4000+2000 > 10000)
  t.equal(body.data.created, 1);
  t.equal(body.data.errors.length, 2);
  t.equal(body.data.errors[0].index, 1);
  t.equal(body.data.errors[1].index, 2);
  t.ok(body.data.errors[0].reason.includes('Daily settlement limit exceeded'), 'reports daily limit exceeded');
  t.end();
});

test('POST /api/settlements/bulk: filters out invalid amount formats', async (t) => {
  resetMocks();

  prisma.merchant.findUnique = async () => MOCK_MERCHANT_STANDARD as any;

  const res = await fastify.inject({
    method: 'POST',
    url: '/api/settlements/bulk',
    headers: AUTH_HEADER,
    payload: {
      merchantId: MOCK_MERCHANT_STANDARD.id,
      settlements: BATCH_WITH_INVALID_AMOUNTS,
    },
  });

  t.equal(res.statusCode, 201);
  const body = JSON.parse(res.body);

  t.equal(body.data.total, 4);
  t.equal(body.data.created, 2); // only index 0 and 3 are valid
  t.equal(body.data.errors.length, 2);
  t.equal(body.data.errors[0].index, 1);
  t.equal(body.data.errors[1].index, 2);
  t.end();
});

test('GET /api/settlements/batch/:batchId/status: tracks progress of existing batch', async (t) => {
  resetMocks();

  prisma.settlement.findMany = async (args: any) => {
    t.equal(args.where.batchId, 'batch_test123');
    return [
      { id: 's1', status: 'completed' },
      { id: 's2', status: 'completed' },
      { id: 's3', status: 'pending' },
      { id: 's4', status: 'failed' },
    ] as any[];
  };

  const res = await fastify.inject({
    method: 'GET',
    url: '/api/settlements/batch/batch_test123/status',
    headers: AUTH_HEADER,
  });

  t.equal(res.statusCode, 200, 'returns 200 OK');
  const body = JSON.parse(res.body);

  t.equal(body.data.batchId, 'batch_test123');
  t.equal(body.data.total, 4);
  t.equal(body.data.completed, 2);
  t.equal(body.data.pending, 1);
  t.equal(body.data.failed, 1);
  t.equal(body.data.status, 'processing');
  t.end();
});

test('GET /api/settlements/batch/:batchId/status: returns 404 for unknown batch', async (t) => {
  resetMocks();

  prisma.settlement.findMany = async () => [];

  const res = await fastify.inject({
    method: 'GET',
    url: '/api/settlements/batch/batch_unknown/status',
    headers: AUTH_HEADER,
  });

  t.equal(res.statusCode, 404, 'returns 404 Not Found');
  t.end();
});

test('POST /api/settlements/bulk: idempotency successfully returns cached response', async (t) => {
  resetMocks();

  const cachedResponse = {
    data: {
      batchId: 'batch_cached123',
      total: 3,
      created: 3,
      errors: []
    }
  };

  const payload = {
    merchantId: MOCK_MERCHANT_STANDARD.id,
    settlements: BATCH_VALID_STANDARD,
  };

  const payloadHash = crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');

  // Simulate that the key is already claimed, and the hash matches
  redis.set = async () => null as any; // NX fails
  redis.get = async (key: string) => {
    if (key.includes('bulk_res')) return JSON.stringify(cachedResponse) as any;
    return payloadHash as any; // The hashes match
  };

  const res = await fastify.inject({
    method: 'POST',
    url: '/api/settlements/bulk',
    headers: {
      ...AUTH_HEADER,
      'idempotency-key': 'idem-key-123'
    },
    payload,
  });

  t.equal(res.statusCode, 200, 'returns 200 OK');
  const body = JSON.parse(res.body);
  t.equal(body.data.batchId, 'batch_cached123', 'returns cached batchId');
  t.end();
});

test('POST /api/settlements/bulk: rejects same idempotency key with different payload', async (t) => {
  resetMocks();

  const payload = {
    merchantId: MOCK_MERCHANT_STANDARD.id,
    settlements: BATCH_VALID_STANDARD,
  };

  // Simulate that the key is already claimed, but the stored hash is different
  redis.set = async () => null as any; // NX fails
  redis.get = async (key: string) => {
    if (key.includes('bulk_res')) return null as any;
    return 'different-hash' as any; // Hashes mismatch
  };

  const res = await fastify.inject({
    method: 'POST',
    url: '/api/settlements/bulk',
    headers: {
      ...AUTH_HEADER,
      'idempotency-key': 'idem-key-456'
    },
    payload,
  });

  t.equal(res.statusCode, 409, 'returns 409 Conflict');
  const body = JSON.parse(res.body);
  t.equal(body.error.code, 'IDEMPOTENCY_PAYLOAD_MISMATCH');
  t.ok(body.error.message.includes('different payload'), 'error message indicates payload mismatch');
  t.end();
});

// Closes module-scope Fastify/Redis/BullMQ/Prisma handles so the tape
// process exits instead of hanging (see closeTestResources in index.ts).
test('teardown: release shared service resources', async (t) => {
  await closeTestResources();
  t.pass('resources released');
  t.end();
});
