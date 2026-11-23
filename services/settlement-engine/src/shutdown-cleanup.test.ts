import test from 'tape';
import { createShutdownCleanup } from './shutdown-cleanup.js';

const silentLog = { info: () => undefined, error: () => undefined };

const tick = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

test('shutdown: awaits the in-flight reaper before closing workers, queues and Redis', async (t) => {
  const events: string[] = [];
  let reaperTickFinished = false;

  const cleanup = createShutdownCleanup({
    stopReapers: [
      async () => {
        events.push('reaper:stop-called');
        await tick(30); // simulates an in-flight reaper tick still running
        reaperTickFinished = true;
        events.push('reaper:tick-finished');
      },
    ],
    closeWorkers: [
      async () => {
        t.ok(reaperTickFinished, 'worker close starts only after the reaper tick finished');
        events.push('worker:closed');
      },
    ],
    closeQueues: [
      async () => {
        events.push('queue:closed');
      },
    ],
    redis: {
      quit: async () => {
        events.push('redis:quit');
      },
      disconnect: () => events.push('redis:disconnect'),
    },
    log: silentLog,
  });

  await cleanup();

  t.deepEqual(
    events,
    ['reaper:stop-called', 'reaper:tick-finished', 'worker:closed', 'queue:closed', 'redis:quit'],
    'cleanup runs in order: reaper -> workers -> queues -> redis',
  );
  t.end();
});

test('shutdown: closes every worker, queue and reaper it is given', async (t) => {
  const closed: string[] = [];
  const cleanup = createShutdownCleanup({
    stopReapers: [() => void closed.push('reaper-a'), async () => void closed.push('reaper-b')],
    closeWorkers: [async () => closed.push('w1'), async () => closed.push('w2')],
    closeQueues: [async () => closed.push('q1'), async () => closed.push('q2')],
    redis: { quit: async () => closed.push('redis'), disconnect: () => undefined },
    log: silentLog,
  });

  await cleanup();
  t.deepEqual(closed, ['reaper-a', 'reaper-b', 'w1', 'w2', 'q1', 'q2', 'redis']);
  t.end();
});

test('shutdown: a failing step is logged and does not skip later steps', async (t) => {
  const errors: string[] = [];
  const closed: string[] = [];
  const cleanup = createShutdownCleanup({
    stopReapers: [
      async () => {
        throw new Error('reaper boom');
      },
    ],
    closeWorkers: [
      async () => {
        throw new Error('worker boom');
      },
      async () => closed.push('worker-2'),
    ],
    closeQueues: [async () => closed.push('queue')],
    redis: { quit: async () => closed.push('redis'), disconnect: () => undefined },
    log: { info: () => undefined, error: (obj) => errors.push(String(obj.step)) },
  });

  await cleanup();
  t.deepEqual(errors, ['reaper', 'worker'], 'failures are logged with their step');
  t.deepEqual(closed, ['worker-2', 'queue', 'redis'], 'remaining steps still run');
  t.end();
});

test('shutdown: forces a Redis disconnect when graceful QUIT fails', async (t) => {
  let disconnected = false;
  const cleanup = createShutdownCleanup({
    stopReapers: [],
    closeWorkers: [],
    closeQueues: [],
    redis: {
      quit: async () => {
        throw new Error('Connection is closed');
      },
      disconnect: () => {
        disconnected = true;
      },
    },
    log: silentLog,
  });

  await cleanup();
  t.ok(disconnected, 'redis.disconnect() is called as a fallback');
  t.end();
});

test('shutdown: is idempotent — concurrent callers share a single cleanup run', async (t) => {
  let quits = 0;
  let reaperStops = 0;
  const cleanup = createShutdownCleanup({
    stopReapers: [
      async () => {
        reaperStops += 1;
        await tick(10);
      },
    ],
    closeWorkers: [],
    closeQueues: [],
    redis: {
      quit: async () => {
        quits += 1;
      },
      disconnect: () => undefined,
    },
    log: silentLog,
  });

  await Promise.all([cleanup(), cleanup()]);
  await cleanup();

  t.equal(reaperStops, 1, 'reaper is stopped once');
  t.equal(quits, 1, 'redis is quit once');
  t.end();
});
