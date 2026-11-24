/**
 * Unit tests for computeSettlementAmounts() asset-specific limits and
 * merchant fee caps (maxFeeBps / maxFeeThreshold).
 */

import test from 'tape';
import BigNumber from 'bignumber.js';
import {
  computeSettlementAmounts,
  computeSettlementAmountsWithSchedule,
  getMaxSettlementAmountForAsset,
  SettlementAmountError,
} from './settlement-amounts.js';
import type { Amount } from '@bettapay/shared-types';

// ─── Asset-specific max settlement amount ────────────────────────────────────

test('asset limit: amount above the NGN cap is rejected when asset is passed', (t) => {
  const overMax = new BigNumber(getMaxSettlementAmountForAsset('NGN')).plus(1).toString();
  t.throws(
    () => computeSettlementAmounts(overMax as Amount, 100, 0, [], 'NGN'),
    SettlementAmountError,
    'over the NGN cap throws SettlementAmountError',
  );
  t.end();
});

test('asset limit: same amount is accepted when asset is omitted (legacy cap)', (t) => {
  const overNgnMax = new BigNumber(getMaxSettlementAmountForAsset('NGN')).plus(1).toString();
  t.doesNotThrow(
    () => computeSettlementAmounts(overNgnMax as Amount, 100),
    'omitting asset bypasses the per-asset cap (why callers must pass it)',
  );
  t.end();
});

test('asset limit: amount at the NGN cap is accepted', (t) => {
  const atMax = getMaxSettlementAmountForAsset('NGN');
  t.doesNotThrow(
    () => computeSettlementAmounts(atMax as Amount, 100, 0, [], 'NGN'),
    'exactly the cap is allowed',
  );
  t.end();
});

test('asset limit: computeSettlementAmountsWithSchedule enforces the asset cap', (t) => {
  const overMax = new BigNumber(getMaxSettlementAmountForAsset('NGN')).plus(1).toString();
  t.throws(
    () => computeSettlementAmountsWithSchedule(overMax as Amount, 'NGN', undefined, 100),
    SettlementAmountError,
    'schedule helper passes asset through',
  );
  t.end();
});

// ─── maxFeeBps ───────────────────────────────────────────────────────────────

test('maxFeeBps: effective rate is capped below the base rate', (t) => {
  const r = computeSettlementAmounts('1000.00' as Amount, 200, 0, [], 'USDC', { maxFeeBps: 50 });
  t.equal(r.feeAmount, '5.00', 'fee = 0.5% of 1000');
  t.equal(r.netAmount, '995.00', 'net = gross - capped fee');
  t.equal(r.feeSnapshot.feeBpsApplied, 50, 'feeBpsApplied reflects the cap');
  t.equal(r.feeSnapshot.maxFeeBpsApplied, 200, 'maxFeeBpsApplied still records base rate');
  t.equal(r.feeSnapshot.capApplied, true, 'capApplied is set');
  t.equal(r.feeSnapshot.uncappedFee, '20.00', 'uncappedFee records the fee before capping');
  t.end();
});

test('maxFeeBps: cap above the effective rate has no effect', (t) => {
  const r = computeSettlementAmounts('1000.00' as Amount, 100, 0, [], 'USDC', { maxFeeBps: 500 });
  t.equal(r.feeAmount, '10.00', 'fee unchanged');
  t.equal(r.feeSnapshot.feeBpsApplied, 100, 'feeBpsApplied unchanged');
  t.equal(r.feeSnapshot.capApplied, undefined, 'capApplied not set');
  t.equal(r.feeSnapshot.uncappedFee, undefined, 'uncappedFee not set');
  t.end();
});

test('maxFeeBps: cap applies after volume discount', (t) => {
  // base 200, discount 20 → 180; cap 150 → 150
  const r = computeSettlementAmounts(
    '1000.00' as Amount,
    200,
    50_000,
    [{ volumeUsd: 10_000, discountBps: 20 }],
    'USDC',
    { maxFeeBps: 150 },
  );
  t.equal(r.feeSnapshot.discountApplied, 20, 'discount applied');
  t.equal(r.feeSnapshot.feeBpsApplied, 150, 'capped below the discounted rate');
  t.equal(r.feeAmount, '15.00', 'fee = 1.5%');
  t.equal(r.feeSnapshot.uncappedFee, '18.00', 'uncapped fee is the discounted fee');
  t.end();
});

test('maxFeeBps: zero cap yields a zero fee', (t) => {
  const r = computeSettlementAmounts('1000.00' as Amount, 100, 0, [], 'USDC', { maxFeeBps: 0 });
  t.equal(r.feeAmount, '0.00', 'zero fee');
  t.equal(r.netAmount, '1000.00', 'net equals gross');
  t.end();
});

// ─── maxFeeThreshold ─────────────────────────────────────────────────────────

test('maxFeeThreshold: absolute fee is capped at the threshold', (t) => {
  const r = computeSettlementAmounts('100000.00' as Amount, 100, 0, [], 'USDC', {
    maxFeeThreshold: '250',
  });
  t.equal(r.feeAmount, '250.00', 'fee capped to 250.00 (uncapped would be 1000.00)');
  t.equal(r.netAmount, '99750.00', 'net = gross - capped fee');
  t.equal(r.feeSnapshot.feeBpsApplied, 100, 'rate itself is unchanged');
  t.equal(r.feeSnapshot.capApplied, true, 'capApplied is set');
  t.equal(r.feeSnapshot.uncappedFee, '1000.00', 'uncappedFee recorded');
  t.end();
});

test('maxFeeThreshold: fee below the threshold is untouched', (t) => {
  const r = computeSettlementAmounts('1000.00' as Amount, 100, 0, [], 'USDC', {
    maxFeeThreshold: '250',
  });
  t.equal(r.feeAmount, '10.00', 'fee unchanged');
  t.equal(r.feeSnapshot.capApplied, undefined, 'capApplied not set');
  t.end();
});

test('maxFeeThreshold: fee exactly at the threshold is not flagged as capped', (t) => {
  const r = computeSettlementAmounts('1000.00' as Amount, 100, 0, [], 'USDC', {
    maxFeeThreshold: '10',
  });
  t.equal(r.feeAmount, '10.00', 'fee equals threshold');
  t.equal(r.feeSnapshot.capApplied, undefined, 'no cap applied at the boundary');
  t.end();
});

test('maxFeeThreshold: threshold is truncated (never rounded up) to input precision', (t) => {
  const r = computeSettlementAmounts('100000.00' as Amount, 100, 0, [], 'USDC', {
    maxFeeThreshold: '250.999',
  });
  t.equal(r.feeAmount, '250.99', 'ROUND_DOWN to 2 decimals');
  t.end();
});

test('maxFeeThreshold: invalid threshold is rejected', (t) => {
  t.throws(
    () => computeSettlementAmounts('1000.00' as Amount, 100, 0, [], 'USDC', { maxFeeThreshold: 'abc' }),
    SettlementAmountError,
    'non-numeric threshold throws',
  );
  t.end();
});

// ─── Both caps together ──────────────────────────────────────────────────────

test('caps: maxFeeBps and maxFeeThreshold apply together; the stricter wins', (t) => {
  // 200 bps of 100000 = 2000; maxFeeBps 100 → 1000; threshold 400 → 400
  const r = computeSettlementAmounts('100000.00' as Amount, 200, 0, [], 'USDC', {
    maxFeeBps: 100,
    maxFeeThreshold: '400',
  });
  t.equal(r.feeAmount, '400.00', 'threshold is the stricter cap');
  t.equal(r.feeSnapshot.feeBpsApplied, 100, 'bps cap recorded');
  t.equal(r.feeSnapshot.uncappedFee, '2000.00', 'uncappedFee is the pre-cap fee');
  t.equal(
    new BigNumber(r.feeAmount).plus(r.netAmount).toFixed(2),
    '100000.00',
    'fee + net === gross',
  );
  t.end();
});

test('caps: omitted caps leave behaviour unchanged', (t) => {
  const a = computeSettlementAmounts('1000.00' as Amount, 100, 0, [], 'USDC');
  const b = computeSettlementAmounts('1000.00' as Amount, 100, 0, [], 'USDC', {});
  t.deepEqual(a, b, 'empty caps object is equivalent to no caps');
  t.end();
});
