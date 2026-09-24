/**
 * settlement-amounts.ts
 *
 * Pure precision-arithmetic helpers for settlement fee calculations.
 * No I/O, no environment dependencies — safe to import in tests.
 *
 * Precision strategy
 * ──────────────────
 * BigNumber.js is used for all arithmetic with ROUND_DOWN to ensure
 * fees are never over-charged due to rounding.  All amounts are
 * returned as full-precision decimal strings, preserving the number
 * of decimal places present in the original input.
 *
 * Volume-based fee discounts (#323)
 * ──────────────────────────────────
 * Callers may supply a `monthlyVolume` (USD gross settled in the current
 * calendar month) and a list of discount tiers.  The highest-matching
 * tier's `discountBps` is subtracted from the base `feeBps`.  The
 * effective fee is clamped to [0, feeBps] so it can never go negative.
 */

import BigNumber from 'bignumber.js';
import type { Amount } from '@bettapay/shared-types';
import { assertSettlementInvariants } from './settlement-properties.js';

// Always round DOWN (conservative/banker-safe), never use scientific notation
BigNumber.config({ ROUNDING_MODE: BigNumber.ROUND_DOWN, EXPONENTIAL_AT: [-20, 40] });

export interface DiscountTier {
  /** Minimum monthly gross volume (USD/USDC) that activates this tier. */
  volumeUsd: number;
  /** Discount to subtract from the base feeBps. */
  discountBps: number;
}

export interface SettlementAmounts {
  /** Exact original input — no rounding applied */
  grossAmount: Amount;
  /** Fee deducted from gross, rounded DOWN to input decimal places */
  feeAmount: Amount;
  /** grossAmount − feeAmount, same decimal places as input */
  netAmount: Amount;
  /** Fee audit snapshot for forensic analysis (#330) */
  feeSnapshot: FeeAuditSnapshot;
}

export interface FeeAuditSnapshot {
  feeBpsApplied: number;
  maxFeeBpsApplied: number;
  discountApplied: number;
  monthlyVolumeAtTime: number;
  feeVersion: string;
  capApplied?: boolean;
  uncappedFee?: string;
}

export interface FeeConfig {
  feeBps: number;
  maxFeeBps?: number;
  maxFeeThreshold?: string;
}

/**
 * Resolve the discount (in bps) for a given monthly volume.
 *
 * Tiers are evaluated in descending `volumeUsd` order; the first tier
 * whose threshold is ≤ `monthlyVolume` wins.  Returns 0 when no tier
 * matches.
 *
 * @param monthlyVolume  Merchant's gross volume for the current month (USD).
 * @param tiers          Discount tier list from `FEE_DISCOUNT_TIERS` env var.
 */
export function resolveVolumeDiscount(
  monthlyVolume: number,
  tiers: DiscountTier[],
): number {
  if (tiers.length === 0 || monthlyVolume <= 0) return 0;

  // Sort descending by volumeUsd so the highest applicable tier wins
  const sorted = [...tiers].sort((a, b) => b.volumeUsd - a.volumeUsd);
  for (const tier of sorted) {
    if (monthlyVolume >= tier.volumeUsd) {
      return tier.discountBps;
    }
  }
  return 0;
}

/**
 * Computes fee and net amounts with full decimal precision using BigNumber.
 * Supports optional maximum fee caps for high-value settlements.
 *
 * Invariants (must hold for every valid non-negative gross amount and
 * feeBps in [0, 10000]):
 * - `feeAmount + netAmount === grossAmount` (exact decimal equality)
 * - `feeAmount >= 0` and `netAmount <= grossAmount` (never a negative fee)
 * - `feeAmount` has at most as many decimal places as `grossAmount`
 * - When `feeBps === 0`, `feeAmount` is zero with the input's decimal places
 * - ROUND_DOWN: `feeAmount <= grossAmount * feeBps / 10000` (never overcharge)
 * - Effective fee is clamped to [0, feeBps] (discount never produces negative fee)
 *
 * @param grossAmountStr  Validated numeric string from the request body.
 * @param feeBps          Base fee in basis points (e.g. 100 = 1%).
 * @param monthlyVolume   Merchant's gross volume for the current calendar month (USD).
 *                        Defaults to 0 (no discount applied).
 * @param discountTiers   Volume-discount tier list from `FEE_DISCOUNT_TIERS`.
 *                        Defaults to [] (no tiers, no discount).
 * @returns               { grossAmount, feeAmount, netAmount, feeSnapshot }
 *
 * @example
 *   computeSettlementAmounts('100.123456', { feeBps: 100 })
 *   // → { grossAmount: '100.123456', feeAmount: '1.001234', netAmount: '99.122222' }
 *
 * @example  Volume discount: $15 000 volume, tier at $10 000 / 10 bps, base 100 bps
 *   computeSettlementAmounts('500.00', 100, 15_000, [{ volumeUsd: 10_000, discountBps: 10 }])
 *   // effective feeBps = 100 − 10 = 90
 *   // → { feeAmount: '4.50', netAmount: '495.50', feeSnapshot.discountApplied: 10 }
 */
export function computeSettlementAmounts(
  grossAmountStr: Amount,
  feeBps: number,
  monthlyVolume = 0,
  discountTiers: DiscountTier[] = [],
): SettlementAmounts {
  const gross = new BigNumber(grossAmountStr);

  // Resolve volume-based discount and clamp to [0, feeBps]
  const discountBps = Math.min(resolveVolumeDiscount(monthlyVolume, discountTiers), feeBps);
  const effectiveFeeBps = Math.max(0, feeBps - discountBps);

  // fee = gross × effectiveFeeBps / 10 000   (rounded DOWN to preserve net accuracy)
  const fee = gross.multipliedBy(effectiveFeeBps).dividedBy(10_000);

  // Preserve the same decimal places as the original input string.
  const inputDecimals = (grossAmountStr.split('.')[1] ?? '').length;
  const feeStr = fee.toFixed(inputDecimals, BigNumber.ROUND_DOWN);
  const netStr = gross.minus(feeStr).toFixed(inputDecimals);

  const feeSnapshot: FeeAuditSnapshot = {
    feeBpsApplied: effectiveFeeBps,
    maxFeeBpsApplied: feeBps,
    discountApplied: discountBps,
    monthlyVolumeAtTime: monthlyVolume,
    feeVersion: '1.0',
  };

  const result = {
    grossAmount: grossAmountStr,   // exact original — zero rounding
    feeAmount: feeStr,
    netAmount: netStr,
    feeSnapshot,
  };

  assertSettlementInvariants({
    grossAmount: result.grossAmount,
    feeAmount: result.feeAmount,
    netAmount: result.netAmount,
    feeBps,
  });

  return result;
}
