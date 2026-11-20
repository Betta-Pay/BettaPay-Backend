/**
 * Unit tests for @bettapay/worker-shutdown (#1095): concurrent job tracking,
 * drain-before-close, and the close timeout.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { Worker } from 'bullmq';
import { closeWorkerWithTimeout, drainActiveJobs, trackActiveJob } from './index.js';

// Minimal EventEmitter-like mock so we don't need a real BullMQ Worker/Redis connection.
function createMockWorker(closeImpl: () => Promise<void> = () => Promise.resolve()) {
  const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
  let closed = false;
  const worker = {
    on(event: string, listener: (...args: unknown[]) => void) {
      (listeners[event] ??= []).push(listener);
      return worker;
    },
    emit(event: string, ...args: unknown[]) {
      for (const listener of listeners[event] ?? []) listener(...args);
    },
    async close() {
      await closeImpl();
      closed = true;
    },
    get closed() {
      return closed;
    },
  };
  return worker;
}

function createLogSpy() {
  const warns: { obj: Record<string, unknown>; msg: string }[] = [];
  const infos: { obj: Record<string, unknown>; msg: string }[] = [];
  return {
    warns,
    infos,
    warn(obj: Record<string, unknown>, msg: string) {
      warns.push({ obj, msg });
    },
    info(obj: Record<string, unknown>, msg: string) {
      infos.push({ obj, msg });
    },
  };
}

const job = (id: string) => ({ id, data: { id } });
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('trackActiveJob: tracks every concurrently active job', () => {
  const worker = createMockWorker();
  const getActiveJobs = trackActiveJob(worker as unknown as Worker);

  worker.emit('active', job('a'));
  worker.emit('active', job('b'));
  worker.emit('active', job('c'));
  assert.deepEqual(getActiveJobs().map((j) => j.id), ['a', 'b', 'c']);

  worker.emit('completed', job('b'));
  assert.deepEqual(getActiveJobs().map((j) => j.id), ['a', 'c'], 'one completion does not clear its siblings');

  worker.emit('failed', job('a'), new Error('boom'));
  worker.emit('completed', job('c'));
  assert.deepEqual(getActiveJobs(), []);
});

test('trackActiveJob: ignores completion events for jobs it never saw', () => {
  const worker = createMockWorker();
  const getActiveJobs = trackActiveJob(worker as unknown as Worker);

  worker.emit('active', job('a'));
  worker.emit('completed', job('zzz'));
  worker.emit('failed', undefined, new Error('job lost'));
  assert.deepEqual(getActiveJobs(), [{ id: 'a', data: { id: 'a' } }]);
});

test('trackActiveJob: settled() resolves only after every in-flight job finishes', async () => {
  const worker = createMockWorker();
  const getActiveJobs = trackActiveJob(worker as unknown as Worker);
  worker.emit('active', job('a'));
  worker.emit('active', job('b'));

  let settled = false;
  const done = getActiveJobs.settled().then(() => { settled = true; });

  worker.emit('completed', job('a'));
  await delay(5);
  assert.equal(settled, false, 'still waiting on b');

  worker.emit('failed', job('b'), new Error('boom'));
  await done;
  assert.equal(settled, true);
});

test('closeWorkerWithTimeout: awaits all concurrent jobs before closing the worker', async () => {
  const worker = createMockWorker();
  const getActiveJobs = trackActiveJob(worker as unknown as Worker);
  const log = createLogSpy();

  worker.emit('active', job('a'));
  worker.emit('active', job('b'));
  worker.emit('active', job('c'));

  const finishedBeforeClose: string[] = [];
  const finish = (id: string, ms: number) =>
    setTimeout(() => {
      assert.equal(worker.closed, false, `worker must not close before job ${id} finishes`);
      finishedBeforeClose.push(id);
      worker.emit('completed', job(id));
    }, ms);
  finish('a', 10);
  finish('b', 30);
  finish('c', 60);

  await closeWorkerWithTimeout(worker as unknown as Worker, 'settlements', log, getActiveJobs, 500, 1_000);

  assert.deepEqual(finishedBeforeClose, ['a', 'b', 'c']);
  assert.equal(worker.closed, true);
  assert.equal(log.warns.length, 0, 'no drain or close warnings');
  assert.ok(log.infos.some((c) => c.msg === 'No active jobs — drain complete'));
});

test('drainActiveJobs: wakes as soon as tracked jobs settle instead of waiting a full poll interval', async () => {
  const worker = createMockWorker();
  const getActiveJobs = trackActiveJob(worker as unknown as Worker);
  worker.emit('active', job('a'));
  worker.emit('active', job('b'));
  setTimeout(() => worker.emit('completed', job('a')), 5);
  setTimeout(() => worker.emit('completed', job('b')), 10);

  const started = Date.now();
  const drained = await drainActiveJobs(getActiveJobs, createLogSpy(), 'w', 5_000, 2_000);
  assert.equal(drained, true);
  assert.ok(Date.now() - started < 1_000, 'did not sleep the 2s poll interval');
});

test('drainActiveJobs: reports every job still in flight when the budget expires', async () => {
  const worker = createMockWorker();
  const getActiveJobs = trackActiveJob(worker as unknown as Worker);
  const log = createLogSpy();
  worker.emit('active', job('a'));
  worker.emit('active', job('b'));
  worker.emit('completed', job('a'));
  worker.emit('active', job('c'));

  const drained = await drainActiveJobs(getActiveJobs, log, 'settlements', 30, 10);

  assert.equal(drained, false);
  assert.equal(log.warns.length, 1);
  assert.deepEqual(log.warns[0].obj.jobIds, ['b', 'c']);
  assert.equal(log.warns[0].obj.workerName, 'settlements');
});

test('closeWorkerWithTimeout: stops waiting and logs stuck jobs once close() exceeds the timeout', async () => {
  const worker = createMockWorker(() => new Promise(() => {}));
  const getActiveJobs = trackActiveJob(worker as unknown as Worker);
  const log = createLogSpy();
  worker.emit('active', job('stuck-1'));
  worker.emit('active', job('stuck-2'));

  const started = Date.now();
  await closeWorkerWithTimeout(worker as unknown as Worker, 'settlements', log, getActiveJobs, 50, 20);
  const elapsed = Date.now() - started;

  assert.ok(elapsed < 1_000, `resolved after the timeout, not hung (${elapsed}ms)`);
  const closeWarn = log.warns.find((c) => c.msg.includes('did not close within shutdown timeout'));
  assert.ok(closeWarn, 'force-stop warning logged');
  assert.deepEqual(closeWarn.obj.jobIds, ['stuck-1', 'stuck-2']);
});

test('closeWorkerWithTimeout: resolves without warnings when idle and close() is fast', async () => {
  const worker = createMockWorker();
  const getActiveJobs = trackActiveJob(worker as unknown as Worker);
  const log = createLogSpy();

  await closeWorkerWithTimeout(worker as unknown as Worker, 'idle', log, getActiveJobs, 50, 0);

  assert.equal(worker.closed, true);
  assert.equal(log.warns.length, 0);
});

test('closeWorkerWithTimeout: still accepts a legacy single-job getter', async () => {
  const worker = createMockWorker();
  const log = createLogSpy();

  await closeWorkerWithTimeout(worker as unknown as Worker, 'untracked', log, () => undefined, 50, 0);
  assert.equal(worker.closed, true);

  const stuck = createMockWorker(() => new Promise(() => {}));
  await closeWorkerWithTimeout(stuck as unknown as Worker, 'legacy', log, () => ({ id: 'x', data: {} }), 20, 10);
  assert.deepEqual(log.warns.at(-1)?.obj.jobIds, ['x']);
});
