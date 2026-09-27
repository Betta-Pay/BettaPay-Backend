import test from 'node:test';
import assert from 'node:assert';
import { validateStellarAddress } from '../index.js';

// Known valid Ed25519 public keys for testing (checksummed G... addresses)
const VALID_MAINNET_KEY = 'GCCTLHSAZTFDGPG4IT4HHGOUFHSX6K4VUEKXCGWP2ZWG2U3FUO4HOAZO';
const VALID_TESTNET_KEY = 'GB6UADKLRL4KUSVDWRL5Z37JW4C3NIICHDEODRCNOO3J7OLIUB3RPIFC';

test('validateStellarAddress — valid keys', async (t) => {
  await t.test('returns true for a valid mainnet public key', () => {
    assert.strictEqual(validateStellarAddress(VALID_MAINNET_KEY), true);
  });

  await t.test('returns true for a valid testnet public key', () => {
    assert.strictEqual(validateStellarAddress(VALID_TESTNET_KEY), true);
  });
});

test('validateStellarAddress — invalid formats', async (t) => {
  await t.test('returns false for a secret key (S... prefix)', () => {
    // Secret keys start with S, not G — should never be used as an address
    const secretKey = 'SCZANGBA5YPROBQMXU6WXS7BQNIKMOSQLJP4TPNLZKU7MQM7FNNFHSK';
    assert.strictEqual(validateStellarAddress(secretKey), false);
  });

  await t.test('returns false for the string "invalid"', () => {
    assert.strictEqual(validateStellarAddress('invalid'), false);
  });

  await t.test('returns false for a key with wrong prefix (A...)', () => {
    assert.strictEqual(validateStellarAddress('A' + 'A'.repeat(55)), false);
  });

  await t.test('returns false for G followed by 55 A characters (wrong checksum)', () => {
    assert.strictEqual(validateStellarAddress('G' + 'A'.repeat(55)), false);
  });

  await t.test('returns false for a key that is too short', () => {
    assert.strictEqual(validateStellarAddress('GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH'), false);
  });

  await t.test('returns false for a key that is too long', () => {
    assert.strictEqual(validateStellarAddress(VALID_MAINNET_KEY + 'AAAA'), false);
  });

  await t.test('returns false for a key containing non-base32 characters', () => {
    // Base32 alphabet excludes 0, 1, 8, 9 — insert an invalid char
    const withInvalidChar = 'G0AZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN';
    assert.strictEqual(validateStellarAddress(withInvalidChar), false);
  });

  await t.test('returns false for a key with a lowercase character', () => {
    const withLower = VALID_MAINNET_KEY.toLowerCase();
    assert.strictEqual(validateStellarAddress(withLower), false);
  });

  await t.test('returns false for a key with whitespace padding', () => {
    assert.strictEqual(validateStellarAddress(' ' + VALID_MAINNET_KEY), false);
    assert.strictEqual(validateStellarAddress(VALID_MAINNET_KEY + ' '), false);
  });
});

test('validateStellarAddress — edge cases', async (t) => {
  await t.test('returns false for an empty string', () => {
    assert.strictEqual(validateStellarAddress(''), false);
  });

  await t.test('returns false for a single character G', () => {
    assert.strictEqual(validateStellarAddress('G'), false);
  });

  await t.test('does not throw for null cast through any', () => {
    assert.doesNotThrow(() => validateStellarAddress(null as any));
    assert.strictEqual(validateStellarAddress(null as any), false);
  });

  await t.test('does not throw for undefined cast through any', () => {
    assert.doesNotThrow(() => validateStellarAddress(undefined as any));
    assert.strictEqual(validateStellarAddress(undefined as any), false);
  });

  await t.test('does not throw for a number cast through any', () => {
    assert.doesNotThrow(() => validateStellarAddress(12345 as any));
    assert.strictEqual(validateStellarAddress(12345 as any), false);
  });

  await t.test('does not throw for an object cast through any', () => {
    assert.doesNotThrow(() => validateStellarAddress({} as any));
    assert.strictEqual(validateStellarAddress({} as any), false);
  });

  await t.test('does not throw for an array cast through any', () => {
    assert.doesNotThrow(() => validateStellarAddress([] as any));
    assert.strictEqual(validateStellarAddress([] as any), false);
  });
});
