import type { Job, Worker } from 'bullmq';

export interface WorkerShutdownLogger {
  warn: (obj: Record<string, unknown>, msg: string) => void;
  info?: (obj: Record<string, unknown>, msg: string) => void;
}
export interface ActiveJobInfo { id?: string; data: unknown }
export const DEFAULT_WORKER_SHUTDOWN_TIMEOUT_MS = 10_000;
export const DEFAULT_DRAIN_POLL_INTERVAL_MS = 500;

/**
 * Snapshot of in-flight jobs. Plain `() => ActiveJobInfo | undefined` getters
 * (e.g. `() => undefined` for workers that are not tracked) are still accepted.
 */
export type ActiveJobsGetter = () => ActiveJobInfo[] | ActiveJobInfo | undefined;

/** Returned by {@link trackActiveJob}: lists every in-flight job (#1095). */
export interface ActiveJobTracker {
  (): ActiveJobInfo[];
  /** Resolves once every job in flight at call time has completed or failed. */
  settled(): Promise<void>;
}

interface TrackedJob extends ActiveJobInfo { done: Promise<void>; finish: () => void }

/**
 * Tracks every job a worker is currently processing. A Set (rather than a
 * single reference) is required for `concurrency > 1` workers: with a single
 * slot, the first job to finish cleared the reference while siblings were
 * still running, so shutdown closed the worker under them (#1095).
 */
export function trackActiveJob(worker: Worker): ActiveJobTracker {
  const active = new Set<TrackedJob>();
  worker.on('active', (job: Job) => {
    let finish!: () => void;
    const done = new Promise<void>((resolve) => { finish = resolve; });
    active.add({ id: job.id, data: job.data, done, finish });
  });
  const clear = (job?: Job) => {
    for (const tracked of active) {
      if (tracked.id === job?.id) { active.delete(tracked); tracked.finish(); return; }
    }
  };
  worker.on('completed', clear);
  worker.on('failed', clear);

  const getActiveJobs = (() => [...active].map(({ id, data }) => ({ id, data }))) as ActiveJobTracker;
  getActiveJobs.settled = async () => { await Promise.all([...active].map((tracked) => tracked.done)); };
  return getActiveJobs;
}

function listActiveJobs(getActiveJobs: ActiveJobsGetter): ActiveJobInfo[] {
  const jobs = getActiveJobs();
  if (Array.isArray(jobs)) return jobs;
  return jobs ? [jobs] : [];
}

function jobIds(jobs: ActiveJobInfo[]): Array<string | undefined> {
  return jobs.map((job) => job.id);
}

export async function drainActiveJobs(
  getActiveJobs: ActiveJobsGetter,
  log: WorkerShutdownLogger,
  workerName: string,
  budgetMs: number,
  pollIntervalMs = DEFAULT_DRAIN_POLL_INTERVAL_MS,
): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  const settled = (getActiveJobs as Partial<ActiveJobTracker>).settled;
  while (Date.now() < deadline) {
    const jobs = listActiveJobs(getActiveJobs);
    if (jobs.length === 0) { log.info?.({ workerName }, 'No active jobs — drain complete'); return true; }
    log.info?.({ workerName, jobIds: jobIds(jobs), activeCount: jobs.length, remainingMs: deadline - Date.now() }, 'Waiting for in-flight jobs to complete before closing worker');
    // Wake as soon as the tracked jobs settle instead of always sleeping a full interval.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = new Promise((resolve) => { timer = setTimeout(resolve, Math.min(pollIntervalMs, Math.max(deadline - Date.now(), 0))); });
    await Promise.race(settled ? [tick, settled()] : [tick]);
    clearTimeout(timer);
  }
  const jobs = listActiveJobs(getActiveJobs);
  if (jobs.length === 0) { log.info?.({ workerName }, 'No active jobs — drain complete'); return true; }
  log.warn({ workerName, jobIds: jobIds(jobs), jobs }, 'Drain budget exhausted with jobs still in-flight — proceeding with forced close');
  return false;
}

export async function closeWorkerWithTimeout(
  worker: Worker,
  workerName: string,
  log: WorkerShutdownLogger,
  getActiveJobs: ActiveJobsGetter,
  timeoutMs = DEFAULT_WORKER_SHUTDOWN_TIMEOUT_MS,
  drainBudgetMs = Math.max(timeoutMs * 2, 20_000),
): Promise<void> {
  await drainActiveJobs(getActiveJobs, log, workerName, drainBudgetMs);
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => { timer = setTimeout(() => { timedOut = true; resolve(); }, timeoutMs); });
  await Promise.race([worker.close(), timeout]);
  clearTimeout(timer);
  if (timedOut) {
    const jobs = listActiveJobs(getActiveJobs);
    log.warn({ workerName, jobIds: jobIds(jobs), jobs }, 'Worker did not close within shutdown timeout — force-stopping and proceeding with shutdown');
  }
}
