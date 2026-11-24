/**
 * Ordered, awaited shutdown of the settlement-engine's background resources.
 *
 * Sequence:
 *   1. Stop the settlement reaper(s) and await any in-flight tick, so the
 *      reaper never touches the DB / queue after they are closed.
 *   2. Close BullMQ workers (drains in-flight jobs).
 *   3. Close BullMQ queues.
 *   4. Close the shared Redis connection (falls back to a hard disconnect if
 *      a graceful QUIT fails so the process cannot hang on an open socket).
 *
 * A failure in one step is logged and never prevents later steps from
 * running. The returned function is idempotent: every caller (the Fastify
 * `onClose` hook and the signal-driven graceful shutdown) shares one run.
 */

export interface ShutdownCleanupLogger {
  info: (obj: Record<string, unknown>, msg: string) => void;
  error: (obj: Record<string, unknown>, msg: string) => void;
}

export interface ShutdownCleanupDeps {
  /** Reaper stop functions. Each may return a promise that settles once the in-flight tick is done. */
  stopReapers: Array<() => void | Promise<void>>;
  closeWorkers: Array<() => Promise<unknown>>;
  closeQueues: Array<() => Promise<unknown>>;
  redis: {
    quit: () => Promise<unknown>;
    disconnect: () => void;
  };
  log: ShutdownCleanupLogger;
}

export function createShutdownCleanup(deps: ShutdownCleanupDeps): () => Promise<void> {
  const { stopReapers, closeWorkers, closeQueues, redis, log } = deps;
  let running: Promise<void> | undefined;

  const runStep = async (name: string, fn: () => unknown): Promise<void> => {
    try {
      await fn();
    } catch (err) {
      log.error({ err, step: name }, 'Shutdown step failed — continuing');
    }
  };

  const run = async (): Promise<void> => {
    for (const stop of stopReapers) await runStep('reaper', stop);
    log.info({}, 'Settlement reaper stopped');

    for (const close of closeWorkers) await runStep('worker', close);
    log.info({}, 'BullMQ workers closed');

    for (const close of closeQueues) await runStep('queue', close);
    log.info({}, 'BullMQ queues closed');

    try {
      await redis.quit();
    } catch (err) {
      log.error({ err, step: 'redis' }, 'Redis QUIT failed — forcing disconnect');
      redis.disconnect();
    }
    log.info({}, 'Redis connection closed');
  };

  return () => (running ??= run());
}
