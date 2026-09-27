import type { Job, Worker } from 'bullmq';

export interface WorkerShutdownLogger {
  warn: (obj: Record<string, unknown>, msg: string) => void;
  info: (obj: Record<string, unknown>, msg: string) => void;
}

export interface ActiveJobInfo {
  id?: string;
  data: unknown;
}

export const DEFAULT_WORKER_SHUTDOWN_TIMEOUT_MS = 10_000;
export const DEFAULT_DRAIN_POLL_INTERVAL_MS = 500;

/**
 * Starts tracking the worker's currently-active job so shutdown can report it if the
 * worker gets stuck. Must be called once, right after the worker is created — a job
 * that became active before shutdown began would otherwise be invisible to
 * closeWorkerWithTimeout, since BullMQ only fires 'active' when a job starts.
 */
export function trackActiveJob(worker: Worker): () => ActiveJobInfo | undefined {
  let activeJob: ActiveJobInfo | undefined;

  worker.on('active', (job: Job) => {
    activeJob = { id: job.id, data: job.data };
  });
  worker.on('completed', () => {
    activeJob = undefined;
  });
  worker.on('failed', () => {
    activeJob = undefined;
  });

  return () => activeJob;
}

/**
 * Drains in-flight jobs by polling for an active job and waiting up to `budgetMs`
 * total for it to complete.  Returns true if drain succeeded (no active job), or
 * false if the budget expired while a job was still running.
 */
export async function drainActiveJobs(
  getActiveJob: () => ActiveJobInfo | undefined,
  log: WorkerShutdownLogger,
  workerName: string,
  budgetMs: number,
  pollIntervalMs: number = DEFAULT_DRAIN_POLL_INTERVAL_MS,
): Promise<boolean> {
  const deadline = Date.now() + budgetMs;

  while (Date.now() < deadline) {
    const activeJob = getActiveJob();
    if (!activeJob) {
      log.info({ workerName }, 'No active jobs — drain complete');
      return true;
    }

    log.info(
      { workerName, jobId: activeJob.id, remainingMs: deadline - Date.now() },
      'Waiting for in-flight job to complete before closing worker',
    );

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  const stuckJob = getActiveJob();
  if (!stuckJob) {
    // The job finished between the last poll and the deadline — the drain
    // still succeeded, so report completion instead of a false exhaustion.
    log.info({ workerName }, 'No active jobs — drain complete');
    return true;
  }
  log.warn(
    { workerName, jobId: stuckJob?.id, jobData: stuckJob?.data },
    'Drain budget exhausted with job still in-flight — proceeding with forced close',
  );
  return false;
}

/**
 * Closes a BullMQ worker with drain-then-close semantics and a timeout budget.
 *
 * Sequence:
 *   1. Drain phase — poll for in-flight jobs within a budget so mid-delivery
 *      webhooks can finish rather than being aborted mid-flight.
 *   2. Close phase — call worker.close() which stops polling and lets the
 *      active job (if any) finish.
 *   3. If the close hangs beyond the timeout, log the stuck job and proceed.
 *
 * The total time spent is bounded by drainBudgetMs + timeoutMs so shutdown
 * never hangs indefinitely.
 */
export async function closeWorkerWithTimeout(
  worker: Worker,
  workerName: string,
  log: WorkerShutdownLogger,
  getActiveJob: () => ActiveJobInfo | undefined,
  timeoutMs: number = DEFAULT_WORKER_SHUTDOWN_TIMEOUT_MS,
  drainBudgetMs: number = Math.max(timeoutMs * 2, 20_000),
): Promise<void> {
  // Phase 1: Wait for in-flight jobs to complete within the drain budget
  await drainActiveJobs(getActiveJob, log, workerName, drainBudgetMs);

  // Phase 2: Close the worker (stop polling, wait for any remaining active job)
  let timedOut = false;
  const timeout = new Promise<void>((resolve) => {
    setTimeout(() => {
      timedOut = true;
      resolve();
    }, timeoutMs);
  });

  await Promise.race([worker.close(), timeout]);

  if (timedOut) {
    const activeJob = getActiveJob();
    log.warn(
      { workerName, jobId: activeJob?.id, jobData: activeJob?.data },
      'Worker did not close within shutdown timeout — force-stopping and proceeding with shutdown',
    );
  }
}
