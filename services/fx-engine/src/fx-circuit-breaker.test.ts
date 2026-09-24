/**
 * Tests for the CoinGecko circuit breaker introduced alongside issue #CB.
 *
 * The circuit breaker is recreated here in isolation following the same
 * self-contained pattern used by rate-refresh.test.ts — no import of the
 * live Fastify app is needed.
 *
 * State machine:
 *   CLOSED   → OPEN    after FAILURE_THRESHOLD consecutive failures
 *   OPEN     → HALF_OPEN after cooldown elapses
 *   HALF_OPEN → CLOSED  on successful probe fetch
 *   HALF_OPEN → OPEN    on failed probe fetch (resets cooldown)
 */

import test from 'tape';

// ── Types ──────────────────────────────────────────────────────────────────

type CircuitBreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

interface CircuitBreaker {
  state: CircuitBreakerState;
  consecutiveFailures: number;
  openedAt: number | null;
  lastTransitionAt: number;
}

interface LogEntry {
  level: 'info' | 'warn';
  obj: object;
  msg: string;
}

// ── Circuit breaker factory ────────────────────────────────────────────────
// Returns a fresh, isolated instance plus helpers that mirror the production
// logic in services/fx-engine/src/index.ts.

const FAILURE_THRESHOLD = 5;

function makeCircuitBreaker(opts: { cooldownMs: number; nowFn?: () => number }) {
  const now = opts.nowFn ?? (() => Date.now());

  const cb: CircuitBreaker = {
    state: 'CLOSED',
    consecutiveFailures: 0,
    openedAt: null,
    lastTransitionAt: now(),
  };

  const logs: LogEntry[] = [];

  const log = {
    info(obj: object, msg: string) {
      logs.push({ level: 'info', obj, msg });
    },
  };

  function transition(newState: CircuitBreakerState): void {
    const prev = cb.state;
    if (prev === newState) return;

    cb.state = newState;
    cb.lastTransitionAt = now();

    if (newState === 'OPEN') {
      cb.openedAt = now();
    } else if (newState === 'CLOSED') {
      cb.consecutiveFailures = 0;
      cb.openedAt = null;
    }

    log.info(
      { from: prev, to: newState, consecutiveFailures: cb.consecutiveFailures },
      `Circuit breaker transition: ${prev} → ${newState}`,
    );
  }

  function onSuccess(): void {
    cb.consecutiveFailures = 0;
    if (cb.state !== 'CLOSED') {
      transition('CLOSED');
    }
  }

  function onFailure(): void {
    cb.consecutiveFailures += 1;

    if (
      cb.state === 'HALF_OPEN' ||
      (cb.state === 'CLOSED' && cb.consecutiveFailures >= FAILURE_THRESHOLD)
    ) {
      transition('OPEN');
    }
  }

  /** Returns the effective state, advancing OPEN → HALF_OPEN when cooldown has elapsed. */
  function currentState(): CircuitBreakerState {
    if (
      cb.state === 'OPEN' &&
      cb.openedAt !== null &&
      now() - cb.openedAt >= opts.cooldownMs
    ) {
      cb.state = 'HALF_OPEN';
      cb.lastTransitionAt = now();
    }
    return cb.state;
  }

  return { cb, logs, onSuccess, onFailure, currentState };
}

// ── Helpers ────────────────────────────────────────────────────────────────

/** Simulate `count` consecutive failures on the given circuit breaker. */
function failN(
  count: number,
  { onFailure }: { onFailure: () => void },
): void {
  for (let i = 0; i < count; i++) {
    onFailure();
  }
}

// ── Tests ──────────────────────────────────────────────────────────────────

test('Initial state is CLOSED', (t) => {
  const { cb, currentState } = makeCircuitBreaker({ cooldownMs: 300_000 });

  t.equal(currentState(), 'CLOSED', 'starts in CLOSED state');
  t.equal(cb.consecutiveFailures, 0, 'zero consecutive failures');
  t.equal(cb.openedAt, null, 'openedAt is null');
  t.end();
});

test('4 consecutive failures keep state CLOSED', (t) => {
  const { currentState, onFailure } = makeCircuitBreaker({ cooldownMs: 300_000 });

  failN(4, { onFailure });

  t.equal(currentState(), 'CLOSED', 'state is still CLOSED after 4 failures');
  t.end();
});

test('5 consecutive failures transition state to OPEN', (t) => {
  const { cb, currentState, onFailure, logs } = makeCircuitBreaker({ cooldownMs: 300_000 });

  failN(5, { onFailure });

  t.equal(currentState(), 'OPEN', 'state becomes OPEN after 5 failures');
  t.equal(cb.consecutiveFailures, 5, 'consecutiveFailures is 5');
  t.ok(cb.openedAt !== null, 'openedAt is recorded');

  const transitionLog = logs.find((l) => l.msg.includes('CLOSED → OPEN'));
  t.ok(transitionLog, 'CLOSED → OPEN transition is logged');
  t.end();
});

test('A success before threshold resets consecutiveFailures and stays CLOSED', (t) => {
  const { cb, currentState, onFailure, onSuccess } = makeCircuitBreaker({ cooldownMs: 300_000 });

  failN(4, { onFailure });
  onSuccess();

  t.equal(currentState(), 'CLOSED', 'state remains CLOSED after recovery');
  t.equal(cb.consecutiveFailures, 0, 'consecutiveFailures reset to 0');
  t.end();
});

test('After cooldown, state transitions from OPEN to HALF_OPEN', (t) => {
  const COOLDOWN = 300_000;
  let fakeNow = 1_000_000;
  const { currentState, onFailure } = makeCircuitBreaker({
    cooldownMs: COOLDOWN,
    nowFn: () => fakeNow,
  });

  failN(5, { onFailure });
  t.equal(currentState(), 'OPEN', 'state is OPEN immediately after threshold');

  // Advance clock past cooldown
  fakeNow += COOLDOWN + 1;

  t.equal(currentState(), 'HALF_OPEN', 'state becomes HALF_OPEN after cooldown');
  t.end();
});

test('Successful fetch in HALF_OPEN transitions to CLOSED', (t) => {
  const COOLDOWN = 300_000;
  let fakeNow = 1_000_000;
  const { currentState, onFailure, onSuccess, logs } = makeCircuitBreaker({
    cooldownMs: COOLDOWN,
    nowFn: () => fakeNow,
  });

  failN(5, { onFailure });
  fakeNow += COOLDOWN + 1;

  t.equal(currentState(), 'HALF_OPEN', 'pre-condition: state is HALF_OPEN');

  onSuccess();

  t.equal(currentState(), 'CLOSED', 'state becomes CLOSED after successful probe');

  const transitionLog = logs.find((l) => l.msg.includes('HALF_OPEN → CLOSED'));
  t.ok(transitionLog, 'HALF_OPEN → CLOSED transition is logged');
  t.end();
});

test('Failed fetch in HALF_OPEN transitions back to OPEN', (t) => {
  const COOLDOWN = 300_000;
  let fakeNow = 1_000_000;
  const { cb, currentState, onFailure, logs } = makeCircuitBreaker({
    cooldownMs: COOLDOWN,
    nowFn: () => fakeNow,
  });

  failN(5, { onFailure });
  const firstOpenedAt = cb.openedAt!;
  fakeNow += COOLDOWN + 1;

  t.equal(currentState(), 'HALF_OPEN', 'pre-condition: state is HALF_OPEN');

  // Advance time slightly so a new openedAt can be distinguished
  fakeNow += 1_000;
  onFailure();

  t.equal(currentState(), 'OPEN', 'state returns to OPEN after failed probe');
  t.ok(cb.openedAt !== null && cb.openedAt > firstOpenedAt, 'openedAt is reset to new timestamp');

  const transitionLog = logs.find((l) => l.msg.includes('HALF_OPEN → OPEN'));
  t.ok(transitionLog, 'HALF_OPEN → OPEN transition is logged');
  t.end();
});

test('State stays OPEN when checked before cooldown expires', (t) => {
  const COOLDOWN = 300_000;
  let fakeNow = 1_000_000;
  const { currentState, onFailure } = makeCircuitBreaker({
    cooldownMs: COOLDOWN,
    nowFn: () => fakeNow,
  });

  failN(5, { onFailure });

  // Advance by less than cooldown
  fakeNow += COOLDOWN - 1;

  t.equal(currentState(), 'OPEN', 'state remains OPEN before cooldown expires');
  t.end();
});

test('Each CLOSED → OPEN trip resets the cooldown timer', (t) => {
  const COOLDOWN = 300_000;
  let fakeNow = 1_000_000;
  const { cb, currentState, onFailure, onSuccess } = makeCircuitBreaker({
    cooldownMs: COOLDOWN,
    nowFn: () => fakeNow,
  });

  // First trip
  failN(5, { onFailure });
  const firstOpenedAt = cb.openedAt!;

  // Advance into HALF_OPEN
  fakeNow += COOLDOWN + 1;
  t.equal(currentState(), 'HALF_OPEN', '1st cooldown: HALF_OPEN');

  // Recovery then second trip
  onSuccess();
  t.equal(currentState(), 'CLOSED', 'recovered to CLOSED');

  fakeNow += 10_000;
  failN(5, { onFailure });

  const secondOpenedAt = cb.openedAt!;
  t.ok(secondOpenedAt > firstOpenedAt, 'openedAt updated on second trip');

  // Old deadline no longer valid — still OPEN
  t.equal(currentState(), 'OPEN', 'state is OPEN after second trip (cooldown reset)');

  // Advance past new cooldown
  fakeNow = secondOpenedAt + COOLDOWN + 1;
  t.equal(currentState(), 'HALF_OPEN', 'HALF_OPEN after second cooldown');
  t.end();
});

test('All state transitions are logged', (t) => {
  const COOLDOWN = 300_000;
  let fakeNow = 1_000_000;
  const { currentState, onFailure, onSuccess, logs } = makeCircuitBreaker({
    cooldownMs: COOLDOWN,
    nowFn: () => fakeNow,
  });

  // CLOSED → OPEN
  failN(5, { onFailure });
  t.ok(
    logs.some((l) => l.msg.includes('CLOSED → OPEN')),
    'CLOSED → OPEN logged',
  );

  // OPEN → HALF_OPEN (implicit via currentState)
  fakeNow += COOLDOWN + 1;
  currentState(); // triggers implicit transition

  // HALF_OPEN → CLOSED
  onSuccess();
  t.ok(
    logs.some((l) => l.msg.includes('HALF_OPEN → CLOSED')),
    'HALF_OPEN → CLOSED logged',
  );

  // Second trip: CLOSED → OPEN → HALF_OPEN → OPEN
  failN(5, { onFailure });
  fakeNow += COOLDOWN + 1;
  currentState(); // HALF_OPEN
  onFailure();    // HALF_OPEN → OPEN
  t.ok(
    logs.some((l) => l.msg.includes('HALF_OPEN → OPEN')),
    'HALF_OPEN → OPEN logged',
  );

  t.end();
});
