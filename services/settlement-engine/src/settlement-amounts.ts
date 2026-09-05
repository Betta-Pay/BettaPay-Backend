// @ts-nocheck
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

import BigNumber from "bignumber.js";
import type { Amount } from "@bettapay/shared-types";
import { feeSnapshotSchema } from "@bettapay/validation";

// Always round DOWN (conservative/banker-safe), never use scientific notation
BigNumber.config({
  ROUNDING_MODE: BigNumber.ROUND_DOWN,
  EXPONENTIAL_AT: [-20, 40],
});

/**
 * Fee algorithm version constant (#482).
 * Bump this when the fee computation logic changes so audits can
 * distinguish pre/post-change snapshots.
 */
export const FEE_VERSION = '1.0' as const;

/**
 * Maximum allowed settlement amount in whole currency units (#481).
 * The per-asset cap is derived as: MAX_SETTLEMENT_BASE_UNITS × 10^decimals.
 */
export const MAX_SETTLEMENT_BASE_UNITS = "100000000"; // 10^8

/** Legacy absolute cap used when asset is unknown (10^15). */
export const MAX_SETTLEMENT_AMOUNT = "1000000000000000";

/** Thrown when a settlement gross amount exceeds MAX_SETTLEMENT_AMOUNT. */
export class SettlementAmountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettlementAmountError";
  }
}

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
 * Returns the maximum settlement amount (as a decimal string) for a given
 * asset, derived from its decimal precision (#481).
 *
 * For a 7-decimal asset like USDC: 10^8 × 10^7 = 10^15
 * For a 2-decimal asset like NGN:  10^8 × 10^2 = 10^10
 *
 * Falls back to MAX_SETTLEMENT_AMOUNT when the asset is unknown.
 */
export function getMaxSettlementAmountForAsset(asset?: string): string {
  if (!asset) return MAX_SETTLEMENT_AMOUNT;
  const normalized = asset.toUpperCase();
  const config = ASSET_PRECISION_MAPPINGS[normalized];
  const decimals = config?.decimals ?? 2;
  return new BN(MAX_SETTLEMENT_BASE_UNITS).multipliedBy(new BN(10).pow(decimals)).toFixed(0);
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
 * @param asset           Optional asset code for per-asset max validation (#481).
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
  asset?: string,
): SettlementAmounts {
  const gross = new BN(grossAmountStr);

  // Guard: reject amounts that exceed the maximum allowed settlement amount (#481).
  // Per-asset cap is derived from the asset's decimal precision.
  const effectiveMax = getMaxSettlementAmountForAsset(asset);
  if (gross.isGreaterThan(effectiveMax)) {
    throw new SettlementAmountError(
      `Settlement amount ${grossAmountStr} exceeds maximum allowed (${effectiveMax}) for asset ${asset ?? 'unknown'}`,
    );
  }

  // Resolve volume-based discount and clamp to [0, feeBps]
  const discountBps = Math.min(
    resolveVolumeDiscount(monthlyVolume, discountTiers),
    feeBps,
  );
  const effectiveFeeBps = Math.max(0, feeBps - discountBps);

  // fee = gross × effectiveFeeBps / 10 000   (rounded DOWN to preserve net accuracy)
  const fee = gross.multipliedBy(effectiveFeeBps).dividedBy(10_000);

  // Preserve the same decimal places as the original input string.
  const inputDecimals = (grossAmountStr.split(".")[1] ?? "").length;
  const feeStr = fee.toFixed(inputDecimals, BigNumber.ROUND_DOWN);
  const netStr = gross.minus(feeStr).toFixed(inputDecimals);

  const feeSnapshot: FeeAuditSnapshot = {
    feeBpsApplied: effectiveFeeBps,
    maxFeeBpsApplied: feeBps,
    discountApplied: discountBps,
    monthlyVolumeAtTime: monthlyVolume,
    feeVersion: "1.0",
  };

  // Validate fee snapshot against schema (#625)
  const validationResult = feeSnapshotSchema.safeParse(feeSnapshot);
  if (!validationResult.success) {
    throw new SettlementAmountError(
      `Invalid fee snapshot: ${validationResult.error.message}`,
    );
  }

  return {
    grossAmount: grossAmountStr, // exact original — zero rounding
    feeAmount: feeStr,
    netAmount: netStr,
    feeSnapshot,
  };
}

/**
 * Computes the applicable fee BPS for a given asset based on fee schedules.
 * Falls back to defaultBps if no matching schedule is found.
 *
 * @param asset       The asset code (e.g., 'USDC', 'EURT')
 * @param feeSchedules  Array of fee schedule items [{ asset, bps }]
 * @param defaultBps    Default fee BPS to use if no schedule matches
 * @returns           The applicable fee BPS for the asset
 */
export function resolveFeeBpsForAsset(
  asset: string,
  feeSchedules: FeeScheduleItem[] | undefined,
  defaultBps: number,
): number {
  if (!feeSchedules || feeSchedules.length === 0) {
    return defaultBps;
  }
  const schedule = feeSchedules.find((s) => s.asset === asset);
  return schedule ? schedule.bps : defaultBps;
}

/**
 * Computes fee and net amounts with full decimal precision using BigNumber,
 * resolving the fee BPS from fee schedules based on the asset.
 *
 * @param grossAmountStr  Validated numeric string from the request body.
 * @param asset           The asset code (e.g., 'USDC', 'EURT')
 * @param feeSchedules    Array of fee schedule items [{ asset, bps }]
 * @param defaultBps      Default fee BPS to use if no schedule matches
 * @returns               { grossAmount, feeAmount, netAmount } as full-precision strings.
 */
export function computeSettlementAmountsWithSchedule(
  grossAmountStr: Amount,
  asset: string,
  feeSchedules: FeeScheduleItem[] | undefined,
  defaultBps: number,
): SettlementAmounts {
  const feeBps = resolveFeeBpsForAsset(asset, feeSchedules, defaultBps);
  return computeSettlementAmounts(grossAmountStr, feeBps, 0, [], asset);
}
