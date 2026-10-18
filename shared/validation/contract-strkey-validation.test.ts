/**
 * Issue #910 — Validate contract IDs are strkeys at startup.
 *
 * validateEnv must reject any CONTRACT_IDS / SETTLEMENT_CONTRACT_ID value
 * that is not a valid Stellar C-strkey (starts with 'C', 56 chars, A-Z/2-7
 * alphabet) and throw a human-readable error so the misconfiguration is caught
 * at startup rather than silently causing on-chain failures at runtime.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateEnv } from './index.js';

const VALID_STRKEY = 'C' + 'A'.repeat(55);
const VALID_STRKEY_2 = 'C' + 'B'.repeat(55);

function baseEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    NODE_ENV: 'test',
    JWT_SECRET: 'a'.repeat(32),
    GOOGLE_CLIENT_ID: 'test-client-id',
    INTER_SERVICE_SECRET: 'a'.repeat(16),
    DATABASE_URL: 'postgres://user:pass@localhost:5432/db',
    SETTLEMENT_CONTRACT_ID: VALID_STRKEY,
    GOVERNANCE_CONTRACT_ID: VALID_STRKEY_2,
    ADMIN_ADDRESS: 'GADMIN',
    ADMIN_SECRET: 'SADMIN',
    FIELD_ENCRYPTION_KEY: 'b'.repeat(32),
    ...overrides,
  };
}

test('#910: valid C-strkey is accepted by validateEnv', () => {
  const env = validateEnv(baseEnv());
  assert.deepEqual(env.CONTRACT_IDS, [VALID_STRKEY]);
});

test('#910: multiple valid C-strkeys via CONTRACT_IDS are accepted', () => {
  const env = validateEnv(baseEnv({ CONTRACT_IDS: `${VALID_STRKEY},${VALID_STRKEY_2}` }));
  assert.deepEqual(env.CONTRACT_IDS, [VALID_STRKEY, VALID_STRKEY_2]);
});

test('#910: CONTRACT_IDS with a non-strkey value throws at startup', () => {
  assert.throws(
    () => validateEnv(baseEnv({ SETTLEMENT_CONTRACT_ID: 'not-a-valid-contract-id' })),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /CONTRACT_IDS/);
      assert.match(error.message, /not valid Stellar contract strkey/);
      return true;
    },
  );
});

test('#910: a G-strkey (account address) is rejected — must start with C', () => {
  const gAddress = 'G' + 'A'.repeat(55);
  assert.throws(
    () => validateEnv(baseEnv({ SETTLEMENT_CONTRACT_ID: gAddress })),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /CONTRACT_IDS/);
      return true;
    },
  );
});

test('#910: a strkey that is too short is rejected', () => {
  const short = 'C' + 'A'.repeat(10);
  assert.throws(
    () => validateEnv(baseEnv({ SETTLEMENT_CONTRACT_ID: short })),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /CONTRACT_IDS/);
      return true;
    },
  );
});

test('#910: a strkey with invalid characters (contains 0, 1, 8, 9) is rejected', () => {
  // Replace the last char with '0' which is not in A-Z or 2-7
  const invalid = 'C' + 'A'.repeat(54) + '0';
  assert.throws(
    () => validateEnv(baseEnv({ SETTLEMENT_CONTRACT_ID: invalid })),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /CONTRACT_IDS/);
      return true;
    },
  );
});

test('#910: error message names the invalid contract IDs', () => {
  const bad1 = 'BAD_ID_1';
  const bad2 = 'BAD_ID_2';
  assert.throws(
    () => validateEnv(baseEnv({ CONTRACT_IDS: `${bad1},${bad2}` })),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, new RegExp(bad1));
      assert.match(error.message, new RegExp(bad2));
      return true;
    },
  );
});
