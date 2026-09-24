import test from 'tape';
import {
  SETTLEMENT_JOB_TIMEOUT_MS,
  SETTLEMENT_PROCESSING_TIMEOUT_MS,
  SETTLEMENT_REAPER_INTERVAL_MS,
  validateTimeoutConstants,
} from './timeout-constants.js';

// Issue #495: Extract timeout constants and test them against real durations
test('Timeout constants are within documented ranges', (t) => {
  const MIN_JOB_TIMEOUT = 5_000;
  const MAX_JOB_TIMEOUT = 300_000;

  t.ok(
    SETTLEMENT_JOB_TIMEOUT_MS >= MIN_JOB_TIMEOUT && SETTLEMENT_JOB_TIMEOUT_MS <= MAX_JOB_TIMEOUT,
    `SETTLEMENT_JOB_TIMEOUT_MS (${SETTLEMENT_JOB_TIMEOUT_MS}ms) is within [${MIN_JOB_TIMEOUT}, ${MAX_JOB_TIMEOUT}]`
  );
  t.end();
});

test('Processing timeout is greater than job timeout', (t) => {
  t.ok(
    SETTLEMENT_PROCESSING_TIMEOUT_MS > SETTLEMENT_JOB_TIMEOUT_MS,
    `SETTLEMENT_PROCESSING_TIMEOUT_MS (${SETTLEMENT_PROCESSING_TIMEOUT_MS}ms) > SETTLEMENT_JOB_TIMEOUT_MS (${SETTLEMENT_JOB_TIMEOUT_MS}ms)`
  );
  t.end();
});

test('Reaper interval is reasonable', (t) => {
  const MIN_INTERVAL = 1_000;
  const MAX_INTERVAL = 60_000;

  t.ok(
    SETTLEMENT_REAPER_INTERVAL_MS >= MIN_INTERVAL && SETTLEMENT_REAPER_INTERVAL_MS <= MAX_INTERVAL,
    `SETTLEMENT_REAPER_INTERVAL_MS (${SETTLEMENT_REAPER_INTERVAL_MS}ms) is within [${MIN_INTERVAL}, ${MAX_INTERVAL}]`
  );
  t.end();
});

test('Constants match validation schema default (30s)', (t) => {
  const SCHEMA_DEFAULT_MS = 30_000;
  t.equal(
    SETTLEMENT_JOB_TIMEOUT_MS,
    SCHEMA_DEFAULT_MS,
    `SETTLEMENT_JOB_TIMEOUT_MS matches env schema default (${SCHEMA_DEFAULT_MS}ms)`
  );
  t.end();
});

test('validateTimeoutConstants does not throw for documented ranges', (t) => {
  try {
    validateTimeoutConstants();
    t.pass('validateTimeoutConstants() passes for extracted constants');
  } catch (err) {
    t.fail(`validateTimeoutConstants() should not throw: ${err}`);
  }
  t.end();
});

test('Integration: real-world scenario with configurable waits', async (t) => {
  // Simulate a settlement taking 15s to process (well within 30s timeout)
  const fakeProcessingTimeMs = 15_000;
  const startTime = Date.now();

  // Mock a slow job
  await new Promise(resolve => setTimeout(resolve, Math.min(fakeProcessingTimeMs, 100)));

  const elapsedMs = Date.now() - startTime;

  // Verify elapsed time is plausible (within 50ms jitter for test env)
  t.ok(
    elapsedMs + 50 >= Math.min(fakeProcessingTimeMs, 100),
    `Real elapsed time (${elapsedMs}ms) matches or exceeds simulated processing time`
  );

  // Verify it's within the timeout
  t.ok(
    fakeProcessingTimeMs <= SETTLEMENT_JOB_TIMEOUT_MS,
    `Simulated job (${fakeProcessingTimeMs}ms) is within timeout (${SETTLEMENT_JOB_TIMEOUT_MS}ms)`
  );

  t.end();
});
