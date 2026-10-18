/**
 * FX fallback tracking (#883): counter, active gauge, sustained-fallback alert
 * and the periodic fallback warning. Kept free of module-level side effects so
 * it can be tested with an injected notifier, registry and scheduler.
 */

export interface FallbackCounter {
  inc(): void;
}

export interface FallbackGauge {
  set(value: number): void;
}

export interface FallbackAlert {
  consecutiveFallbacks: number;
  threshold: number;
}

export type FallbackNotifier = (alert: FallbackAlert) => void;

/** Consecutive fallback events that trigger an alert. */
export const FALLBACK_ALERT_THRESHOLD = 3;

/** Log a warning this often while in fallback mode. */
export const FALLBACK_WARNING_INTERVAL_MS = 5 * 60 * 1000;

export function createFallbackTracker(opts: {
  counter: FallbackCounter;
  gauge: FallbackGauge;
  notifier: FallbackNotifier;
  threshold?: number;
}) {
  const threshold = opts.threshold ?? FALLBACK_ALERT_THRESHOLD;
  let consecutive = 0;
  opts.gauge.set(0);

  return {
    /** A refresh was served from seed rates. Alerts once, when the threshold is reached. */
    recordFallback(): void {
      opts.counter.inc();
      opts.gauge.set(1);
      consecutive += 1;
      if (consecutive === threshold) {
        opts.notifier({ consecutiveFallbacks: consecutive, threshold });
      }
    },
    /** Live rates are back: clears the gauge and re-arms the alert. */
    recordLive(): void {
      consecutive = 0;
      opts.gauge.set(0);
    },
  };
}

/** Starts the periodic fallback warning; the scheduler and clock are injectable. */
export function startFallbackWarningLoop(opts: {
  getStartTime: () => number | null;
  warn: (ctx: { durationMs: number; durationMin: number }, msg: string) => void;
  intervalMs?: number;
  now?: () => number;
  schedule?: (fn: () => void, ms: number) => { unref?: () => void };
}): { unref?: () => void } {
  const now = opts.now ?? Date.now;
  const schedule = opts.schedule ?? ((fn, ms) => setInterval(fn, ms));
  const handle = schedule(() => {
    const startTime = opts.getStartTime();
    if (startTime === null) return;
    const durationMs = now() - startTime;
    const durationMin = Math.round(durationMs / 60000);
    opts.warn(
      { durationMs, durationMin },
      `Operating in fallback FX rate mode for ${durationMin} minute(s); rates API unavailable`,
    );
  }, opts.intervalMs ?? FALLBACK_WARNING_INTERVAL_MS);
  if (typeof handle.unref === "function") handle.unref();
  return handle;
}
