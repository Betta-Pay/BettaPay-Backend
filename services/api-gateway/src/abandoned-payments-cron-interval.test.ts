/**
 * abandoned-payments-cron-interval.test.ts (issue #877)
 *
 * Env-driven cadence and shutdown cleanup for startAbandonedPaymentsCron.
 * setInterval / clearInterval are stubbed so no wall-clock time is needed.
 */
import test from 'tape';
import {
  DEFAULT_ABANDONED_PAYMENTS_CRON_INTERVAL_MS,
  startAbandonedPaymentsCron,
  stopAbandonedPaymentsCron,
} from './abandoned-payments-cron.js';

const ENV_VAR = 'ABANDONED_PAYMENTS_CRON_INTERVAL_MS';

interface TimerSpy {
  scheduled: Array<{ fn: () => unknown; ms: number }>;
  cleared: unknown[];
  restore: () => void;
}

function stubTimers(): TimerSpy {
  const originalSetInterval = global.setInterval;
  const originalClearInterval = global.clearInterval;
  const scheduled: Array<{ fn: () => unknown; ms: number }> = [];
  const cleared: unknown[] = [];

  (global as any).setInterval = (fn: () => unknown, ms: number) => {
    scheduled.push({ fn, ms });
    return { fn, ms };
  };
  (global as any).clearInterval = (handle: unknown) => {
    cleared.push(handle);
  };

  return {
    scheduled,
    cleared,
    restore: () => {
      (global as any).setInterval = originalSetInterval;
      (global as any).clearInterval = originalClearInterval;
    },
  };
}

interface WarnCall {
  obj: unknown;
  msg?: string;
}

function createLogger() {
  const warns: WarnCall[] = [];
  return {
    warns,
    logger: {
      info: () => {},
      error: () => {},
      warn: (obj: unknown, msg?: string) => warns.push({ obj, msg }),
    } as any,
  };
}

function createPrisma(expiredCount = 0) {
  const calls: unknown[] = [];
  return {
    calls,
    prisma: {
      payment: {
        findMany: async () =>
          Array.from({ length: expiredCount }, (_, i) => ({
            id: `p-${i}`,
            merchantId: 'm-1',
            amount: { toString: () => '1' },
            asset: 'USDC',
            merchant: null,
          })),
        updateMany: async (args: any) => {
          calls.push(args);
          return { count: args.where.id.in.length };
        },
      },
    } as any,
  };
}

function withEnv<T>(value: string | undefined, fn: () => T): T {
  const original = process.env[ENV_VAR];
  if (value === undefined) delete process.env[ENV_VAR];
  else process.env[ENV_VAR] = value;
  try {
    return fn();
  } finally {
    if (original === undefined) delete process.env[ENV_VAR];
    else process.env[ENV_VAR] = original;
  }
}

test('#877: an env-provided interval is parsed and passed to setInterval', (t) => {
  const timers = stubTimers();
  try {
    withEnv('45000', () => {
      startAbandonedPaymentsCron(createPrisma().prisma, createLogger().logger, 24);
      t.equal(timers.scheduled.length, 1, 'one timer scheduled');
      t.equal(timers.scheduled[0].ms, 45000, 'setInterval received the exact env millisecond value');
    });
  } finally {
    stopAbandonedPaymentsCron();
    timers.restore();
  }
  t.end();
});

test('#877: a missing env value falls back to the documented one-hour default', (t) => {
  const timers = stubTimers();
  try {
    withEnv(undefined, () => {
      startAbandonedPaymentsCron(createPrisma().prisma, createLogger().logger, 24);
      t.equal(
        timers.scheduled[0].ms,
        DEFAULT_ABANDONED_PAYMENTS_CRON_INTERVAL_MS,
        'default one hour used when env is unset',
      );
      t.equal(timers.scheduled[0].ms, 3600000, 'default is 3600000ms');
    });
  } finally {
    stopAbandonedPaymentsCron();
    timers.restore();
  }
  t.end();
});

test('#877: an invalid env value is logged and falls back rather than throwing', (t) => {
  const timers = stubTimers();
  const { warns, logger } = createLogger();
  try {
    withEnv('not-a-number', () => {
      t.doesNotThrow(() => startAbandonedPaymentsCron(createPrisma().prisma, logger, 24), 'does not throw');
      t.equal(timers.scheduled[0].ms, DEFAULT_ABANDONED_PAYMENTS_CRON_INTERVAL_MS, 'falls back to the default');
      t.equal(warns.length, 1, 'invalid value is logged');
      t.equal(warns[0].obj && (warns[0].obj as any).envVal, 'not-a-number', 'log carries the offending value');
    });
  } finally {
    stopAbandonedPaymentsCron();
    timers.restore();
  }
  t.end();
});

test('#877: calling start twice results in a single scheduled timer', (t) => {
  const timers = stubTimers();
  try {
    withEnv('60000', () => {
      const { prisma, logger } = { ...createPrisma(), logger: createLogger().logger };
      startAbandonedPaymentsCron(prisma, logger, 24);
      startAbandonedPaymentsCron(prisma, logger, 24);
      t.equal(timers.scheduled.length, 1, 'start is idempotent');
    });
  } finally {
    stopAbandonedPaymentsCron();
    timers.restore();
  }
  t.end();
});

test('#877: stopAbandonedPaymentsCron clears the timer so the job no longer fires', (t) => {
  const timers = stubTimers();
  try {
    withEnv('60000', () => {
      startAbandonedPaymentsCron(createPrisma().prisma, createLogger().logger, 24);
      const handle = timers.scheduled[0];
      stopAbandonedPaymentsCron();
      t.equal(timers.cleared.length, 1, 'clearInterval called once');
      t.equal(timers.cleared[0], handle, 'the scheduled handle was cleared');
    });
  } finally {
    stopAbandonedPaymentsCron();
    timers.restore();
  }
  t.end();
});

test('#877: advancing the interval triggers autoExpireAbandonedPayments', async (t) => {
  const timers = stubTimers();
  const original = process.env[ENV_VAR];
  process.env[ENV_VAR] = '60000';
  try {
    const { prisma, calls } = createPrisma(2);
    const { logger } = createLogger();
    startAbandonedPaymentsCron(prisma, logger, 24);

    // "Advance" the fake timer by one interval: invoke the scheduled job.
    await timers.scheduled[0].fn();

    t.equal(calls.length, 1, 'the scheduled job ran the expiry sweep once');
    t.equal((calls[0] as any).data.status, 'cancelled', 'expired payments are cancelled');
  } finally {
    if (original === undefined) delete process.env[ENV_VAR];
    else process.env[ENV_VAR] = original;
    stopAbandonedPaymentsCron();
    timers.restore();
  }
  t.end();
});
