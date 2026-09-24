/**
 * Settlement Engine Timeout Constants
 *
 * Documented ranges for timeouts to ensure they're within realistic bounds.
 */

// Worker job timeout — maximum duration a settlement job can run before
// being forcefully terminated. Must be at least 5s (minimum realistic processing time)
// and at most 5m (to prevent hung jobs from blocking the queue indefinitely).
export const SETTLEMENT_JOB_TIMEOUT_MS = 30_000; // 30 seconds, within [5_000, 300_000]

// Processing state timeout — maximum duration a settlement can remain in
// 'processing' state before the reaper considers it stuck. Configured with a
// 2x safety margin over SETTLEMENT_JOB_TIMEOUT_MS.
export const SETTLEMENT_PROCESSING_TIMEOUT_MS = 2 * SETTLEMENT_JOB_TIMEOUT_MS; // 60 seconds

// Reaper scan interval — how often the stuck-processing reaper runs.
export const SETTLEMENT_REAPER_INTERVAL_MS = 10_000; // 10 seconds

export function validateTimeoutConstants(): void {
  const MIN_JOB_TIMEOUT = 5_000;
  const MAX_JOB_TIMEOUT = 300_000;

  if (SETTLEMENT_JOB_TIMEOUT_MS < MIN_JOB_TIMEOUT || SETTLEMENT_JOB_TIMEOUT_MS > MAX_JOB_TIMEOUT) {
    throw new Error(
      `SETTLEMENT_JOB_TIMEOUT_MS (${SETTLEMENT_JOB_TIMEOUT_MS}ms) must be within [${MIN_JOB_TIMEOUT}, ${MAX_JOB_TIMEOUT}]`
    );
  }

  if (SETTLEMENT_PROCESSING_TIMEOUT_MS <= SETTLEMENT_JOB_TIMEOUT_MS) {
    throw new Error(
      `SETTLEMENT_PROCESSING_TIMEOUT_MS (${SETTLEMENT_PROCESSING_TIMEOUT_MS}ms) must exceed SETTLEMENT_JOB_TIMEOUT_MS (${SETTLEMENT_JOB_TIMEOUT_MS}ms)`
    );
  }
}
