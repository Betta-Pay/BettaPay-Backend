import test from 'node:test';
import assert from 'node:assert';
import {
  buildPrismaConnectionUrl,
  connectWithRetry,
  getPrismaLogLevels,
  shouldEnablePrismaQueryLogging,
} from './prisma.js';

test('getPrismaLogLevels includes query in development', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalLogLevel = process.env.LOG_LEVEL;

  process.env.NODE_ENV = 'development';
  delete process.env.LOG_LEVEL;
  assert.ok(getPrismaLogLevels().includes('query'));

  process.env.NODE_ENV = originalNodeEnv;
  process.env.LOG_LEVEL = originalLogLevel;
});

test('getPrismaLogLevels excludes query in production', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalLogLevel = process.env.LOG_LEVEL;

  process.env.NODE_ENV = 'production';
  process.env.LOG_LEVEL = 'debug';
  assert.ok(!shouldEnablePrismaQueryLogging());
  assert.ok(!getPrismaLogLevels().includes('query'));

  process.env.NODE_ENV = originalNodeEnv;
  process.env.LOG_LEVEL = originalLogLevel;
});

test('getPrismaLogLevels returns error and warn only in production', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalOverride = process.env.PRISMA_LOG_LEVELS;

  process.env.NODE_ENV = 'production';
  delete process.env.PRISMA_LOG_LEVELS;
  assert.deepStrictEqual(getPrismaLogLevels(), ['error', 'warn']);

  process.env.NODE_ENV = originalNodeEnv;
  process.env.PRISMA_LOG_LEVELS = originalOverride;
});

test('getPrismaLogLevels returns query, info, warn, error in development', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalOverride = process.env.PRISMA_LOG_LEVELS;

  process.env.NODE_ENV = 'development';
  delete process.env.PRISMA_LOG_LEVELS;
  assert.deepStrictEqual(getPrismaLogLevels(), ['query', 'info', 'warn', 'error']);

  process.env.NODE_ENV = originalNodeEnv;
  process.env.PRISMA_LOG_LEVELS = originalOverride;
});

test('getPrismaLogLevels returns error only in test', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalOverride = process.env.PRISMA_LOG_LEVELS;

  process.env.NODE_ENV = 'test';
  delete process.env.PRISMA_LOG_LEVELS;
  assert.deepStrictEqual(getPrismaLogLevels(), ['error']);

  process.env.NODE_ENV = originalNodeEnv;
  process.env.PRISMA_LOG_LEVELS = originalOverride;
});

test('getPrismaLogLevels honors PRISMA_LOG_LEVELS override regardless of NODE_ENV', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalOverride = process.env.PRISMA_LOG_LEVELS;

  process.env.NODE_ENV = 'production';
  process.env.PRISMA_LOG_LEVELS = 'query, warn';
  assert.deepStrictEqual(getPrismaLogLevels(), ['query', 'warn']);

  process.env.NODE_ENV = originalNodeEnv;
  process.env.PRISMA_LOG_LEVELS = originalOverride;
});

test('getPrismaLogLevels falls back to the NODE_ENV default when the override has no valid levels', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalOverride = process.env.PRISMA_LOG_LEVELS;

  process.env.NODE_ENV = 'test';
  process.env.PRISMA_LOG_LEVELS = 'not-a-level, also-invalid';
  assert.deepStrictEqual(getPrismaLogLevels(), ['error']);

  process.env.NODE_ENV = originalNodeEnv;
  process.env.PRISMA_LOG_LEVELS = originalOverride;
});

test('connectWithRetry succeeds after transient failures', async () => {
  let attempts = 0;
  const prisma = {
    async $connect() {
      attempts += 1;
      if (attempts < 3) {
        throw new Error('connection refused');
      }
    },
  };

  const warnings: object[] = [];
  await connectWithRetry(prisma, {
    debug: () => undefined,
    warn: (obj) => warnings.push(obj),
  }, { baseDelayMs: 1, maxRetries: 5 });

  assert.strictEqual(attempts, 3);
  assert.strictEqual(warnings.length, 2);
});

test('connectWithRetry throws after exhausting retries', async () => {
  const prisma = {
    async $connect() {
      throw new Error('database unavailable');
    },
  };

  await assert.rejects(
    () =>
      connectWithRetry(prisma, {
        debug: () => undefined,
        warn: () => undefined,
      }, { baseDelayMs: 1, maxRetries: 3 }),
  );
});

test('buildPrismaConnectionUrl appends params with ? when URL has no query string', () => {
  const url = 'postgresql://user:pass@localhost:5432/bettapay';
  const result = buildPrismaConnectionUrl(url, 15, 10);
  assert.strictEqual(result, 'postgresql://user:pass@localhost:5432/bettapay?connection_limit=15&pool_timeout=10');
});

test('buildPrismaConnectionUrl appends params with & when URL already has a query string', () => {
  const url = 'postgresql://user:pass@localhost:5432/bettapay?sslmode=require';
  const result = buildPrismaConnectionUrl(url, 20, 5);
  assert.strictEqual(result, 'postgresql://user:pass@localhost:5432/bettapay?sslmode=require&connection_limit=20&pool_timeout=5');
});

test('buildPrismaConnectionUrl uses defaults when no poolSize or timeout given', () => {
  const url = 'postgresql://user:pass@localhost:5432/bettapay';
  const result = buildPrismaConnectionUrl(url);
  assert.strictEqual(result, 'postgresql://user:pass@localhost:5432/bettapay?connection_limit=10&pool_timeout=10');
});

test('buildPrismaConnectionUrl replaces existing pool params instead of duplicating them (#1076)', () => {
  const url = 'postgresql://user:pass@localhost:5432/bettapay?connection_limit=5&sslmode=require&pool_timeout=99';
  const result = buildPrismaConnectionUrl(url, 20, 5);
  const params = new URL(result).searchParams;
  assert.deepStrictEqual(params.getAll('connection_limit'), ['20']);
  assert.deepStrictEqual(params.getAll('pool_timeout'), ['5']);
  assert.strictEqual(params.get('sslmode'), 'require', 'unrelated params are preserved');
});

test('buildPrismaConnectionUrl is idempotent when applied to its own output (#1076)', () => {
  const once = buildPrismaConnectionUrl('postgresql://user:pass@localhost:5432/bettapay', 15, 10);
  assert.strictEqual(buildPrismaConnectionUrl(once, 15, 10), once);
});

test('buildPrismaConnectionUrl preserves percent-encoded credentials (#1076)', () => {
  const url = 'postgresql://us%40er:p%23ss@localhost:5432/bettapay';
  assert.strictEqual(
    buildPrismaConnectionUrl(url, 15, 10),
    'postgresql://us%40er:p%23ss@localhost:5432/bettapay?connection_limit=15&pool_timeout=10',
  );
});

test('buildPrismaConnectionUrl rejects malformed DATABASE_URL values (#1076)', () => {
  assert.throws(() => buildPrismaConnectionUrl(''), /DATABASE_URL is not a valid URL/);
  assert.throws(() => buildPrismaConnectionUrl('not a url'), /DATABASE_URL is not a valid URL/);
  assert.throws(() => buildPrismaConnectionUrl('localhost:5432/bettapay?x=1'), /DATABASE_URL must include a host/);
  assert.throws(() => buildPrismaConnectionUrl('postgresql:bettapay'), /DATABASE_URL must include a host/);
});

test('buildPrismaConnectionUrl does not leak credentials in validation errors (#1076)', () => {
  assert.throws(
    () => buildPrismaConnectionUrl('postgresql://user:s3cret@[bad host/db'),
    (err: unknown) => err instanceof Error && !err.message.includes('s3cret'),
  );
});

test('buildPrismaConnectionUrl rejects invalid pool ranges early', () => {
  const url = 'postgresql://user:pass@localhost:5432/bettapay';
  assert.throws(() => buildPrismaConnectionUrl(url, 0, 10), /DATABASE_POOL_SIZE.*1/);
  assert.throws(() => buildPrismaConnectionUrl(url, 10, 0), /DATABASE_POOL_TIMEOUT.*1/);
});

import {
  resetRotation,
  hasRotated,
  getActiveConnectionUrl,
  connectWithRetryWithRotation,
} from './prisma.js';

test('connectWithRetryWithRotation switches to rotate URL on 28P01', async () => {
  resetRotation();
  let attempts = 0;
  const prisma = {
    async $connect() {
      attempts += 1;
      if (attempts === 1) {
        const err = new Error('authentication failed');
        (err as any).code = '28P01';
        throw err;
      }
    },
  };

  await connectWithRetryWithRotation(prisma, {
    debug: () => undefined,
    warn: () => undefined,
  }, { rotationUrl: 'postgres://rotated/db', baseDelayMs: 1, maxRetries: 5 });

  assert.strictEqual(hasRotated(), true);
  assert.strictEqual(getActiveConnectionUrl('postgres://primary/db'), 'postgres://rotated/db');
  resetRotation();
});

test('connectWithRetryWithRotation does not switch on primary URL success', async () => {
  resetRotation();
  const prisma = {
    async $connect() {},
  };

  await connectWithRetryWithRotation(prisma, {
    debug: () => undefined,
    warn: () => undefined,
  }, { rotationUrl: 'postgres://rotated/db', baseDelayMs: 1, maxRetries: 3 });

  assert.strictEqual(hasRotated(), false);
  assert.strictEqual(getActiveConnectionUrl('postgres://primary/db'), 'postgres://primary/db');
  resetRotation();
});

test('rotation logged at warn level', async () => {
  resetRotation();
  let attempts = 0;
  const prisma = {
    async $connect() {
      attempts += 1;
      if (attempts === 1) {
        const err = new Error('authentication failed');
        (err as any).code = '28P01';
        throw err;
      }
    },
  };

  const warnMessages: string[] = [];
  const logger = {
    debug: () => undefined,
    warn: (_obj: object, msg?: string) => {
      if (msg) warnMessages.push(msg);
    },
  };

  await connectWithRetryWithRotation(prisma, logger, { rotationUrl: 'postgres://rotated/db', baseDelayMs: 1, maxRetries: 5 });

  assert.ok(warnMessages.some(m => m.includes('credential rotation') || m.includes('authentication error')));
  resetRotation();
});

test('getActiveConnectionUrl returns primary URL when no rotation', () => {
  resetRotation();
  assert.strictEqual(getActiveConnectionUrl('postgres://primary/db'), 'postgres://primary/db');
});
