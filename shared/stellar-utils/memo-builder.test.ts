/**
 * memo-builder.test.ts (issue #872)
 *
 * buildMemo enforces the 28-byte text limit and the uint64 id range by
 * *rejecting* overflows instead of truncating them.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMemo, validateMemo } from './index.js';

test('buildMemo — text boundaries', async (t) => {
  await t.test('a text memo at exactly 28 bytes is accepted', () => {
    const memo = buildMemo('text', 'x'.repeat(28));
    assert.equal(memo.type, 'text');
    assert.equal(memo.value.length, 28);
  });

  await t.test('a 29-byte text memo is rejected, not truncated', () => {
    const tooLong = 'x'.repeat(29);
    assert.throws(
      () => buildMemo('text', tooLong),
      (err: unknown) =>
        err instanceof TypeError && /Invalid Stellar text memo/.test((err as TypeError).message),
      'throws instead of silently truncating',
    );
    // Sanity: truncating to 28 would have "succeeded" — the builder must not do that.
    assert.ok(!validateMemo('text', tooLong), 'validation agrees the value is invalid');
  });

  await t.test('multi-byte UTF-8 characters are counted by bytes, not code points', () => {
    // "€" is one code point but 3 UTF-8 bytes.
    const nineCodePoints = '€€€';
    assert.equal([...nineCodePoints].length, 3, 'three code points');
    assert.equal(Buffer.byteLength(nineCodePoints, 'utf8'), 9, 'nine bytes');
    assert.deepEqual(buildMemo('text', nineCodePoints), { type: 'text', value: nineCodePoints });

    // Ten "€" = 30 bytes — over the limit despite only 10 code points.
    assert.throws(() => buildMemo('text', '€'.repeat(10)), TypeError, '30 bytes rejected');

    // Nine "€" plus 'x' = 27 + 1 = 28 bytes exactly.
    assert.deepEqual(buildMemo('text', '€€€€€€€€€x'), { type: 'text', value: '€€€€€€€€€x' });
  });
});

test('buildMemo — id boundaries', async (t) => {
  await t.test('integers within the uint64 range are accepted', () => {
    assert.deepEqual(buildMemo('id', '0'), { type: 'id', value: '0' });
    assert.deepEqual(buildMemo('id', '1'), { type: 'id', value: '1' });
    assert.deepEqual(buildMemo('id', '18446744073709551615'), {
      type: 'id',
      value: '18446744073709551615',
    });
  });

  await t.test('out-of-range ids are rejected', () => {
    assert.throws(() => buildMemo('id', '18446744073709551616'), TypeError, 'one past uint64 max');
    assert.throws(() => buildMemo('id', '999999999999999999999999999999'), TypeError, 'far out of range');
  });

  await t.test('non-integer ids are rejected', () => {
    assert.throws(() => buildMemo('id', '1.5'), TypeError, 'decimal');
    assert.throws(() => buildMemo('id', '-1'), TypeError, 'negative');
    assert.throws(() => buildMemo('id', '1e5'), TypeError, 'scientific notation');
    assert.throws(() => buildMemo('id', 'abc'), TypeError, 'non-numeric');
    assert.throws(() => buildMemo('id', ''), TypeError, 'empty');
  });
});

test('buildMemo — selects the correct memo type for each input', async (t) => {
  await t.test('text memos carry type "text"', () => {
    const memo = buildMemo('text', 'invoice-42');
    assert.equal(memo.type, 'text');
    assert.equal(memo.value, 'invoice-42');
  });

  await t.test('id memos carry type "id"', () => {
    const memo = buildMemo('id', '42');
    assert.equal(memo.type, 'id');
    assert.equal(memo.value, '42');
  });

  await t.test('hash memos carry type "hash" and require 64 hex chars', () => {
    const hash = 'a'.repeat(64);
    const memo = buildMemo('hash', hash);
    assert.equal(memo.type, 'hash');
    assert.equal(memo.value, hash);
    assert.throws(() => buildMemo('hash', 'a'.repeat(63)), TypeError);
  });

  await t.test('return memos carry type "return" and require 64 hex chars', () => {
    const hash = 'B'.repeat(64);
    const memo = buildMemo('return', hash);
    assert.equal(memo.type, 'return');
    assert.equal(memo.value, hash);
    assert.throws(() => buildMemo('return', 'zz'), TypeError);
  });
});
