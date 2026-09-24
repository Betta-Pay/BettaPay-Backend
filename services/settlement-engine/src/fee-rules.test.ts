import test from 'tape';
import { FeeRule } from '@bettapay/validation';
import { computeSettlementAmounts, resolveVolumeDiscount, type DiscountTier } from './settlement-amounts.js';

// Mirrors the resolution logic in fetchMerchantFeeBps (src/index.ts), without a
// database: given a merchant record, pick settings.feeBps or fall back to default.
function resolveFeeBps(merchant: { settings?: unknown } | null, defaultBps: number): number {
  const parsed = FeeRule.passthrough().safeParse(merchant?.settings);
  return parsed.success ? parsed.data.feeBps : defaultBps;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Basic Fee Resolution Tests (Original Happy Path)
// ═══════════════════════════════════════════════════════════════════════════════

test('a configured feeBps is used', (t) => {
  t.equal(resolveFeeBps({ settings: { feeBps: 75 } }, 100), 75, 'returns the merchant rule');
  t.end();
});

test('a missing merchant falls back to the default', (t) => {
  t.equal(resolveFeeBps(null, 100), 100, 'returns default when no merchant');
  t.end();
});

test('no fee rule falls back to the default', (t) => {
  t.equal(resolveFeeBps({ settings: null }, 100), 100, 'null settings -> default');
  t.equal(resolveFeeBps({ settings: { tier: 'gold' } }, 100), 100, 'settings without feeBps -> default');
  t.end();
});

test('a malformed feeBps falls back to the default', (t) => {
  t.equal(resolveFeeBps({ settings: { feeBps: '75' as unknown as number } }, 100), 100, 'non-number -> default');
  t.end();
});

// ═══════════════════════════════════════════════════════════════════════════════
// Fee Cap Edge Cases (Issue #493)
// ═══════════════════════════════════════════════════════════════════════════════

test('fee cap: maxFeeBps boundary - no discount at threshold', (t) => {
  const tiers: DiscountTier[] = [{ volumeUsd: 10_000, discountBps: 20 }];
  
  // At exactly threshold
  const result = computeSettlementAmounts('1000.00', 100, 10_000, tiers);
  
  t.equal(result.feeSnapshot.maxFeeBpsApplied, 100, 'maxFeeBpsApplied records base rate');
  t.equal(result.feeSnapshot.discountApplied, 20, 'discount applied at threshold');
  t.equal(result.feeSnapshot.feeBpsApplied, 80, 'effective fee = 100 - 20');
  t.equal(result.feeAmount, '8.00', 'fee calculated with discount');
  
  t.end();
});

test('fee cap: maxFeeBps boundary - just below threshold', (t) => {
  const tiers: DiscountTier[] = [{ volumeUsd: 10_000, discountBps: 20 }];
  
  // Just below threshold
  const result = computeSettlementAmounts('1000.00', 100, 9_999, tiers);
  
  t.equal(result.feeSnapshot.maxFeeBpsApplied, 100, 'maxFeeBpsApplied records base rate');
  t.equal(result.feeSnapshot.discountApplied, 0, 'no discount below threshold');
  t.equal(result.feeSnapshot.feeBpsApplied, 100, 'effective fee = base rate');
  t.equal(result.feeAmount, '10.00', 'fee calculated without discount');
  
  t.end();
});

test('fee cap: maxFeeBps boundary - just above threshold', (t) => {
  const tiers: DiscountTier[] = [{ volumeUsd: 10_000, discountBps: 20 }];
  
  // Just above threshold
  const result = computeSettlementAmounts('1000.00', 100, 10_001, tiers);
  
  t.equal(result.feeSnapshot.maxFeeBpsApplied, 100, 'maxFeeBpsApplied records base rate');
  t.equal(result.feeSnapshot.discountApplied, 20, 'discount applied above threshold');
  t.equal(result.feeSnapshot.feeBpsApplied, 80, 'effective fee = 100 - 20');
  t.equal(result.feeAmount, '8.00', 'fee calculated with discount');
  
  t.end();
});

test('fee cap: discount equals base fee (100% discount)', (t) => {
  const tiers: DiscountTier[] = [{ volumeUsd: 50_000, discountBps: 100 }];
  
  // Discount equals base fee - should result in zero fee
  const result = computeSettlementAmounts('1000.00', 100, 50_000, tiers);
  
  t.equal(result.feeSnapshot.maxFeeBpsApplied, 100, 'maxFeeBpsApplied records base rate');
  t.equal(result.feeSnapshot.discountApplied, 100, 'full discount applied');
  t.equal(result.feeSnapshot.feeBpsApplied, 0, 'effective fee clamped to 0');
  t.equal(result.feeAmount, '0.00', 'zero fee when discount = base');
  t.equal(result.netAmount, '1000.00', 'net equals gross with zero fee');
  
  t.end();
});

test('fee cap: discount exceeds base fee (clamped to zero)', (t) => {
  const tiers: DiscountTier[] = [{ volumeUsd: 100_000, discountBps: 150 }];
  
  // Discount > base fee - should clamp to zero
  const result = computeSettlementAmounts('1000.00', 100, 100_000, tiers);
  
  t.equal(result.feeSnapshot.maxFeeBpsApplied, 100, 'maxFeeBpsApplied records base rate');
  t.equal(result.feeSnapshot.discountApplied, 100, 'discount clamped to maxFeeBps');
  t.equal(result.feeSnapshot.feeBpsApplied, 0, 'effective fee clamped to 0');
  t.equal(result.feeAmount, '0.00', 'zero fee when discount > base');
  t.equal(result.netAmount, '1000.00', 'net equals gross with zero fee');
  
  t.end();
});

test('fee cap: multiple tiers - highest matching tier wins', (t) => {
  const tiers: DiscountTier[] = [
    { volumeUsd: 10_000, discountBps: 10 },
    { volumeUsd: 50_000, discountBps: 25 },
    { volumeUsd: 100_000, discountBps: 50 },
  ];
  
  // Volume qualifies for middle tier
  const result = computeSettlementAmounts('1000.00', 200, 75_000, tiers);
  
  t.equal(result.feeSnapshot.maxFeeBpsApplied, 200, 'maxFeeBpsApplied records base rate');
  t.equal(result.feeSnapshot.discountApplied, 25, 'middle tier discount applied');
  t.equal(result.feeSnapshot.feeBpsApplied, 175, 'effective fee = 200 - 25');
  t.equal(result.feeAmount, '17.50', 'fee calculated with middle tier discount');
  
  t.end();
});

test('fee cap: multiple tiers - highest tier wins', (t) => {
  const tiers: DiscountTier[] = [
    { volumeUsd: 10_000, discountBps: 10 },
    { volumeUsd: 50_000, discountBps: 25 },
    { volumeUsd: 100_000, discountBps: 50 },
  ];
  
  // Volume qualifies for highest tier
  const result = computeSettlementAmounts('1000.00', 200, 150_000, tiers);
  
  t.equal(result.feeSnapshot.maxFeeBpsApplied, 200, 'maxFeeBpsApplied records base rate');
  t.equal(result.feeSnapshot.discountApplied, 50, 'highest tier discount applied');
  t.equal(result.feeSnapshot.feeBpsApplied, 150, 'effective fee = 200 - 50');
  t.equal(result.feeAmount, '15.00', 'fee calculated with highest tier discount');
  
  t.end();
});

test('fee cap: zero volume - no discount', (t) => {
  const tiers: DiscountTier[] = [{ volumeUsd: 10_000, discountBps: 20 }];
  
  const result = computeSettlementAmounts('1000.00', 100, 0, tiers);
  
  t.equal(result.feeSnapshot.maxFeeBpsApplied, 100, 'maxFeeBpsApplied records base rate');
  t.equal(result.feeSnapshot.discountApplied, 0, 'no discount with zero volume');
  t.equal(result.feeSnapshot.feeBpsApplied, 100, 'effective fee = base rate');
  t.equal(result.feeAmount, '10.00', 'full fee without discount');
  
  t.end();
});

test('fee cap: negative volume - no discount', (t) => {
  const tiers: DiscountTier[] = [{ volumeUsd: 10_000, discountBps: 20 }];
  
  const result = computeSettlementAmounts('1000.00', 100, -5_000, tiers);
  
  t.equal(result.feeSnapshot.maxFeeBpsApplied, 100, 'maxFeeBpsApplied records base rate');
  t.equal(result.feeSnapshot.discountApplied, 0, 'no discount with negative volume');
  t.equal(result.feeSnapshot.feeBpsApplied, 100, 'effective fee = base rate');
  t.equal(result.feeAmount, '10.00', 'full fee without discount');
  
  t.end();
});

test('fee cap: empty tiers array - no discount', (t) => {
  const result = computeSettlementAmounts('1000.00', 100, 50_000, []);
  
  t.equal(result.feeSnapshot.maxFeeBpsApplied, 100, 'maxFeeBpsApplied records base rate');
  t.equal(result.feeSnapshot.discountApplied, 0, 'no discount with empty tiers');
  t.equal(result.feeSnapshot.feeBpsApplied, 100, 'effective fee = base rate');
  t.equal(result.feeAmount, '10.00', 'full fee without discount');
  
  t.end();
});

test('fee cap: high base fee with large discount', (t) => {
  const tiers: DiscountTier[] = [{ volumeUsd: 100_000, discountBps: 900 }];
  
  // 10% base fee with 9% discount = 1% effective
  const result = computeSettlementAmounts('1000.00', 1000, 100_000, tiers);
  
  t.equal(result.feeSnapshot.maxFeeBpsApplied, 1000, 'maxFeeBpsApplied = 10%');
  t.equal(result.feeSnapshot.discountApplied, 900, 'discount = 9%');
  t.equal(result.feeSnapshot.feeBpsApplied, 100, 'effective fee = 1%');
  t.equal(result.feeAmount, '10.00', 'fee reduced from 100 to 10');
  t.equal(result.netAmount, '990.00', 'net correctly calculated');
  
  t.end();
});

test('fee cap: precision preserved with discount', (t) => {
  const tiers: DiscountTier[] = [{ volumeUsd: 10_000, discountBps: 15 }];
  
  // Test with 6 decimal places
  const result = computeSettlementAmounts('123.456789', 100, 10_000, tiers);
  
  t.equal(result.feeSnapshot.maxFeeBpsApplied, 100, 'maxFeeBpsApplied records base rate');
  t.equal(result.feeSnapshot.discountApplied, 15, 'discount applied');
  t.equal(result.feeSnapshot.feeBpsApplied, 85, 'effective fee = 85 bps');
  t.equal(result.feeAmount.split('.')[1]?.length || 0, 6, 'fee has 6 decimal places');
  t.equal(result.netAmount.split('.')[1]?.length || 0, 6, 'net has 6 decimal places');
  
  t.end();
});

test('fee cap: tier at zero volume threshold', (t) => {
  const tiers: DiscountTier[] = [
    { volumeUsd: 0, discountBps: 5 },
    { volumeUsd: 10_000, discountBps: 20 },
  ];
  
  // Even $1 should get the base discount
  const result = computeSettlementAmounts('1000.00', 100, 1, tiers);
  
  t.equal(result.feeSnapshot.discountApplied, 5, 'base tier discount applied for any positive volume');
  t.equal(result.feeSnapshot.feeBpsApplied, 95, 'effective fee includes base discount');
  
  t.end();
});

test('fee cap: unsorted tiers are handled correctly', (t) => {
  // Tiers provided in wrong order - implementation should handle this
  const tiers: DiscountTier[] = [
    { volumeUsd: 50_000, discountBps: 25 },
    { volumeUsd: 100_000, discountBps: 50 },
    { volumeUsd: 10_000, discountBps: 10 },
  ];
  
  const result = computeSettlementAmounts('1000.00', 200, 75_000, tiers);
  
  t.equal(result.feeSnapshot.discountApplied, 25, 'correct tier selected despite unsorted order');
  t.equal(result.feeSnapshot.feeBpsApplied, 175, 'effective fee calculated correctly');
  
  t.end();
});

test('fee cap: very small amounts with discount', (t) => {
  const tiers: DiscountTier[] = [{ volumeUsd: 10_000, discountBps: 20 }];
  
  const result = computeSettlementAmounts('0.01', 100, 10_000, tiers);
  
  t.equal(result.feeSnapshot.discountApplied, 20, 'discount applied to small amounts');
  t.equal(result.feeSnapshot.feeBpsApplied, 80, 'effective fee = 80 bps');
  t.ok(result.feeAmount <= result.grossAmount, 'fee never exceeds gross');
  
  t.end();
});

test('fee cap: feeSnapshot correctness - all fields populated', (t) => {
  const tiers: DiscountTier[] = [{ volumeUsd: 25_000, discountBps: 30 }];
  
  const result = computeSettlementAmounts('5000.00', 150, 30_000, tiers);
  
  t.equal(typeof result.feeSnapshot.feeBpsApplied, 'number', 'feeBpsApplied is a number');
  t.equal(typeof result.feeSnapshot.maxFeeBpsApplied, 'number', 'maxFeeBpsApplied is a number');
  t.equal(typeof result.feeSnapshot.discountApplied, 'number', 'discountApplied is a number');
  t.equal(typeof result.feeSnapshot.monthlyVolumeAtTime, 'number', 'monthlyVolumeAtTime is a number');
  t.equal(typeof result.feeSnapshot.feeVersion, 'string', 'feeVersion is a string');
  
  t.equal(result.feeSnapshot.feeBpsApplied, 120, 'feeBpsApplied = 150 - 30');
  t.equal(result.feeSnapshot.maxFeeBpsApplied, 150, 'maxFeeBpsApplied = base rate');
  t.equal(result.feeSnapshot.discountApplied, 30, 'discountApplied = 30');
  t.equal(result.feeSnapshot.monthlyVolumeAtTime, 30_000, 'monthlyVolumeAtTime recorded');
  t.equal(result.feeSnapshot.feeVersion, '1.0', 'feeVersion set');
  
  t.end();
});

// ═══════════════════════════════════════════════════════════════════════════════
// Volume Discount Resolution Tests
// ═══════════════════════════════════════════════════════════════════════════════

test('resolveVolumeDiscount: empty tiers returns 0', (t) => {
  t.equal(resolveVolumeDiscount(50_000, []), 0, 'no tiers = no discount');
  t.end();
});

test('resolveVolumeDiscount: zero volume returns 0', (t) => {
  const tiers: DiscountTier[] = [{ volumeUsd: 10_000, discountBps: 20 }];
  t.equal(resolveVolumeDiscount(0, tiers), 0, 'zero volume = no discount');
  t.end();
});

test('resolveVolumeDiscount: negative volume returns 0', (t) => {
  const tiers: DiscountTier[] = [{ volumeUsd: 10_000, discountBps: 20 }];
  t.equal(resolveVolumeDiscount(-1000, tiers), 0, 'negative volume = no discount');
  t.end();
});

test('resolveVolumeDiscount: volume below all tiers returns 0', (t) => {
  const tiers: DiscountTier[] = [
    { volumeUsd: 10_000, discountBps: 10 },
    { volumeUsd: 50_000, discountBps: 25 },
  ];
  t.equal(resolveVolumeDiscount(5_000, tiers), 0, 'below all thresholds = no discount');
  t.end();
});

test('resolveVolumeDiscount: volume at lowest tier', (t) => {
  const tiers: DiscountTier[] = [
    { volumeUsd: 10_000, discountBps: 10 },
    { volumeUsd: 50_000, discountBps: 25 },
  ];
  t.equal(resolveVolumeDiscount(10_000, tiers), 10, 'at threshold = tier discount');
  t.end();
});

test('resolveVolumeDiscount: volume between tiers', (t) => {
  const tiers: DiscountTier[] = [
    { volumeUsd: 10_000, discountBps: 10 },
    { volumeUsd: 50_000, discountBps: 25 },
  ];
  t.equal(resolveVolumeDiscount(30_000, tiers), 10, 'between tiers = lower tier discount');
  t.end();
});

test('resolveVolumeDiscount: volume at highest tier', (t) => {
  const tiers: DiscountTier[] = [
    { volumeUsd: 10_000, discountBps: 10 },
    { volumeUsd: 50_000, discountBps: 25 },
    { volumeUsd: 100_000, discountBps: 50 },
  ];
  t.equal(resolveVolumeDiscount(100_000, tiers), 50, 'at highest threshold = highest discount');
  t.end();
});

test('resolveVolumeDiscount: volume exceeds highest tier', (t) => {
  const tiers: DiscountTier[] = [
    { volumeUsd: 10_000, discountBps: 10 },
    { volumeUsd: 100_000, discountBps: 50 },
  ];
  t.equal(resolveVolumeDiscount(500_000, tiers), 50, 'above highest = highest discount');
  t.end();
});
