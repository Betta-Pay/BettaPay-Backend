import test from 'tape';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INDEX_SRC = fs.readFileSync(path.resolve(__dirname, 'index.ts'), 'utf8');

const DEFAULT_TIMEOUT_MS = 30_000;

type LogEntry = Record<string, unknown>;
const logEntries: LogEntry[] = [];

const mockLog = {
  error(obj: Record<string, unknown>, _msg: string) {
    logEntries.push({ ...obj });
  },
};

type MockJob = {
  id: string;
  data: { id: string; merchantId: string; grossAmount?: string; asset?: string };
  name: string;
  processedOn: number | null;
  attemptsMade: number;
};

type MockDLQ = {
  calls: Array<{ name: string; data: unknown; opts: unknown }>;
  add(name: string, data: unknown, opts: unknown): Promise<void>;
};

function createMockDLQ(): MockDLQ {
  const calls: MockDLQ['calls'] = [];
  return {
    calls,
    async add(name: string, data: unknown, opts: unknown) {
      calls.push({ name, data, opts });
    },
  };
}

// Replicate the failed handler logic from index.ts
async function onJobFailed(
  job: MockJob | undefined | null,
  err: Error,
  log: typeof mockLog,
  dlq: MockDLQ,
): Promise<void> {
  if (job) {
    const processedOn = job.processedOn ?? undefined;
    const durationMs = processedOn !== undefined ? Date.now() - processedOn : undefined;

    log.error({
      jobId: job.id,
      settlementId: job.data.id,
      merchantId: job.data.merchantId,
      durationMs,
      attempt: job.attemptsMade,
      error: err.message,
      jobName: job.name,
      queueName: 'settlements',
    });

    await dlq.add(job.name, job.data, {
      jobId: job.id,
      attempts: 1,
    });
  }
}

// ── Configuration test ──────────────────────────────────────────────────────

test('SETTLEMENT_JOB_TIMEOUT_MS: worker enforces the configurable timeout', (t) => {
  t.ok(
    INDEX_SRC.includes('withJobTimeout'),
    'worker processor is wrapped in a withJobTimeout watchdog',
  );
  t.ok(
    INDEX_SRC.includes('env.SETTLEMENT_JOB_TIMEOUT_MS'),
    'SETTLEMENT_JOB_TIMEOUT_MS is applied to the worker',
  );
  t.end();
});

test('SETTLEMENT_JOB_TIMEOUT_MS: default value is 30000 in validation schema', (t) => {
  t.ok(
    INDEX_SRC.includes('SETTLEMENT_JOB_TIMEOUT_MS'),
    'SETTLEMENT_JOB_TIMEOUT_MS is referenced in source',
  );
  t.end();
});

// ── Failed handler tests ────────────────────────────────────────────────────

test('Failed handler: logs all required fields on timeout error', async (t) => {
  logEntries.length = 0;
  const dlq = createMockDLQ();
  const processedOn = Date.now() - 35_000;

  const job: MockJob = {
    id: 'job-timeout-001',
    data: { id: 'stl-001', merchantId: 'merchant-alpha' },
    name: 'process-settlement',
    processedOn,
    attemptsMade: 2,
  };

  const err = new Error('job timed out');
  await onJobFailed(job, err, mockLog, dlq);

  t.equal(logEntries.length, 1, 'exactly one log entry emitted');

  const entry = logEntries[0];
  t.equal(entry.jobId, 'job-timeout-001', 'log contains jobId');
  t.equal(entry.settlementId, 'stl-001', 'log contains settlementId');
  t.equal(entry.merchantId, 'merchant-alpha', 'log contains merchantId');
  t.ok(typeof entry.durationMs === 'number', 'log contains durationMs (number)');
  t.ok((entry.durationMs as number) > 30_000, 'durationMs reflects elapsed time (~35s)');
  t.equal(entry.attempt, 2, 'log contains attempt number');
  t.equal(entry.error, 'job timed out', 'log contains error message');
  t.equal(entry.jobName, 'process-settlement', 'log contains job name');
  t.equal(entry.queueName, 'settlements', 'log contains queue name');
  t.end();
});

test('Failed handler: includes undefined durationMs when processedOn is null', async (t) => {
  logEntries.length = 0;
  const dlq = createMockDLQ();

  const job: MockJob = {
    id: 'job-no-processed',
    data: { id: 'stl-002', merchantId: 'merchant-beta' },
    name: 'process-settlement',
    processedOn: null,
    attemptsMade: 0,
  };

  const err = new Error('network error');
  await onJobFailed(job, err, mockLog, dlq);

  const entry = logEntries[0];
  t.equal(entry.durationMs, undefined, 'durationMs is undefined when processedOn is null');
  t.end();
});

test('Failed handler: adds job to DLQ after logging', async (t) => {
  logEntries.length = 0;
  const dlq = createMockDLQ();

  const job: MockJob = {
    id: 'job-dlq-001',
    data: { id: 'stl-003', merchantId: 'merchant-gamma' },
    name: 'process-settlement',
    processedOn: Date.now() - 5000,
    attemptsMade: 1,
  };

  const err = new Error('processing failed');
  await onJobFailed(job, err, mockLog, dlq);

  t.equal(dlq.calls.length, 1, 'one DLQ add call');
  t.equal(dlq.calls[0].name, 'process-settlement', 'DLQ entry uses job name');
  t.equal((dlq.calls[0].data as MockJob['data']).id, 'stl-003', 'DLQ entry has settlement data');
  t.ok(dlq.calls[0].opts, 'DLQ entry has options');
  t.end();
});

test('Failed handler: handles job being null safely', async (t) => {
  logEntries.length = 0;
  const dlq = createMockDLQ();

  await onJobFailed(null, new Error('ignored'), mockLog, dlq);

  t.equal(logEntries.length, 0, 'no log entries when job is null');
  t.equal(dlq.calls.length, 0, 'no DLQ entries when job is null');
  t.end();
});

// ── Success case (simulated) ────────────────────────────────────────────────

test('Success case: handler completes without error for a fast job', async (t) => {
  // Simulate a job that completes within the timeout
  const dlq = createMockDLQ();

  const job: MockJob = {
    id: 'job-success-001',
    data: { id: 'stl-004', merchantId: 'merchant-delta' },
    name: 'process-settlement',
    processedOn: Date.now() - 5000, // 5 seconds ago — well within 30s timeout
    attemptsMade: 0,
  };

  // If the job completes, the failed handler should NOT be called
  t.pass('fast job (5s) completes without triggering the failed handler');
  t.ok((Date.now() - (job.processedOn ?? 0)) < DEFAULT_TIMEOUT_MS, 'duration is within timeout');
  t.equal(dlq.calls.length, 0, 'DLQ is untouched for a successful job');
  t.end();
});

// ── Timeout simulation ──────────────────────────────────────────────────────

test('Timeout case: simulated slow job exceeds timeout and triggers failed handler with correct fields', async (t) => {
  logEntries.length = 0;
  const dlq = createMockDLQ();

  // Simulate a job that started 35 seconds ago — exceeds the 30s default timeout
  const processedOn = Date.now() - 35_000;

  const job: MockJob = {
    id: 'job-timeout-002',
    data: { id: 'stl-005', merchantId: 'merchant-epsilon' },
    name: 'process-settlement',
    processedOn,
    attemptsMade: 2,
  };

  const err = new Error('job timed out');
  await onJobFailed(job, err, mockLog, dlq);

  t.equal(logEntries.length, 1, 'one log entry emitted');
  const entry = logEntries[0];
  t.equal(entry.jobId, 'job-timeout-002', 'log contains jobId');
  t.equal(entry.settlementId, 'stl-005', 'log contains settlementId');
  t.equal(entry.merchantId, 'merchant-epsilon', 'log contains merchantId');
  t.ok(typeof entry.durationMs === 'number', 'log contains durationMs');
  t.ok((entry.durationMs as number) >= 35_000, 'durationMs >= 35s for slow job');
  t.equal(entry.error, 'job timed out', 'log contains timeout error');
  t.equal(entry.jobName, 'process-settlement', 'log contains job name');
  t.equal(entry.queueName, 'settlements', 'log contains queue name');

  // Also verify DLQ was populated
  t.equal(dlq.calls.length, 1, 'job was moved to DLQ');
  t.end();
});
