import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import {
  gracefulShutdown,
  registerGracefulShutdown,
  DEFAULT_SHUTDOWN_TIMEOUT_MS,
} from './shutdown.js';

function silentLogger() {
  return { info() {}, error() {}, warn() {} };
}

// `process.exit` is real during the test run, but we replace it with a spy so
// the shutdown helper can call it without terminating the test process.
let mockExit: { code: number | undefined; calls: number[] };
let originalExit: typeof process.exit;

beforeEach(() => {
  mockExit = { code: undefined, calls: [] };
  originalExit = process.exit;
  (process as unknown as { exit: (code?: number) => never }).exit = ((code?: number) => {
    mockExit.code = code ?? 0;
    mockExit.calls.push(code ?? 0);
    return undefined as never;
  }) as (code?: number) => never;
});

afterEach(() => {
  (process as unknown as { exit: typeof originalExit }).exit = originalExit;
});

test('closes resources in the canonical order (server → workers → queues → redis → prisma)', async () => {
  const order: string[] = [];
  const fastify = { close: async () => { order.push('fastify'); } };
  const worker = { close: async () => { order.push('worker'); } };
  const queue = { close: async () => { order.push('queue'); } };
  const redis = { quit: async () => { order.push('redis'); } };
  const prisma = { $disconnect: async () => { order.push('prisma'); } };

  await gracefulShutdown('SIGTERM', {
    fastify,
    prisma,
    redis,
    bullmq: { worker, queues: [queue] },
    logger: silentLogger(),
  });

  assert.deepStrictEqual(order, ['fastify', 'worker', 'queue', 'redis', 'prisma']);
  assert.strictEqual(mockExit.code, 0, 'process.exit(0) should be called on success');
});

test('closes every worker and queue when passed as arrays', async () => {
  const closed: string[] = [];
  const w1 = { close: async () => { closed.push('w1'); } };
  const w2 = { close: async () => { closed.push('w2'); } };
  const q1 = { close: async () => { closed.push('q1'); } };
  const q2 = { close: async () => { closed.push('q2'); } };
  const fastify = { close: async () => { closed.push('fastify'); } };

  await gracefulShutdown('SIGINT', {
    fastify,
    bullmq: { worker: [w1, w2], queues: [q1, q2] },
    logger: silentLogger(),
  });

  assert.deepStrictEqual(closed, ['fastify', 'w1', 'w2', 'q1', 'q2']);
  assert.strictEqual(mockExit.code, 0);
});

test('accepts a single worker / queue (non-array) value', async () => {
  const closed: string[] = [];
  const worker = { close: async () => { closed.push('worker'); } };
  const queue = { close: async () => { closed.push('queue'); } };
  const fastify = { close: async () => { closed.push('fastify'); } };

  await gracefulShutdown('SIGTERM', {
    fastify,
    bullmq: { worker, queues: queue },
    logger: silentLogger(),
  });

  assert.deepStrictEqual(closed, ['fastify', 'worker', 'queue']);
  assert.strictEqual(mockExit.code, 0);
});

test('attempts to close every resource even when one fails, then exits 1', async () => {
  const order: string[] = [];
  const fastify = { close: async () => { order.push('fastify'); } };
  const worker = {
    close: async () => {
      order.push('worker');
      throw new Error('worker boom');
    },
  };
  const queue = { close: async () => { order.push('queue'); } };
  const redis = { quit: async () => { order.push('redis'); } };
  const prisma = { $disconnect: async () => { order.push('prisma'); } };

  await gracefulShutdown('SIGTERM', {
    fastify,
    prisma,
    redis,
    bullmq: { worker, queues: [queue] },
    logger: silentLogger(),
  });

  // every resource was still given a chance to close
  assert.deepStrictEqual(order, ['fastify', 'worker', 'queue', 'redis', 'prisma']);
  assert.strictEqual(mockExit.code, 1, 'process.exit(1) should be called when a resource fails');
});

test('triggers process.exit(1) after the timeout when a close never settles', () => {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const timeoutCallbacks: { cb: () => void; ms: number }[] = [];
  (globalThis as unknown as { setTimeout: typeof setTimeout }).setTimeout = ((
    cb: () => void,
    ms: number,
  ) => {
    timeoutCallbacks.push({ cb, ms });
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  (globalThis as unknown as { clearTimeout: typeof clearTimeout }).clearTimeout = (() => {}) as typeof clearTimeout;

  const fastify = { close: () => new Promise<void>(() => { /* never settles */ }) };
  const started = gracefulShutdown('SIGTERM', { fastify, logger: silentLogger() });

  assert.strictEqual(timeoutCallbacks.length, 1, 'a force-exit timer should be registered');
  assert.strictEqual(
    timeoutCallbacks[0].ms,
    DEFAULT_SHUTDOWN_TIMEOUT_MS,
    'default timeout should be 30s',
  );

  // simulate the force-exit timer firing
  timeoutCallbacks[0].cb();
  assert.strictEqual(mockExit.code, 1, 'forced exit should use code 1');

  // restore timers and avoid an unhandled rejection from the orphaned promise
  (globalThis as unknown as { setTimeout: typeof originalSetTimeout }).setTimeout = originalSetTimeout;
  (globalThis as unknown as { clearTimeout: typeof originalClearTimeout }).clearTimeout =
    originalClearTimeout;
  started.catch(() => {});
});

test('honours a custom timeoutMs for the force-exit timer', () => {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const timeoutCallbacks: { cb: () => void; ms: number }[] = [];
  (globalThis as unknown as { setTimeout: typeof setTimeout }).setTimeout = ((
    cb: () => void,
    ms: number,
  ) => {
    timeoutCallbacks.push({ cb, ms });
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  (globalThis as unknown as { clearTimeout: typeof clearTimeout }).clearTimeout = (() => {}) as typeof clearTimeout;

  const fastify = { close: () => new Promise<void>(() => { /* never settles */ }) };
  const started = gracefulShutdown('SIGTERM', {
    fastify,
    timeoutMs: 5000,
    logger: silentLogger(),
  });

  assert.strictEqual(timeoutCallbacks[0].ms, 5000);
  timeoutCallbacks[0].cb();
  assert.strictEqual(mockExit.code, 1);

  (globalThis as unknown as { setTimeout: typeof originalSetTimeout }).setTimeout = originalSetTimeout;
  (globalThis as unknown as { clearTimeout: typeof originalClearTimeout }).clearTimeout =
    originalClearTimeout;
  started.catch(() => {});
});

test('registerGracefulShutdown registers SIGTERM/SIGINT and ignores every signal after the first', async () => {
  let closeCalls = 0;
  const fastify = { close: async () => { closeCalls += 1; } };
  const deregister = registerGracefulShutdown({ fastify, logger: silentLogger() });

  // Fire several signals of differing types; only the first must trigger a shutdown.
  process.emit('SIGTERM');
  process.emit('SIGINT');
  process.emit('SIGTERM');
  await new Promise((resolve) => setImmediate(resolve));

  assert.strictEqual(closeCalls, 1, 'only the first signal should start a shutdown');

  deregister();
});
