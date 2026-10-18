/**
 * Tests for FX fallback alerting (#883), run against the real tracker in
 * fallback-tracker.ts with prom-client metrics, an injected notifier and an
 * injected scheduler/clock, so nothing waits on real time and no PagerDuty or
 * Slack integration is involved.
 */

import test from 'tape';
import * as promClient from 'prom-client';
import {
  createFallbackTracker,
  startFallbackWarningLoop,
  FALLBACK_ALERT_THRESHOLD,
  FALLBACK_WARNING_INTERVAL_MS,
  type FallbackAlert,
} from './fallback-tracker.js';

function makeTracker(opts: { threshold?: number; notifier: (alert: FallbackAlert) => void }) {
  const registry = new promClient.Registry();
  const eventsTotal = new promClient.Counter({
    name: 'fx_fallback_events_total',
    help: 'Total number of fallback events triggered',
    registers: [registry],
  });
  const active = new promClient.Gauge({
    name: 'fx_fallback_active',
    help: 'Indicates if the system is currently in fallback mode (1 = fallback, 0 = live)',
    registers: [registry],
  });
  const tracker = createFallbackTracker({
    counter: eventsTotal,
    gauge: active,
    notifier: opts.notifier,
    threshold: opts.threshold,
  });
  return {
    recordFallback: () => tracker.recordFallback(),
    recordLive: () => tracker.recordLive(),
    async counterValue(): Promise<number> {
      return (await eventsTotal.get()).values[0]?.value ?? 0;
    },
    async gaugeValue(): Promise<number> {
      return (await active.get()).values[0]?.value ?? 0;
    },
  };
}

test('single fallback increments the counter by one and emits no alert', async (t) => {
  const alerts: FallbackAlert[] = [];
  const tracker = makeTracker({ notifier: (a) => alerts.push(a) });

  t.equal(await tracker.counterValue(), 0, 'counter starts at 0');
  tracker.recordFallback();

  t.equal(await tracker.counterValue(), 1, 'counter incremented by exactly one');
  t.equal(alerts.length, 0, 'no alert emitted for a single fallback');
  t.end();
});

test('counter increments on every fallback event', async (t) => {
  const tracker = makeTracker({ notifier: () => {} });

  for (let i = 1; i <= 5; i++) {
    tracker.recordFallback();
    t.equal(await tracker.counterValue(), i, `counter is ${i} after ${i} fallback event(s)`);
  }
  t.end();
});

test('counter keeps increasing across recovery and a new fallback', async (t) => {
  const tracker = makeTracker({ notifier: () => {} });

  tracker.recordFallback();
  tracker.recordLive();
  tracker.recordFallback();

  t.equal(await tracker.counterValue(), 2, 'recovery does not reset the counter');
  t.end();
});

test('reaching the threshold emits exactly one alert signal', async (t) => {
  const alerts: FallbackAlert[] = [];
  const tracker = makeTracker({ threshold: 3, notifier: (a) => alerts.push(a) });

  tracker.recordFallback();
  tracker.recordFallback();
  t.equal(alerts.length, 0, 'no alert below the threshold');

  tracker.recordFallback();
  t.equal(alerts.length, 1, 'alert emitted when threshold is reached');
  t.deepEqual(alerts[0], { consecutiveFallbacks: 3, threshold: 3 }, 'alert carries count and threshold');

  tracker.recordFallback();
  tracker.recordFallback();
  t.equal(alerts.length, 1, 'no further alerts while the same outage continues');
  t.end();
});

test('alert re-arms after recovery', async (t) => {
  const alerts: FallbackAlert[] = [];
  const tracker = makeTracker({ threshold: 2, notifier: (a) => alerts.push(a) });

  tracker.recordFallback();
  tracker.recordFallback();
  t.equal(alerts.length, 1, 'first outage alerts once');

  tracker.recordLive();
  tracker.recordFallback();
  t.equal(alerts.length, 1, 'a single fallback after recovery does not alert');

  tracker.recordFallback();
  t.equal(alerts.length, 2, 'second outage alerts once it reaches the threshold again');
  t.end();
});

test('fx_fallback_active is 1 in fallback and 0 after recovery', async (t) => {
  const tracker = makeTracker({ notifier: () => {} });

  t.equal(await tracker.gaugeValue(), 0, 'gauge is 0 while live');

  tracker.recordFallback();
  t.equal(await tracker.gaugeValue(), 1, 'gauge is 1 in fallback mode');

  tracker.recordFallback();
  t.equal(await tracker.gaugeValue(), 1, 'gauge stays 1 across repeated fallbacks');

  tracker.recordLive();
  t.equal(await tracker.gaugeValue(), 0, 'gauge returns to 0 on recovery');
  t.end();
});

test('recovery does not emit an alert', async (t) => {
  const alerts: FallbackAlert[] = [];
  const tracker = makeTracker({ notifier: (a) => alerts.push(a) });

  tracker.recordFallback();
  tracker.recordLive();

  t.equal(alerts.length, 0, 'no alert for a fallback that recovered below the threshold');
  t.end();
});

test('default threshold is more than one so a single fallback never alerts', (t) => {
  t.ok(FALLBACK_ALERT_THRESHOLD > 1, 'threshold requires sustained fallback');
  t.end();
});

function makeWarningLoop(getStartTime: () => number | null, clock: { now: number }) {
  const warnings: Array<{ durationMs: number; durationMin: number }> = [];
  let tick: () => void = () => {};
  let scheduledMs = 0;
  startFallbackWarningLoop({
    getStartTime,
    warn: (ctx) => warnings.push(ctx),
    now: () => clock.now,
    schedule: (fn, ms) => {
      tick = fn;
      scheduledMs = ms;
      return {};
    },
  });
  return { warnings, tick: () => tick(), scheduledMs: () => scheduledMs };
}

test('fallback warning loop runs on a 5-minute cadence without real time', (t) => {
  const clock = { now: 0 };
  const loop = makeWarningLoop(() => 0, clock);

  t.equal(loop.scheduledMs(), FALLBACK_WARNING_INTERVAL_MS, 'scheduled every 5 minutes');
  t.equal(FALLBACK_WARNING_INTERVAL_MS, 5 * 60 * 1000, 'interval is 5 minutes');

  clock.now = FALLBACK_WARNING_INTERVAL_MS;
  loop.tick();
  t.equal(loop.warnings.length, 1, 'warning logged on the first tick');
  t.deepEqual(loop.warnings[0], { durationMs: FALLBACK_WARNING_INTERVAL_MS, durationMin: 5 }, 'carries duration');

  clock.now = 2 * FALLBACK_WARNING_INTERVAL_MS;
  loop.tick();
  t.equal(loop.warnings.length, 2, 'warning logged again on the next tick');
  t.equal(loop.warnings[1].durationMin, 10, 'duration advances');
  t.end();
});

test('fallback warning loop is silent while live', (t) => {
  const clock = { now: 10 * FALLBACK_WARNING_INTERVAL_MS };
  let start: number | null = null;
  const loop = makeWarningLoop(() => start, clock);

  loop.tick();
  t.equal(loop.warnings.length, 0, 'no warning while live');

  start = 0;
  loop.tick();
  t.equal(loop.warnings.length, 1, 'warning once in fallback');

  start = null;
  loop.tick();
  t.equal(loop.warnings.length, 1, 'no further warning after recovery');
  t.end();
});
