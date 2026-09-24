import test from 'node:test';
import assert from 'node:assert';
import { buildSetOptionsOp, validateStellarAddress, toStellarAmount, fromStellarAmount } from './index.js';

const VALID_KEY = 'GCCTLHSAZTFDGPG4IT4HHGOUFHSX6K4VUEKXCGWP2ZWG2U3FUO4HOAZO';

test('toStellarAmount', async (t) => {
  await t.test('converts an integer string to stroops', () => {
    assert.strictEqual(toStellarAmount('1'), '10000000');
  });

  await t.test('converts a decimal string to stroops', () => {
    assert.strictEqual(toStellarAmount('1.5'), '15000000');
  });

  await t.test('converts zero to stroops', () => {
    assert.strictEqual(toStellarAmount('0'), '0');
  });

  await t.test('converts a fractional-only decimal correctly', () => {
    assert.strictEqual(toStellarAmount('0.0000001'), '1');
  });

  await t.test('handles a multi-digit amount with decimals', () => {
    assert.strictEqual(toStellarAmount('100.50'), '1005000000');
  });

  await t.test('truncates excess decimal places instead of rounding', () => {
    // 8 decimal digits provided but decimals=7; the 8th digit is dropped
    assert.strictEqual(toStellarAmount('1.00000009'), '10000000');
  });

  await t.test('respects a custom decimals parameter', () => {
    assert.strictEqual(toStellarAmount('1.00', 2), '100');
  });

  await t.test('throws TypeError for an empty string', () => {
    assert.throws(
      () => toStellarAmount(''),
      (err: unknown) => err instanceof TypeError && /toStellarAmount: input must be a valid numeric string/.test((err as TypeError).message),
    );
  });

  await t.test('throws TypeError for a negative number', () => {
    assert.throws(
      () => toStellarAmount('-1'),
      (err: unknown) => err instanceof TypeError && /toStellarAmount: input must be a valid numeric string/.test((err as TypeError).message),
    );
  });

  await t.test('throws TypeError for scientific notation', () => {
    assert.throws(
      () => toStellarAmount('1e10'),
      (err: unknown) => err instanceof TypeError && /toStellarAmount: input must be a valid numeric string/.test((err as TypeError).message),
    );
  });

  await t.test('throws TypeError for a string with leading spaces', () => {
    assert.throws(
      () => toStellarAmount(' 1'),
      (err: unknown) => err instanceof TypeError && /toStellarAmount: input must be a valid numeric string/.test((err as TypeError).message),
    );
  });

  await t.test('throws TypeError for a string with trailing spaces', () => {
    assert.throws(
      () => toStellarAmount('1 '),
      (err: unknown) => err instanceof TypeError && /toStellarAmount: input must be a valid numeric string/.test((err as TypeError).message),
    );
  });

  await t.test('throws TypeError for a string with no digits before the decimal point', () => {
    assert.throws(
      () => toStellarAmount('.5'),
      (err: unknown) => err instanceof TypeError && /toStellarAmount: input must be a valid numeric string/.test((err as TypeError).message),
    );
  });

  await t.test('throws TypeError for a string with no digits after the decimal point', () => {
    assert.throws(
      () => toStellarAmount('1.'),
      (err: unknown) => err instanceof TypeError && /toStellarAmount: input must be a valid numeric string/.test((err as TypeError).message),
    );
  });

  await t.test('throws TypeError for a non-numeric string', () => {
    assert.throws(
      () => toStellarAmount('abc'),
      (err: unknown) => err instanceof TypeError && /toStellarAmount: input must be a valid numeric string/.test((err as TypeError).message),
    );
  });

  await t.test('throws TypeError for a mixed alphanumeric string', () => {
    assert.throws(
      () => toStellarAmount('1a2'),
      (err: unknown) => err instanceof TypeError && /toStellarAmount: input must be a valid numeric string/.test((err as TypeError).message),
    );
  });
});

test('fromStellarAmount', async (t) => {
  await t.test('converts a stroops string to a decimal amount', () => {
    assert.strictEqual(fromStellarAmount('15000000'), '1.5');
    assert.strictEqual(fromStellarAmount('1'), '0.0000001');
  });

  await t.test('handles inputs with leading zeros correctly', () => {
    assert.strictEqual(fromStellarAmount('0015000000'), '1.5');
    assert.strictEqual(fromStellarAmount('000'), '0');
  });

  await t.test('converts zero stroops to zero', () => {
    assert.strictEqual(fromStellarAmount('0'), '0');
  });

  await t.test('handles a large stroops value', () => {
    assert.strictEqual(fromStellarAmount('1000000000000000'), '100000000');
  });

  await t.test('throws TypeError for an empty string', () => {
    assert.throws(
      () => fromStellarAmount(''),
      (err: unknown) => err instanceof TypeError && /fromStellarAmount: input must be a valid integer string/.test((err as TypeError).message),
    );
  });

  await t.test('throws TypeError for a decimal string', () => {
    assert.throws(
      () => fromStellarAmount('100.50'),
      (err: unknown) => err instanceof TypeError && /fromStellarAmount: input must be a valid integer string/.test((err as TypeError).message),
    );
  });

  await t.test('throws TypeError for a negative number string', () => {
    assert.throws(
      () => fromStellarAmount('-1'),
      (err: unknown) => err instanceof TypeError && /fromStellarAmount: input must be a valid integer string/.test((err as TypeError).message),
    );
  });

  await t.test('throws TypeError for a non-numeric string', () => {
    assert.throws(
      () => fromStellarAmount('abc'),
      (err: unknown) => err instanceof TypeError && /fromStellarAmount: input must be a valid integer string/.test((err as TypeError).message),
    );
  });

  await t.test('throws TypeError for a mixed alphanumeric string', () => {
    assert.throws(
      () => fromStellarAmount('1a2b3c'),
      (err: unknown) => err instanceof TypeError && /fromStellarAmount: input must be a valid integer string/.test((err as TypeError).message),
    );
  });

  await t.test('throws TypeError for a string with leading spaces', () => {
    assert.throws(
      () => fromStellarAmount(' 100'),
      (err: unknown) => err instanceof TypeError && /fromStellarAmount: input must be a valid integer string/.test((err as TypeError).message),
    );
  });

  await t.test('throws TypeError for a string with trailing spaces', () => {
    assert.throws(
      () => fromStellarAmount('100 '),
      (err: unknown) => err instanceof TypeError && /fromStellarAmount: input must be a valid integer string/.test((err as TypeError).message),
    );
  });

  await t.test('respects a custom decimals parameter', () => {
    assert.strictEqual(fromStellarAmount('100', 2), '1');
    assert.strictEqual(fromStellarAmount('105', 2), '1.05');
  });
});

test('validateStellarAddress', async (t) => {
  await t.test('returns true for a valid Ed25519 public key', () => {
    assert.strictEqual(validateStellarAddress(VALID_KEY), true);
  });

  await t.test('returns false for an invalid key', () => {
    assert.strictEqual(validateStellarAddress('INVALID'), false);
    assert.strictEqual(validateStellarAddress(''), false);
  });
});

test('buildSetOptionsOp', async (t) => {
  await t.test('returns a setOptions operation with correct type', () => {
    const op = buildSetOptionsOp({});
    assert.strictEqual(op.type, 'setOptions');
  });

  await t.test('returns null for all fields when called with empty params', () => {
    const op = buildSetOptionsOp({});
    assert.strictEqual(op.masterWeight, null);
    assert.strictEqual(op.lowThreshold, null);
    assert.strictEqual(op.medThreshold, null);
    assert.strictEqual(op.highThreshold, null);
    assert.strictEqual(op.signer, null);
  });

  await t.test('populates provided threshold values', () => {
    const op = buildSetOptionsOp({ masterWeight: 1, lowThreshold: 1, medThreshold: 2, highThreshold: 3 });
    assert.strictEqual(op.masterWeight, 1);
    assert.strictEqual(op.lowThreshold, 1);
    assert.strictEqual(op.medThreshold, 2);
    assert.strictEqual(op.highThreshold, 3);
    assert.strictEqual(op.signer, null);
  });

  await t.test('accepts boundary threshold value 0', () => {
    const op = buildSetOptionsOp({ masterWeight: 0, lowThreshold: 0, medThreshold: 0, highThreshold: 0 });
    assert.strictEqual(op.masterWeight, 0);
    assert.strictEqual(op.lowThreshold, 0);
    assert.strictEqual(op.medThreshold, 0);
    assert.strictEqual(op.highThreshold, 0);
  });

  await t.test('accepts boundary threshold value 255', () => {
    const op = buildSetOptionsOp({ masterWeight: 255, lowThreshold: 255, medThreshold: 255, highThreshold: 255 });
    assert.strictEqual(op.masterWeight, 255);
    assert.strictEqual(op.highThreshold, 255);
  });

  await t.test('throws when masterWeight exceeds 255', () => {
    assert.throws(
      () => buildSetOptionsOp({ masterWeight: 256 }),
      /masterWeight must be an integer between 0 and 255/,
    );
  });

  await t.test('throws when lowThreshold exceeds 255', () => {
    assert.throws(
      () => buildSetOptionsOp({ lowThreshold: 300 }),
      /lowThreshold must be an integer between 0 and 255/,
    );
  });

  await t.test('throws when medThreshold exceeds 255', () => {
    assert.throws(
      () => buildSetOptionsOp({ medThreshold: 256 }),
      /medThreshold must be an integer between 0 and 255/,
    );
  });

  await t.test('throws when highThreshold exceeds 255', () => {
    assert.throws(
      () => buildSetOptionsOp({ highThreshold: 1000 }),
      /highThreshold must be an integer between 0 and 255/,
    );
  });

  await t.test('throws when threshold is negative', () => {
    assert.throws(
      () => buildSetOptionsOp({ masterWeight: -1 }),
      /masterWeight must be an integer between 0 and 255/,
    );
  });

  await t.test('throws when threshold is a non-integer', () => {
    assert.throws(
      () => buildSetOptionsOp({ masterWeight: 1.5 }),
      /masterWeight must be an integer between 0 and 255/,
    );
  });

  await t.test('includes valid signer in returned operation', () => {
    const op = buildSetOptionsOp({ signer: { key: VALID_KEY, weight: 2 } });
    assert.deepStrictEqual(op.signer, { key: VALID_KEY, weight: 2 });
  });

  await t.test('accepts signer weight of 0 (revoke signing authority)', () => {
    const op = buildSetOptionsOp({ signer: { key: VALID_KEY, weight: 0 } });
    assert.strictEqual(op.signer?.weight, 0);
  });

  await t.test('accepts signer weight of 255', () => {
    const op = buildSetOptionsOp({ signer: { key: VALID_KEY, weight: 255 } });
    assert.strictEqual(op.signer?.weight, 255);
  });

  await t.test('throws when signer key is invalid', () => {
    assert.throws(
      () => buildSetOptionsOp({ signer: { key: 'NOTAKEY', weight: 1 } }),
      /signer.key must be a valid Stellar address/,
    );
  });

  await t.test('throws when signer weight exceeds 255', () => {
    assert.throws(
      () => buildSetOptionsOp({ signer: { key: VALID_KEY, weight: 256 } }),
      /signer.weight must be an integer between 0 and 255/,
    );
  });

  await t.test('throws when signer weight is negative', () => {
    assert.throws(
      () => buildSetOptionsOp({ signer: { key: VALID_KEY, weight: -1 } }),
      /signer.weight must be an integer between 0 and 255/,
    );
  });

  await t.test('throws when signer weight is non-integer', () => {
    assert.throws(
      () => buildSetOptionsOp({ signer: { key: VALID_KEY, weight: 1.7 } }),
      /signer.weight must be an integer between 0 and 255/,
    );
  });

  await t.test('combines thresholds and signer correctly', () => {
    const op = buildSetOptionsOp({
      masterWeight: 1,
      lowThreshold: 1,
      medThreshold: 2,
      highThreshold: 3,
      signer: { key: VALID_KEY, weight: 1 },
    });
    assert.strictEqual(op.type, 'setOptions');
    assert.strictEqual(op.masterWeight, 1);
    assert.strictEqual(op.lowThreshold, 1);
    assert.strictEqual(op.medThreshold, 2);
    assert.strictEqual(op.highThreshold, 3);
    assert.deepStrictEqual(op.signer, { key: VALID_KEY, weight: 1 });
  });
});
