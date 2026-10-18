import type { Job, Worker } from 'bullmq';

export interface WorkerShutdownLogger {
  warn: (obj: Record<string, unknown>, msg: string) => void;
  info?: (obj: Record<string, unknown>, msg: string) => void;
}
export interface ActiveJobInfo { id?: string; data: unknown }
export const DEFAULT_WORKER_SHUTDOWN_TIMEOUT_MS = 10_000;
export const DEFAULT_DRAIN_POLL_INTERVAL_MS = 500;

export function trackActiveJob(worker: Worker): () => ActiveJobInfo | undefined {
  let active: ActiveJobInfo | undefined;
  worker.on('active', (job: Job) => { active = { id: job.id, data: job.data }; });
  const clear = () => { active = undefined; };
  worker.on('completed', clear);
  worker.on('failed', clear);
  return () => active;
}

export async function drainActiveJobs(
  getActiveJob: () => ActiveJobInfo | undefined,
  log: WorkerShutdownLogger,
  workerName: string,
  budgetMs: number,
  pollIntervalMs = DEFAULT_DRAIN_POLL_INTERVAL_MS,
): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    const job = getActiveJob();
    if (!job) { log.info?.({ workerName }, 'No active jobs — drain complete'); return true; }
    log.info?.({ workerName, jobId: job.id, remainingMs: deadline - Date.now() }, 'Waiting for in-flight job to complete before closing worker');
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  const job = getActiveJob();
  if (!job) { log.info?.({ workerName }, 'No active jobs — drain complete'); return true; }
  log.warn({ workerName, jobId: job.id, jobData: job.data }, 'Drain budget exhausted with job still in-flight — proceeding with forced close');
  return false;
}

export async function closeWorkerWithTimeout(
  worker: Worker,
  workerName: string,
  log: WorkerShutdownLogger,
  getActiveJob: () => ActiveJobInfo | undefined,
  timeoutMs = DEFAULT_WORKER_SHUTDOWN_TIMEOUT_MS,
  drainBudgetMs = Math.max(timeoutMs * 2, 20_000),
): Promise<void> {
  await drainActiveJobs(getActiveJob, log, workerName, drainBudgetMs);
  let timedOut = false;
  const timeout = new Promise<void>((resolve) => setTimeout(() => { timedOut = true; resolve(); }, timeoutMs));
  await Promise.race([worker.close(), timeout]);
  if (timedOut) log.warn({ workerName, jobId: getActiveJob()?.id, jobData: getActiveJob()?.data }, 'Worker did not close within shutdown timeout — force-stopping and proceeding with shutdown');
}
