import test from 'node:test';
import assert from 'node:assert/strict';
import { validateMemo } from './index.js';

test('validateMemo — text', async (t) => {
  await t.test('empty string passes', () => {
    assert.equal(validateMemo('text', ''), true);
  });

  await t.test('ASCII string within 28 bytes passes', () => {
    assert.equal(validateMemo('text', 'hello world'), true);
  });

  await t.test('exactly 28 ASCII bytes passes', () => {
    assert.equal(validateMemo('text', 'a'.repeat(28)), true);
  });

  await t.test('29 ASCII bytes fails', () => {
    assert.equal(validateMemo('text', 'a'.repeat(29)), false);
  });

  await t.test('multibyte UTF-8 within 28 bytes passes', () => {
    // '€' is 3 bytes — 9 chars = 27 bytes
    assert.equal(validateMemo('text', '€'.repeat(9)), true);
  });

  await t.test('multibyte UTF-8 exceeding 28 bytes fails', () => {
    // '€' is 3 bytes — 10 chars = 30 bytes
    assert.equal(validateMemo('text', '€'.repeat(10)), false);
  });

  await t.test('rejects a memo containing a null byte', () => {
    assert.equal(validateMemo('text', 'abc\0def'), false);
  });

  await t.test('rejects a memo that is only a null byte', () => {
    assert.equal(validateMemo('text', '\0'), false);
  });

  await t.test('rejects a trailing null byte', () => {
    assert.equal(validateMemo('text', 'invoice-42\0'), false);
  });
});

test('validateMemo — id', async (t) => {
  await t.test('zero passes', () => {
    assert.equal(validateMemo('id', '0'), true);
  });

  await t.test('positive integer passes', () => {
    assert.equal(validateMemo('id', '123456789'), true);
  });

  await t.test('max uint64 passes', () => {
    assert.equal(validateMemo('id', '18446744073709551615'), true);
  });

  await t.test('value above uint64 max fails', () => {
    assert.equal(validateMemo('id', '18446744073709551616'), false);
  });

  await t.test('negative integer fails', () => {
    assert.equal(validateMemo('id', '-1'), false);
  });

  await t.test('decimal fails', () => {
    assert.equal(validateMemo('id', '1.5'), false);
  });

  await t.test('non-numeric string fails', () => {
    assert.equal(validateMemo('id', 'abc'), false);
  });

  await t.test('empty string fails', () => {
    assert.equal(validateMemo('id', ''), false);
  });
});

test('validateMemo — hash', async (t) => {
  await t.test('64 lowercase hex chars passes', () => {
    assert.equal(validateMemo('hash', 'a'.repeat(64)), true);
  });

  await t.test('64 uppercase hex chars passes', () => {
    assert.equal(validateMemo('hash', 'A'.repeat(64)), true);
  });

  await t.test('mixed-case 64 hex chars passes', () => {
    assert.equal(validateMemo('hash', 'aAbBcCdDeEfF'.repeat(4) + '00'.repeat(8)), true);
  });

  await t.test('63 hex chars fails', () => {
    assert.equal(validateMemo('hash', 'a'.repeat(63)), false);
  });

  await t.test('65 hex chars fails', () => {
    assert.equal(validateMemo('hash', 'a'.repeat(65)), false);
  });

  await t.test('64 chars with non-hex character fails', () => {
    assert.equal(validateMemo('hash', 'g'.repeat(64)), false);
  });

  await t.test('empty string fails', () => {
    assert.equal(validateMemo('hash', ''), false);
  });
});

test('validateMemo — return', async (t) => {
  await t.test('64 hex chars passes', () => {
    assert.equal(validateMemo('return', '0'.repeat(64)), true);
  });

  await t.test('63 hex chars fails', () => {
    assert.equal(validateMemo('return', '0'.repeat(63)), false);
  });

  await t.test('invalid chars fails', () => {
    assert.equal(validateMemo('return', 'z'.repeat(64)), false);
  });
});

test('validateMemo — unknown type', async (t) => {
  await t.test('unsupported type returns false', () => {
    assert.equal(validateMemo('none', 'anything'), false);
  });

  await t.test('empty type returns false', () => {
    assert.equal(validateMemo('', 'anything'), false);
  });
});
