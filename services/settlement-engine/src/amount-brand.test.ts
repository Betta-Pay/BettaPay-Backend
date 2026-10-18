/**
 * amount-brand.test.ts (issue #871)
 *
 * The Amount brand's parse/format contract: isAmount accepts only unsigned
 * decimal strings, parseAmount rejects everything else, and settlement
 * formatting preserves exact decimal places while never over-charging.
 */
import test from 'tape';
import { isAmount, parseAmount, AMOUNT_PATTERN } from '@bettapay/shared-types';
import { validateAmountPrecision, ASSET_DECIMALS } from '@bettapay/validation';
import {
  computeSettlementAmounts,
  getMaxSettlementAmountForAsset,
  SettlementAmountError,
  MAX_SETTLEMENT_AMOUNT,
} from './settlement-amounts.js';

test('#871: isAmount accepts unsigned decimal strings', (t) => {
  t.ok(isAmount('0'), 'zero');
  t.ok(isAmount('1'), 'whole number');
  t.ok(isAmount('1500.50'), 'decimal string');
  t.ok(isAmount('0.0000001'), 'seven decimal places');
  t.notOk(isAmount(''), 'empty string');
  t.notOk(isAmount('1.2.3'), 'two decimal points');
  t.notOk(isAmount('-1'), 'negative');
  t.notOk(isAmount('1e5'), 'scientific notation');
  t.notOk(isAmount(' 1'), 'leading whitespace');
  t.notOk(isAmount('1.'), 'trailing decimal point');
  t.notOk(isAmount('.5'), 'leading decimal point');
  t.notOk(isAmount(1 as unknown), 'non-string');
  t.notOk(isAmount(null), 'null');
  t.end();
});

test('#871: parseAmount returns the branded value or throws', (t) => {
  const amount = parseAmount('1500.50');
  t.equal(amount, '1500.50', 'returns the exact input string');
  t.ok(AMOUNT_PATTERN.test(amount), 'result matches the documented pattern');

  t.throws(
    () => parseAmount('not-a-number'),
    TypeError,
    'invalid input throws TypeError',
  );
  t.throws(() => parseAmount('-1.5'), TypeError, 'negative throws');
  t.throws(() => parseAmount(''), TypeError, 'empty throws');
  t.end();
});

test('#871: validateAmountPrecision enforces per-asset decimal places', (t) => {
  t.equal(ASSET_DECIMALS.USDC, 7, 'USDC documented at 7 decimals');
  t.ok(validateAmountPrecision('1.1234567', 'USDC'), 'USDC at exactly 7 decimals');
  t.notOk(validateAmountPrecision('1.12345678', 'USDC'), 'USDC with 8 decimals rejected');
  t.ok(validateAmountPrecision('100', 'USDC'), 'integer needs no decimals allowance');
  t.notOk(validateAmountPrecision('1.23', 'BTC'), 'unknown asset rejected');
  t.end();
});

test('#871: settlement amounts preserve gross and split fee+net exactly', (t) => {
  const result = computeSettlementAmounts('100.123456', 100);
  t.equal(result.grossAmount, '100.123456', 'gross is the exact original string');
  t.equal(result.feeAmount, '1.001234', 'fee rounded DOWN at input precision');
  t.equal(result.netAmount, '99.122222', 'net = gross - fee');

  const sum = Number(result.feeAmount) + Number(result.netAmount);
  t.ok(Math.abs(sum - 100.123456) < 1e-9, 'fee + net reconstruct the gross');
  t.end();
});

test('#871: zero-fee settlements keep the full amount as net', (t) => {
  const result = computeSettlementAmounts('42.50', 0);
  t.equal(result.feeAmount, '0.00', 'zero fee formatted at input precision');
  t.equal(result.netAmount, '42.50', 'net equals gross');
  t.equal(result.feeSnapshot.feeBpsApplied, 0, 'snapshot records zero applied bps');
  t.end();
});

test('#871: amounts above the settlement cap are rejected', (t) => {
  t.equal(
    getMaxSettlementAmountForAsset(),
    MAX_SETTLEMENT_AMOUNT,
    'no asset falls back to the legacy absolute cap',
  );
  t.equal(
    getMaxSettlementAmountForAsset('NOTAREALASSET'),
    MAX_SETTLEMENT_AMOUNT,
    'unknown asset falls back rather than lowering/raising the limit',
  );
  t.throws(
    () => computeSettlementAmounts('99999999999999999999', 100),
    SettlementAmountError,
    'over-cap settlement throws',
  );
  t.end();
});

test('#871: volume discounts are clamped and never produce a negative fee', (t) => {
  const tiers = [{ volumeUsd: 10_000, discountBps: 10 }];
  const result = computeSettlementAmounts('500.00', 100, 15_000, tiers);
  t.equal(result.feeSnapshot.discountApplied, 10, 'discount applied');
  t.equal(result.feeSnapshot.feeBpsApplied, 90, 'effective bps reduced');
  t.equal(result.feeAmount, '4.50', 'discounted fee');

  const overclamp = computeSettlementAmounts('500.00', 5, 15_000, tiers);
  t.ok(overclamp.feeSnapshot.feeBpsApplied >= 0, 'effective bps clamped at zero');
  t.ok(Number(overclamp.feeAmount) >= 0, 'fee never negative');
  t.end();
});
