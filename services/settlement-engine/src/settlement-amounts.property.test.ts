/**
 * settlement-amounts.property.test.ts
 *
 * Property-based tests for computeSettlementAmounts() using fast-check.
 * These assert invariants that must hold for all valid monetary strings and
 * feeBps in [0, 10000], complementing the example-based suite in
 * settlement-precision.test.ts.
 *
 * Regression signal: replacing ROUND_DOWN with ROUND_UP in fee.toFixed(...)
 * (or relying on ROUND_HALF_UP) causes the never-overcharge property to fail.
 */

import test from 'tape';
import fc from 'fast-check';
import BigNumber from 'bignumber.js';
import { computeSettlementAmounts, SettlementAmountError, MAX_SETTLEMENT_AMOUNT, getMaxSettlementAmountForAsset, FEE_VERSION } from './settlement-amounts.js';

/** Count decimal places in a monetary string (0 when there is no fractional part). */
function decimalPlaces(amount: string): number {
  return (amount.split('.')[1] ?? '').length;
}

/**
 * Valid non-negative monetary strings: integer part up to 9 digits, optional
 * fractional part of 1–6 digits (covers USDC-style precision and integers).
 */
const monetaryAmountArb: fc.Arbitrary<string> = fc
  .tuple(
    fc.integer({ min: 0, max: 999_999_999 }),
    fc.integer({ min: 0, max: 6 })
  )
  .chain(([intPart, decimals]) => {
    if (decimals === 0) {
      return fc.constant(String(intPart));
    }
    const maxFrac = 10 ** decimals - 1;
    return fc.integer({ min: 0, max: maxFrac }).map((frac) => {
      const fracStr = String(frac).padStart(decimals, '0');
      return `${intPart}.${fracStr}`;
    });
  });

const feeBpsArb = fc.integer({ min: 0, max: 10_000 });

const settlementInputArb = fc.tuple(monetaryAmountArb, feeBpsArb);

test('property: feeAmount + netAmount === grossAmount for all inputs', (t) => {
  t.plan(1);
  t.doesNotThrow(() => {
    fc.assert(
      fc.property(settlementInputArb, ([gross, feeBps]) => {
        const { grossAmount, feeAmount, netAmount } = computeSettlementAmounts(gross, feeBps);
        const sum = new BigNumber(feeAmount).plus(netAmount);
        return sum.isEqualTo(grossAmount);
      }),
      { numRuns: 200 }
    );
  });
});

test('property: feeAmount >= 0 and netAmount <= grossAmount', (t) => {
  t.plan(1);
  t.doesNotThrow(() => {
    fc.assert(
      fc.property(settlementInputArb, ([gross, feeBps]) => {
        const { feeAmount, netAmount, grossAmount } = computeSettlementAmounts(gross, feeBps);
        const fee = new BigNumber(feeAmount);
        const net = new BigNumber(netAmount);
        const g = new BigNumber(grossAmount);
        return fee.isGreaterThanOrEqualTo(0) && net.isLessThanOrEqualTo(g);
      }),
      { numRuns: 200 }
    );
  });
});

test('property: feeAmount has at most the same decimal places as grossAmount', (t) => {
  t.plan(1);
  t.doesNotThrow(() => {
    fc.assert(
      fc.property(settlementInputArb, ([gross, feeBps]) => {
        const { feeAmount, grossAmount } = computeSettlementAmounts(gross, feeBps);
        return decimalPlaces(feeAmount) <= decimalPlaces(grossAmount);
      }),
      { numRuns: 200 }
    );
  });
});

test('property: feeBps === 0 yields a zero fee matching input decimal places', (t) => {
  t.plan(1);
  t.doesNotThrow(() => {
    fc.assert(
      fc.property(monetaryAmountArb, (gross) => {
        const { feeAmount } = computeSettlementAmounts(gross, 0);
        const decimals = decimalPlaces(gross);
        const expected =
          decimals === 0 ? '0' : `0.${'0'.repeat(decimals)}`;
        return feeAmount === expected && new BigNumber(feeAmount).isZero();
      }),
      { numRuns: 100 }
    );
  });
});

test('property: ROUND_DOWN never overcharges (fee <= exact gross × bps / 10000)', (t) => {
  t.plan(1);
  t.doesNotThrow(() => {
    fc.assert(
      fc.property(settlementInputArb, ([gross, feeBps]) => {
        const { feeAmount } = computeSettlementAmounts(gross, feeBps);
        const exact = new BigNumber(gross).multipliedBy(feeBps).dividedBy(10_000);
        return new BigNumber(feeAmount).isLessThanOrEqualTo(exact);
      }),
      { numRuns: 200 }
    );
  });
});

// ─── MAX_SETTLEMENT_AMOUNT boundary tests ────────────────────────────────────

test('Amount = MAX_SETTLEMENT_AMOUNT is allowed', (t) => {
  t.plan(1);
  t.doesNotThrow(() => {
    computeSettlementAmounts(MAX_SETTLEMENT_AMOUNT, 100);
  }, 'MAX_SETTLEMENT_AMOUNT (10^15) should be allowed');
});

test('Amount = MAX_SETTLEMENT_AMOUNT + 1 throws SettlementAmountError', (t) => {
  t.plan(2);
  const overMax = new BigNumber(MAX_SETTLEMENT_AMOUNT).plus(1).toString();
  t.throws(
    () => computeSettlementAmounts(overMax, 100),
    /exceeds maximum/,
    'Amount > MAX should throw SettlementAmountError',
  );
  t.throws(
    () => computeSettlementAmounts(overMax, 100),
    SettlementAmountError,
    'Error should be instance of SettlementAmountError',
  );
});

test('Amount = 0 is handled gracefully', (t) => {
  t.plan(4);
  t.doesNotThrow(() => {
    const { grossAmount, feeAmount, netAmount } = computeSettlementAmounts('0', 100);
    t.equal(grossAmount, '0', 'gross amount is 0');
    t.equal(feeAmount, '0', 'fee is 0');
    t.equal(netAmount, '0', 'net is 0');
  }, 'Amount 0 should not throw');
});

test('Amount = 0 with various feeBps is handled gracefully', (t) => {
  t.plan(3);
  t.doesNotThrow(() => {
    const r1 = computeSettlementAmounts('0', 0);
    t.equal(r1.feeAmount, '0', 'feeBps=0 → fee=0');

    const r2 = computeSettlementAmounts('0.00', 10000);
    t.equal(r2.feeAmount, '0.00', 'feeBps=10000 → fee=0.00');
  }, 'Zero amounts should not throw for any feeBps');
});

test('Amount = MAX_SETTLEMENT_AMOUNT with trailing-zero decimals is allowed', (t) => {
  t.plan(1);
  t.doesNotThrow(() => {
    // "1000000000000000.000000" is numerically equal to MAX, not greater
    computeSettlementAmounts(`${MAX_SETTLEMENT_AMOUNT}.000000`, 100);
  }, 'MAX with trailing-zero decimals should be allowed (numerically equal to MAX)');
});

test('property: amounts near MAX boundary either pass or correctly throw', (t) => {
  t.plan(1);
  t.doesNotThrow(() => {
    fc.assert(
      fc.property(
        fc.integer({ min: -100, max: 100 }).map((offset) =>
          new BigNumber(MAX_SETTLEMENT_AMOUNT).plus(offset).toString(),
        ),
        (amount) => {
          const bn = new BigNumber(amount);
          if (bn.isNegative()) return true; // skip negative offsets that produce below-zero amounts
          try {
            computeSettlementAmounts(amount, 100);
            // Must not throw → amount must be <= MAX
            return bn.isLessThanOrEqualTo(MAX_SETTLEMENT_AMOUNT);
          } catch (e) {
            // Must throw → amount must be > MAX and error type is correct
            return (
              e instanceof SettlementAmountError &&
              bn.isGreaterThan(MAX_SETTLEMENT_AMOUNT)
            );
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ─── FEE_VERSION constant (#482) ──────────────────────────────────────────

test('FEE_VERSION is a non-empty string matching expected shape', (t) => {
  t.equal(typeof FEE_VERSION, 'string', 'FEE_VERSION is a string');
  t.ok(FEE_VERSION.length > 0, 'FEE_VERSION is non-empty');
  t.ok(/^\d+\.\d+$/.test(FEE_VERSION), 'FEE_VERSION matches semver-like shape (e.g. "1.0")');
  t.end();
});

// ─── Per-asset max settlement amount (#481) ──────────────────────────────

test('getMaxSettlementAmountForAsset: returns legacy max when asset is undefined', (t) => {
  t.equal(getMaxSettlementAmountForAsset(), MAX_SETTLEMENT_AMOUNT, 'undefined asset → legacy max');
  t.end();
});

test('getMaxSettlementAmountForAsset: returns legacy max for unknown asset', (t) => {
  t.equal(getMaxSettlementAmountForAsset('UNKNOWN'), MAX_SETTLEMENT_AMOUNT, 'unknown asset → legacy max');
  t.end();
});

test('getMaxSettlementAmountForAsset: USDC (7 decimals) → 10^15', (t) => {
  const max = getMaxSettlementAmountForAsset('USDC');
  t.equal(max, '1000000000000000', 'USDC max = 10^8 × 10^7 = 10^15');
  t.end();
});

test('getMaxSettlementAmountForAsset: NGN (2 decimals) → 10^10', (t) => {
  const max = getMaxSettlementAmountForAsset('NGN');
  t.equal(max, '10000000000', 'NGN max = 10^8 × 10^2 = 10^10');
  t.end();
});

test('per-asset max: USDC amount at cap is allowed', (t) => {
  t.plan(1);
  const usdcMax = getMaxSettlementAmountForAsset('USDC');
  t.doesNotThrow(() => {
    computeSettlementAmounts(usdcMax, 100, 0, [], 'USDC');
  }, 'USDC at its per-asset max should be allowed');
});

test('per-asset max: NGN amount exceeding per-asset cap throws', (t) => {
  t.plan(2);
  const overMax = new BigNumber(getMaxSettlementAmountForAsset('NGN')).plus(1).toString();
  t.throws(
    () => computeSettlementAmounts(overMax, 100, 0, [], 'NGN'),
    /exceeds maximum/,
    'NGN above its per-asset max should throw',
  );
  t.throws(
    () => computeSettlementAmounts(overMax, 100, 0, [], 'NGN'),
    SettlementAmountError,
    'Error should be instance of SettlementAmountError',
  );
});

test('per-asset max: 7-decimal asset hits stricter cap than legacy', (t) => {
  const usdcMax = new BigNumber(getMaxSettlementAmountForAsset('USDC'));
  const legacyMax = new BigNumber(MAX_SETTLEMENT_AMOUNT);
  t.ok(usdcMax.isEqualTo(legacyMax), 'USDC (7 decimals) max equals legacy max (10^15)');
  const ngnMax = new BigNumber(getMaxSettlementAmountForAsset('NGN'));
  t.ok(ngnMax.isLessThan(legacyMax), 'NGN (2 decimals) max is less than legacy max');
  t.end();
});
