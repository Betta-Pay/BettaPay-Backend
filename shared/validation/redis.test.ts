import test from 'node:test';
import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import type { RedisOptions } from 'ioredis';
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

class FakeRedis extends EventEmitter {
  readonly options: RedisOptions;
  quitCalls = 0;
  disconnectCalls = 0;

  constructor(options: RedisOptions) {
    super();
    this.options = options;
  }

  async quit(): Promise<'OK'> {
    this.quitCalls++;
    return 'OK';
  }

  disconnect(): void {
    this.disconnectCalls++;
  }
}

function fakeRedisFactory(created: FakeRedis[]) {
  return (_url: string, options: RedisOptions) => {
    const client = new FakeRedis(options);
    created.push(client);
    return client as never;
  };
}

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

test('createRedisClient exposes capped exponential retry backoff and health lifecycle state', () => {
  const created: FakeRedis[] = [];
  const healthState = { connected: false, errors: 0, reconnects: 0 };
  const events = { connect: 0, error: 0, close: 0, reconnect: 0 };
  createRedisClient({
    url: 'redis://fake',
    maxDelayMs: 500,
    healthState,
    redisFactory: fakeRedisFactory(created),
    onConnect: () => events.connect++,
    onError: () => events.error++,
    onClose: () => events.close++,
    onReconnect: () => events.reconnect++,
  });
  const fake = created[0];
  const retryStrategy = fake.options.retryStrategy as (attempt: number) => number;
  const delays = [1, 2, 3, 4, 5].map(retryStrategy);

  assert.deepEqual(delays, [200, 400, 500, 500, 500]);
  assert.ok(delays.every((delay, index) => index === 0 || delay >= delays[index - 1]));

  fake.emit('connect');
  fake.emit('reconnecting');
  fake.emit('reconnecting');
  const error = new Error('connection refused');
  fake.emit('error', error);
  fake.emit('close');

  assert.equal(healthState.connected, false);
  assert.equal(healthState.errors, 1);
  assert.equal(healthState.reconnects, 2);
  assert.equal(healthState.lastError, error.message);
  assert.deepEqual(events, { connect: 1, error: 1, close: 1, reconnect: 2 });
});

test('clearSharedRedisClients quits every injected shared client', async () => {
  const created: FakeRedis[] = [];
  const factory = fakeRedisFactory(created);
  const first = getSharedRedisClient('redis://one', dummyLogger, { redisFactory: factory });
  const same = getSharedRedisClient('redis://one', dummyLogger, { redisFactory: factory });
  const second = getSharedRedisClient('redis://two', dummyLogger, { redisFactory: factory });

  assert.equal(first, same);
  assert.notEqual(first, second);
  await clearSharedRedisClients();
  assert.deepEqual(created.map((client) => client.quitCalls), [1, 1]);
});
