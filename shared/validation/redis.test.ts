import test from 'node:test';
import assert from 'node:assert';
import { Queue, Worker } from 'bullmq';
import {
  createRedisClient,
  getSharedRedisClient,
  clearSharedRedisClients,
} from './redis.js';

const TEST_REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';

const dummyLogger = {
  warn: () => {},
  info: () => {},
  error: () => {},
};

test('createRedisClient creates Redis client with offline queue disabled by default', (t) => {
  const client = createRedisClient(TEST_REDIS_URL, dummyLogger);
  assert.ok(client);
  assert.strictEqual(client.options.enableOfflineQueue, false);
  assert.strictEqual(client.options.maxRetriesPerRequest, null);
  client.disconnect();
});

test('createRedisClient respects lifecycle hooks options', (t) => {
  let connectCalled = false;
  let closeCalled = false;

  const client = createRedisClient({
    url: TEST_REDIS_URL,
    logger: dummyLogger,
    onConnect: () => {
      connectCalled = true;
    },
    onClose: () => {
      closeCalled = true;
    },
  });

  assert.ok(client);
  // Trigger event listeners
  client.emit('connect');
  client.emit('close');

  assert.strictEqual(connectCalled, true);
  assert.strictEqual(closeCalled, true);

  client.disconnect();
});

test('getSharedRedisClient returns the same connection instance for identical URL', async (t) => {
  const client1 = getSharedRedisClient(TEST_REDIS_URL, dummyLogger);
  const client2 = getSharedRedisClient(TEST_REDIS_URL, dummyLogger);

  assert.strictEqual(client1, client2);

  const client3 = createRedisClient(TEST_REDIS_URL, dummyLogger, { shared: true });
  assert.strictEqual(client1, client3);

  await clearSharedRedisClients();
});

test('connection reuse across BullMQ Queue, Worker, and direct Redis usage', async (t) => {
  const sharedClient = getSharedRedisClient(TEST_REDIS_URL, dummyLogger);

  // Verify BullMQ Queue & Worker accept shared ioredis client (requires maxRetriesPerRequest: null)
  const testQueueName = 'test-connection-sharing-queue';
  const queue = new Queue(testQueueName, { connection: sharedClient });
  const worker = new Worker(testQueueName, async () => {}, { connection: sharedClient });

  assert.ok(queue);
  assert.ok(worker);
  assert.strictEqual(queue.opts.connection, sharedClient);

  await worker.close();
  await queue.close();
  await clearSharedRedisClients();
});
