import test from 'node:test';
import assert from 'node:assert/strict';
import { validateEnv, validateEnvOrExit } from './index.js';

function validEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    NODE_ENV: 'test',
    JWT_SECRET: 'a'.repeat(32),
    GOOGLE_CLIENT_ID: 'test-client-id',
    INTER_SERVICE_SECRET: 'a'.repeat(16),
    DATABASE_URL: 'postgres://user:pass@localhost:5432/db',
    SETTLEMENT_CONTRACT_ID: 'CONTRACT123',
    GOVERNANCE_CONTRACT_ID: 'CONTRACT456',
    ADMIN_ADDRESS: 'GADMIN',
    ADMIN_SECRET: 'SADMIN',
    FIELD_ENCRYPTION_KEY: 'b'.repeat(32),
    ...overrides,
  };
}

test('validateEnv returns parsed config when all required variables are valid', () => {
  const env = validateEnv(validEnv());
  assert.equal(env.JWT_SECRET, 'a'.repeat(32));
  assert.deepEqual(env.CONTRACT_IDS, ['CONTRACT123']);
});

test('validateEnv throws with a human-readable message for a too-short secret', () => {
  assert.throws(
    () => validateEnv(validEnv({ JWT_SECRET: 'short' })),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /JWT_SECRET: JWT_SECRET must be at least 32 characters \(got 5\)/);
      return true;
    },
  );
});

test('validateEnv throws listing every invalid variable, not just the first', () => {
  assert.throws(
    () => validateEnv(validEnv({ JWT_SECRET: 'short', INTER_SERVICE_SECRET: 'x' })),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /JWT_SECRET/);
      assert.match(error.message, /INTER_SERVICE_SECRET/);
      return true;
    },
  );
});

test('validateEnv throws when a required variable is missing entirely', () => {
  const { DATABASE_URL, ...withoutDatabaseUrl } = validEnv();
  assert.throws(
    () => validateEnv(withoutDatabaseUrl),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /DATABASE_URL/);
      return true;
    },
  );
});

test('validateEnvOrExit returns parsed config on valid input without exiting', () => {
  const originalExit = process.exit;
  let exitCalled = false;
  process.exit = ((() => {
    exitCalled = true;
  }) as unknown) as typeof process.exit;

  try {
    const env = validateEnvOrExit(validEnv());
    assert.equal(exitCalled, false);
    assert.equal(env.JWT_SECRET, 'a'.repeat(32));
  } finally {
    process.exit = originalExit;
  }
});

test('validateEnvOrExit logs a clean message and exits with code 1 on invalid input', () => {
  const originalExit = process.exit;
  const originalConsoleError = console.error;
  let exitCode: number | undefined;
  let loggedMessage = '';

  process.exit = ((code?: number) => {
    exitCode = code;
    throw new Error('process.exit called');
  }) as unknown as typeof process.exit;
  console.error = ((message: string) => {
    loggedMessage = message;
  }) as typeof console.error;

  try {
    assert.throws(() => validateEnvOrExit(validEnv({ JWT_SECRET: 'short' })), /process\.exit called/);
    assert.equal(exitCode, 1);
    assert.match(loggedMessage, /JWT_SECRET: JWT_SECRET must be at least 32 characters \(got 5\)/);
  } finally {
    process.exit = originalExit;
    console.error = originalConsoleError;
  }
});

test('validateEnv allows weak/default secrets in non-production environments', () => {
  // Test/dev envs allow defaults
  const envDev = validateEnv(validEnv({ NODE_ENV: 'development', JWT_SECRET: 'super-secret-development-key-please-change' }));
  assert.equal(envDev.JWT_SECRET, 'super-secret-development-key-please-change');

  // Test/dev envs allow simple secrets
  const envTest = validateEnv(validEnv({ NODE_ENV: 'test', JWT_SECRET: 'a'.repeat(32) }));
  assert.equal(envTest.JWT_SECRET, 'a'.repeat(32));
});

test('validateEnv in production throws for default development secrets', () => {
  const defaults = [
    'super-secret-development-key-please-change',
    'change-me-to-a-long-random-secret-before-production'
  ];

  for (const secret of defaults) {
    assert.throws(
      () => validateEnv(validEnv({ NODE_ENV: 'production', ALLOWED_ORIGINS: 'https://localhost:3000', JWT_SECRET: secret })),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /JWT_SECRET: JWT_SECRET cannot be a default development value in production/);
        return true;
      }
    );
  }
});

test('validateEnv in production throws for placeholder-containing secrets', () => {
  assert.throws(
    () => validateEnv(validEnv({ NODE_ENV: 'production', ALLOWED_ORIGINS: 'https://localhost:3000', JWT_SECRET: 'prod-key-but-please-change-it-later-ok' })),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /JWT_SECRET: JWT_SECRET cannot contain development placeholders/);
      return true;
    }
  );
});

test('validateEnv in production throws for secrets lacking unique characters', () => {
  assert.throws(
    () => validateEnv(validEnv({ NODE_ENV: 'production', ALLOWED_ORIGINS: 'https://localhost:3000', JWT_SECRET: 'a'.repeat(32) })),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /JWT_SECRET: JWT_SECRET is too weak: must contain at least 8 unique characters/);
      return true;
    }
  );
});

test('validateEnv in production throws for secrets lacking complexity mix', () => {
  // Lowercase only (meets unique chars requirement)
  assert.throws(
    () => validateEnv(validEnv({ NODE_ENV: 'production', ALLOWED_ORIGINS: 'https://localhost:3000', JWT_SECRET: 'abcdefghijklmnopqrstuvwxyzabcdef' })),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /JWT_SECRET: JWT_SECRET is too weak: must include a mix of uppercase letters, lowercase letters, and digits or special characters/);
      return true;
    }
  );

  // Mixed case but no digits/symbols
  assert.throws(
    () => validateEnv(validEnv({ NODE_ENV: 'production', ALLOWED_ORIGINS: 'https://localhost:3000', JWT_SECRET: 'abcdefghijklmnopqrstuvwxyzABCDEF' })),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /JWT_SECRET: JWT_SECRET is too weak: must include a mix of uppercase letters, lowercase letters, and digits or special characters/);
      return true;
    }
  );
});

test('validateEnv in production succeeds with a strong, complex secret', () => {
  const strongSecret = 'P@ssw0rd123_Very_Strong_And_Complex_Key!';
  const env = validateEnv(validEnv({ NODE_ENV: 'production', ALLOWED_ORIGINS: 'https://localhost:3000', JWT_SECRET: strongSecret }));
  assert.equal(env.JWT_SECRET, strongSecret);
});

test('validateEnv accepts default settlement batching env values', () => {
  const env = validateEnv(validEnv());
  assert.equal(env.BATCH_INTERVAL_SECONDS, 300);
  assert.equal(env.BATCH_MIN_COUNT, 2);
});

test('validateEnv rejects BATCH_INTERVAL_SECONDS out of range', () => {
  for (const value of ['0', '-1', '86401', 'abc']) {
    assert.throws(
      () => validateEnv(validEnv({ BATCH_INTERVAL_SECONDS: value })),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /BATCH_INTERVAL_SECONDS/);
        return true;
      },
    );
  }
});

test('validateEnv rejects BATCH_MIN_COUNT out of range', () => {
  for (const value of ['0', '-1', '10001', 'abc']) {
    assert.throws(
      () => validateEnv(validEnv({ BATCH_MIN_COUNT: value })),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /BATCH_MIN_COUNT/);
        return true;
      },
    );
  }
});



