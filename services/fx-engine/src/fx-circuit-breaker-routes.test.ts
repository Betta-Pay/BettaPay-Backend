import test from 'tape';
import {
  createCircuitBreakerRegistry,
  CIRCUIT_BREAKER_FAILURE_THRESHOLD,
} from './circuit-breaker.js';

const COOLDOWN_MS = 60_000;

function setup() {
  let clock = 1_000_000;
  const registry = createCircuitBreakerRegistry({ now: () => clock });
  const logs: { obj: Record<string, unknown>; msg: string }[] = [];
  const log = {
    info(obj: object, msg: string) {
      logs.push({ obj: obj as Record<string, unknown>, msg });
    },
  };
  return {
    registry,
    log,
    logs,
    advance(ms: number) {
      clock += ms;
    },
  };
}

function fail(
  s: ReturnType<typeof setup>,
  route: string,
  times = CIRCUIT_BREAKER_FAILURE_THRESHOLD,
) {
  for (let i = 0; i < times; i++) s.registry.recordFailure(route, s.log);
}

test('tripping one route opens only that route breaker', (t) => {
  const s = setup();
  fail(s, 'route-a');

  t.equal(s.registry.getState('route-a', COOLDOWN_MS), 'OPEN', 'route-a is OPEN');
  t.equal(s.registry.getState('route-b', COOLDOWN_MS), 'CLOSED', 'route-b stays CLOSED');
  t.equal(s.registry.getState('route-c', COOLDOWN_MS), 'CLOSED', 'route-c stays CLOSED');
  t.end();
});

test('other routes keep serving while one route is open', (t) => {
  const s = setup();
  fail(s, 'route-a');

  s.registry.recordFailure('route-b', s.log);
  s.registry.recordSuccess('route-b', s.log);
  t.equal(s.registry.getState('route-b', COOLDOWN_MS), 'CLOSED', 'route-b still closed after mixed calls');
  t.equal(s.registry.snapshot('route-b').consecutiveFailures, 0, 'route-b failures reset by success');
  t.end();
});

test('state getter reports OPEN for the tripped route only', (t) => {
  const s = setup();
  fail(s, 'route-a');
  fail(s, 'route-b', CIRCUIT_BREAKER_FAILURE_THRESHOLD - 1);

  const open = s.registry.routes().filter((r) => s.registry.getState(r, COOLDOWN_MS) === 'OPEN');
  t.deepEqual(open, ['route-a'], 'only route-a reports OPEN');
  t.end();
});

test('failures below the threshold leave the breaker CLOSED', (t) => {
  const s = setup();
  fail(s, 'route-a', CIRCUIT_BREAKER_FAILURE_THRESHOLD - 1);

  t.equal(s.registry.getState('route-a', COOLDOWN_MS), 'CLOSED', 'still CLOSED');
  t.equal(s.registry.snapshot('route-a').consecutiveFailures, CIRCUIT_BREAKER_FAILURE_THRESHOLD - 1, 'failures counted');

  s.registry.recordFailure('route-a', s.log);
  t.equal(s.registry.getState('route-a', COOLDOWN_MS), 'OPEN', 'opens exactly at the threshold');
  t.end();
});

test('cooldown resets only the intended route', (t) => {
  const s = setup();
  fail(s, 'route-a');
  s.advance(COOLDOWN_MS / 2);
  fail(s, 'route-b'); // opened later, so its cooldown is still running
  s.advance(COOLDOWN_MS / 2);

  t.equal(s.registry.getState('route-a', COOLDOWN_MS), 'HALF_OPEN', 'route-a cooldown elapsed → HALF_OPEN');
  t.equal(s.registry.getState('route-b', COOLDOWN_MS), 'OPEN', 'route-b still cooling down');

  s.advance(COOLDOWN_MS / 2);
  t.equal(s.registry.getState('route-b', COOLDOWN_MS), 'HALF_OPEN', 'route-b moves once its own cooldown elapses');
  t.end();
});

test('route moves to HALF_OPEN after cooldown and CLOSED on success', (t) => {
  const s = setup();
  fail(s, 'route-a');

  s.advance(COOLDOWN_MS - 1);
  t.equal(s.registry.getState('route-a', COOLDOWN_MS), 'OPEN', 'OPEN just before the cooldown elapses');

  s.advance(1);
  t.equal(s.registry.getState('route-a', COOLDOWN_MS), 'HALF_OPEN', 'HALF_OPEN once the cooldown elapses');

  s.registry.recordSuccess('route-a', s.log);
  t.equal(s.registry.getState('route-a', COOLDOWN_MS), 'CLOSED', 'CLOSED after a successful probe');
  t.equal(s.registry.snapshot('route-a').openedAt, null, 'openedAt cleared');
  t.end();
});

test('a successful call in HALF_OPEN resets consecutive failures to zero', (t) => {
  const s = setup();
  fail(s, 'route-a');
  s.advance(COOLDOWN_MS);
  t.equal(s.registry.getState('route-a', COOLDOWN_MS), 'HALF_OPEN', 'precondition: HALF_OPEN');
  t.ok(s.registry.snapshot('route-a').consecutiveFailures > 0, 'failures recorded before the probe');

  s.registry.recordSuccess('route-a', s.log);
  t.equal(s.registry.snapshot('route-a').consecutiveFailures, 0, 'failures reset to zero');
  t.end();
});

test('a failed probe in HALF_OPEN reopens only that route', (t) => {
  const s = setup();
  fail(s, 'route-a');
  fail(s, 'route-b');
  s.advance(COOLDOWN_MS);
  s.registry.getState('route-a', COOLDOWN_MS);
  s.registry.getState('route-b', COOLDOWN_MS);

  s.registry.recordFailure('route-a', s.log);
  t.equal(s.registry.getState('route-a', COOLDOWN_MS), 'OPEN', 'route-a reopened');
  t.equal(s.registry.getState('route-b', COOLDOWN_MS), 'HALF_OPEN', 'route-b untouched');
  t.end();
});

test('transition logs carry the route', (t) => {
  const s = setup();
  fail(s, 'route-a');

  t.equal(s.logs.length, 1, 'one transition logged');
  t.equal(s.logs[0].obj.route, 'route-a', 'log names the route');
  t.equal(s.logs[0].obj.to, 'OPEN', 'log records the new state');
  t.end();
});
