import test from 'tape';
import type { Worker } from 'bullmq';
import { closeWorkerWithTimeout, trackActiveJob } from './worker-shutdown.js';

// Minimal EventEmitter-like mock so we don't need a real BullMQ Worker/Redis
// connection to exercise the timeout-vs-close race.
function createMockWorker(closeImpl: () => Promise<void>) {
  const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
  return {
    on(event: string, listener: (...args: unknown[]) => void) {
      (listeners[event] ??= []).push(listener);
      return this;
    },
    emit(event: string, ...args: unknown[]) {
      for (const listener of listeners[event] ?? []) listener(...args);
    },
    close: closeImpl,
  };
}

function createLogSpy() {
  const calls: { level: 'warn' | 'info'; obj: Record<string, unknown>; msg: string }[] = [];
  return {
    calls,
    warn(obj: Record<string, unknown>, msg: string) {
      calls.push({ level: 'warn', obj, msg });
    },
    info(obj: Record<string, unknown>, msg: string) {
      calls.push({ level: 'info', obj, msg });
    },
    warns() {
      return calls.filter((c) => c.level === 'warn');
    },
  };
}

test('closeWorkerWithTimeout: resolves without warning when close() finishes in time', async (t) => {
  const worker = createMockWorker(() => Promise.resolve());
  const getActiveJob = trackActiveJob(worker as unknown as Worker);
  const log = createLogSpy();

  await closeWorkerWithTimeout(worker as unknown as Worker, 'test-worker', log, getActiveJob, 50, 0);

  t.equal(log.warns().length, 0, 'no force-stop warning logged');
  t.end();
});

test('closeWorkerWithTimeout: stops waiting and logs the stuck job after the timeout', async (t) => {
  // Simulates a job that never resolves (e.g. hung on an external call) so
  // worker.close() never settles — this is the "stuck job" scenario from the
  // issue's test requirement. trackActiveJob is wired up right after worker
  // creation, mirroring production, so it sees the 'active' event that fires
  // before shutdown even starts.
  const worker = createMockWorker(() => new Promise(() => {}));
  const getActiveJob = trackActiveJob(worker as unknown as Worker);
  worker.emit('active', { id: 'job-123', data: { settlementId: 'stl-1' } });
  const log = createLogSpy();

  const start = Date.now();
  // drainBudgetMs=0 skips the drain wait deterministically so this test
  // exercises the close-phase timeout without waiting the 20 s default.
  await closeWorkerWithTimeout(worker as unknown as Worker, 'settlements', log, getActiveJob, 50, 0);
  const elapsed = Date.now() - start;

  t.ok(elapsed < 500, `resolved promptly after the timeout (took ${elapsed}ms)`);
  t.equal(log.warns().length, 2, 'logs drain-exhausted and force-stop warnings');
  t.equal(log.warns()[1].obj.jobId, 'job-123', 'logs the stuck job id');
  t.deepEqual(log.warns()[1].obj.jobData, { settlementId: 'stl-1' }, 'logs the stuck job data');
  t.equal(log.warns()[1].obj.workerName, 'settlements', 'logs the worker name');
  t.end();
});

test('closeWorkerWithTimeout: clears tracked job once it completes before the timeout', async (t) => {
  const worker = createMockWorker(() => new Promise(() => {}));
  const getActiveJob = trackActiveJob(worker as unknown as Worker);
  worker.emit('active', { id: 'job-456', data: { settlementId: 'stl-2' } });
  worker.emit('completed', { id: 'job-456' });
  const log = createLogSpy();

  await closeWorkerWithTimeout(worker as unknown as Worker, 'settlements', log, getActiveJob, 50, 0);

  t.equal(log.warns().length, 1, 'still force-stops since close() never resolved');
  t.equal(log.warns()[0].obj.jobId, undefined, 'no job reported as stuck once it completed');
  t.end();
});
