import test from 'node:test';
import assert from 'node:assert/strict';
import { installCrashHandlers, _resetCrashHandlersForTesting } from './crash-handlers.js';

// Issue #862: Unit tests for installCrashHandlers registration, idempotency, and exit behavior.

function createLoggerSpy() {
  const errorCalls: { obj: object; msg?: string }[] = [];
  return {
    errorCalls,
    error(obj: object, msg?: string) {
      errorCalls.push({ obj, msg });
    },
    info() {},
    warn() {},
    debug() {},
  };
}

test('installCrashHandlers: registers uncaughtException and unhandledRejection handlers', () => {
  const originalOn = process.on;
  const registered: { event: string; handler: (...args: any[]) => void }[] = [];

  // Stub process.on
  process.on = function (event: string | symbol, listener: (...args: any[]) => void) {
    registered.push({ event: String(event), handler: listener });
    return process;
  } as any;

  _resetCrashHandlersForTesting();

  try {
    const logger = createLoggerSpy();
    installCrashHandlers(logger);

    assert.equal(registered.length, 2, 'registers exactly two handlers');
    assert.ok(registered.some((r) => r.event === 'uncaughtException'), 'registers uncaughtException');
    assert.ok(registered.some((r) => r.event === 'unhandledRejection'), 'registers unhandledRejection');
  } finally {
    process.on = originalOn;
    _resetCrashHandlersForTesting();
  }
});

test('installCrashHandlers: calling install twice is idempotent and does not double-register', () => {
  const originalOn = process.on;
  const registered: { event: string; handler: (...args: any[]) => void }[] = [];

  process.on = function (event: string | symbol, listener: (...args: any[]) => void) {
    registered.push({ event: String(event), handler: listener });
    return process;
  } as any;

  _resetCrashHandlersForTesting();

  try {
    const logger1 = createLoggerSpy();
    const logger2 = createLoggerSpy();

    installCrashHandlers(logger1);
    assert.equal(registered.length, 2, 'first call registers 2 handlers');

    installCrashHandlers(logger2);
    assert.equal(registered.length, 2, 'second call does not register any additional handlers');
  } finally {
    process.on = originalOn;
    _resetCrashHandlersForTesting();
  }
});

test('installCrashHandlers: handles uncaughtException by logging once and calling process.exit(1)', () => {
  const originalOn = process.on;
  const originalExit = process.exit;
  const registered: Record<string, ((...args: any[]) => void)[]> = {};
  const exitCalls: (number | undefined)[] = [];

  process.on = function (event: string | symbol, listener: (...args: any[]) => void) {
    const key = String(event);
    if (!registered[key]) registered[key] = [];
    registered[key].push(listener);
    return process;
  } as any;

  process.exit = function (code?: number) {
    exitCalls.push(code);
    return undefined as never;
  } as any;

  _resetCrashHandlersForTesting();

  try {
    const logger = createLoggerSpy();
    installCrashHandlers(logger);

    // Call install again to verify idempotency doesn't double-log
    installCrashHandlers(logger);

    const uncaughtHandler = registered['uncaughtException']?.[0];
    assert.ok(uncaughtHandler, 'uncaughtException handler exists');

    const testError = new Error('simulated fatal exception');
    uncaughtHandler(testError);

    assert.equal(logger.errorCalls.length, 1, 'logs once per crash');
    assert.equal(logger.errorCalls[0].msg, 'Uncaught exception — exiting');
    assert.deepEqual(logger.errorCalls[0].obj, { err: testError });

    assert.equal(exitCalls.length, 1, 'process.exit called once');
    assert.equal(exitCalls[0], 1, 'process.exit called with exit code 1');
  } finally {
    process.on = originalOn;
    process.exit = originalExit;
    _resetCrashHandlersForTesting();
  }
});

test('installCrashHandlers: handles unhandledRejection by logging once and calling process.exit(1)', () => {
  const originalOn = process.on;
  const originalExit = process.exit;
  const registered: Record<string, ((...args: any[]) => void)[]> = {};
  const exitCalls: (number | undefined)[] = [];

  process.on = function (event: string | symbol, listener: (...args: any[]) => void) {
    const key = String(event);
    if (!registered[key]) registered[key] = [];
    registered[key].push(listener);
    return process;
  } as any;

  process.exit = function (code?: number) {
    exitCalls.push(code);
    return undefined as never;
  } as any;

  _resetCrashHandlersForTesting();

  try {
    const logger = createLoggerSpy();
    installCrashHandlers(logger);

    const rejectionHandler = registered['unhandledRejection']?.[0];
    assert.ok(rejectionHandler, 'unhandledRejection handler exists');

    const testReason = 'simulated promise rejection';
    rejectionHandler(testReason);

    assert.equal(logger.errorCalls.length, 1, 'logs once per rejection crash');
    assert.equal(logger.errorCalls[0].msg, 'Unhandled rejection — exiting');
    assert.deepEqual(logger.errorCalls[0].obj, { err: testReason });

    assert.equal(exitCalls.length, 1, 'process.exit called once');
    assert.equal(exitCalls[0], 1, 'process.exit called with exit code 1');
  } finally {
    process.on = originalOn;
    process.exit = originalExit;
    _resetCrashHandlersForTesting();
  }
});
