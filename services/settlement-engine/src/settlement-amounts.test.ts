/**
 * settlement-amounts.test.ts
 *
 * Unit tests for volume-based fee discount logic (#323).
 * Covers resolveVolumeDiscount() and computeSettlementAmounts() with tiers.
 *
 * Acceptance criteria:
 * - $15 K monthly volume, tier at $10 K / 10 bps → effective fee = base − 10 bps
 * - $5 K volume (below every tier) → no discount applied
 * - discount exceeding feeBps → effective fee clamped to 0
 * - feeSnapshot correctly records discountApplied and monthlyVolumeAtTime
 */

import test from 'tape';
import { computeSettlementAmounts, resolveVolumeDiscount, FEE_VERSION } from './settlement-amounts.js';
import type { DiscountTier } from './settlement-amounts.js';
import { assertSettlementInvariants } from './settlement-properties.js';

// ─── resolveVolumeDiscount ───────────────────────────────────────────────────

test('resolveVolumeDiscount: returns 0 with empty tier list', (t) => {
  t.equal(resolveVolumeDiscount(50_000, []), 0, 'no tiers = no discount');
  t.end();
});

test('resolveVolumeDiscount: returns 0 when volume is 0', (t) => {
  const tiers: DiscountTier[] = [{ volumeUsd: 10_000, discountBps: 10 }];
  t.equal(resolveVolumeDiscount(0, tiers), 0, 'zero volume = no discount');
  t.end();
});

test('resolveVolumeDiscount: returns 0 when volume is below all tiers', (t) => {
  const tiers: DiscountTier[] = [{ volumeUsd: 10_000, discountBps: 10 }];
  t.equal(resolveVolumeDiscount(5_000, tiers), 0, '$5 K < $10 K threshold → no discount');
  t.end();
});

test('resolveVolumeDiscount: matches tier exactly at threshold boundary', (t) => {
  const tiers: DiscountTier[] = [{ volumeUsd: 10_000, discountBps: 10 }];
  t.equal(resolveVolumeDiscount(10_000, tiers), 10, '$10 K = threshold → 10 bps discount');
  t.end();
});

test('resolveVolumeDiscount: matches highest applicable tier', (t) => {
  const tiers: DiscountTier[] = [
    { volumeUsd: 10_000, discountBps: 10 },
    { volumeUsd: 50_000, discountBps: 25 },
  ];
  // $15 K is >= $10 K but < $50 K → should get 10 bps tier
  t.equal(resolveVolumeDiscount(15_000, tiers), 10, '$15 K → matches $10 K tier (10 bps)');
  // $60 K is >= $50 K → should get 25 bps tier
  t.equal(resolveVolumeDiscount(60_000, tiers), 25, '$60 K → matches $50 K tier (25 bps)');
  t.end();
});

test('resolveVolumeDiscount: tiers need not be sorted in input', (t) => {
  const tiers: DiscountTier[] = [
    { volumeUsd: 50_000, discountBps: 25 },
    { volumeUsd: 10_000, discountBps: 10 },
  ];
  t.equal(resolveVolumeDiscount(15_000, tiers), 10, 'unsorted tiers: $15 K → $10 K tier');
  t.equal(resolveVolumeDiscount(60_000, tiers), 25, 'unsorted tiers: $60 K → $50 K tier');
  t.end();
});

// ─── computeSettlementAmounts with volume discount ───────────────────────────

test('AC1: $15 K volume, tier at $10 K / 10 bps — fee = base − 10 bps', (t) => {
  // Base feeBps = 100 (1%), discount = 10 bps → effective = 90 bps (0.9%)
  const tiers: DiscountTier[] = [{ volumeUsd: 10_000, discountBps: 10 }];
  const { feeAmount, netAmount, feeSnapshot } = computeSettlementAmounts(
    '1000.00',
    100,
    15_000,
    tiers,
  );

  // effective fee = 1000.00 × 90 / 10000 = 9.00
  t.equal(feeAmount, '9.00',   'fee is 0.9% of 1000 = 9.00 (not 10.00)');
  t.equal(netAmount, '991.00', 'net = 1000 − 9 = 991.00');
  t.equal(feeSnapshot.feeBpsApplied, 90,     'feeBpsApplied reflects discount');
  t.equal(feeSnapshot.maxFeeBpsApplied, 100, 'maxFeeBpsApplied records base rate');
  t.equal(feeSnapshot.discountApplied, 10,   'discountApplied = 10 bps');
  t.equal(feeSnapshot.monthlyVolumeAtTime, 15_000, 'monthlyVolumeAtTime recorded');
  t.end();
});

test('AC2: $5 K volume — no discount applies (below all tiers)', (t) => {
  const tiers: DiscountTier[] = [{ volumeUsd: 10_000, discountBps: 10 }];
  const { feeAmount, netAmount, feeSnapshot } = computeSettlementAmounts(
    '1000.00',
    100,
    5_000,
    tiers,
  );

  // full 100 bps = 10.00 fee
  t.equal(feeAmount, '10.00',  'full base fee applied — no discount');
  t.equal(netAmount, '990.00', 'net = 1000 − 10 = 990.00');
  t.equal(feeSnapshot.feeBpsApplied, 100, 'feeBpsApplied = base feeBps');
  t.equal(feeSnapshot.discountApplied, 0, 'no discount applied');
  t.equal(feeSnapshot.monthlyVolumeAtTime, 5_000, 'monthlyVolumeAtTime recorded');
  t.end();
});

test('AC3: discount exceeds feeBps — effective fee clamped to 0', (t) => {
  // Base feeBps = 50, discount tier = 100 bps → would go negative → clamp to 0
  const tiers: DiscountTier[] = [{ volumeUsd: 1_000, discountBps: 100 }];
  const { feeAmount, netAmount, feeSnapshot } = computeSettlementAmounts(
    '500.00',
    50,
    10_000,
    tiers,
  );

  t.equal(feeAmount, '0.00',   'fee clamped to 0 — discount exceeds base feeBps');
  t.equal(netAmount, '500.00', 'net equals gross when fee is zero');
  t.equal(feeSnapshot.feeBpsApplied, 0,  'effective bps = 0');
  t.equal(feeSnapshot.discountApplied, 50, 'discountApplied capped at base feeBps');
  t.end();
});

test('no tiers provided — falls back to base feeBps (backward compat)', (t) => {
  const { feeAmount, feeSnapshot } = computeSettlementAmounts('1000.00', 100);
  t.equal(feeAmount, '10.00',         'standard 1% fee');
  t.equal(feeSnapshot.discountApplied, 0, 'no discount');
  t.equal(feeSnapshot.feeBpsApplied, 100, 'feeBpsApplied = base');
  t.end();
});

test('feeSnapshot.monthlyVolumeAtTime defaults to 0 when not supplied', (t) => {
  const { feeSnapshot } = computeSettlementAmounts('100.00', 100);
  t.equal(feeSnapshot.monthlyVolumeAtTime, 0, 'defaults to 0');
  t.end();
});

test('invariant: feeAmount + netAmount === grossAmount with volume discount', (t) => {
  const tiers: DiscountTier[] = [{ volumeUsd: 10_000, discountBps: 10 }];
  const { grossAmount, feeAmount, netAmount } = computeSettlementAmounts(
    '9999.123456',
    150,
    25_000,
    tiers,
  );
  const fee = parseFloat(feeAmount);
  const net = parseFloat(netAmount);
  const gross = parseFloat(grossAmount);
  t.ok(
    Math.abs(gross - fee - net) < 1e-9,
    `${gross} − ${fee} − ${net} ≈ 0 (sum invariant holds with discount)`,
  );
  t.end();
});

test('invariant: feeAmount >= 0 with any discount', (t) => {
  const tiers: DiscountTier[] = [{ volumeUsd: 0, discountBps: 99_999 }];
  const { feeAmount, feeSnapshot } = computeSettlementAmounts(
    '1000.000000',
    200,
    1,
    tiers,
  );
  t.ok(parseFloat(feeAmount) >= 0, 'feeAmount never negative');
  t.ok(feeSnapshot.feeBpsApplied >= 0, 'feeBpsApplied never negative');
  t.end();
});

test('runtime invariant: inconsistent settlement math throws', (t) => {
  t.throws(() => {
    assertSettlementInvariants({
      grossAmount: '100.00',
      feeAmount: '10.01',
      netAmount: '89.99',
      feeBps: 100,
    });
  }, /feeAmount \+ netAmount === grossAmount/i, 'invalid settlement math is rejected at runtime');
  t.end();
});

// ─── Existing snapshot tests still hold ──────────────────────────────────────

test('feeSnapshot: no-discount path still records correct snapshot', (t) => {
  const { feeSnapshot } = computeSettlementAmounts('1000', 150);
  t.equal(feeSnapshot.feeBpsApplied,    150, 'feeBpsApplied matches input');
  t.equal(feeSnapshot.maxFeeBpsApplied, 150, 'maxFeeBpsApplied matches input');
  t.equal(feeSnapshot.discountApplied,  0,   'discountApplied is 0');
  t.equal(feeSnapshot.monthlyVolumeAtTime, 0, 'monthlyVolumeAtTime defaults to 0');
  t.equal(feeSnapshot.feeVersion, FEE_VERSION, 'feeVersion is set');
  t.end();
});
