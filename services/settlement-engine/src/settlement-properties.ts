/**
 * Settlement Engine Properties and Configuration Parameters.
 * 
 * Provides types, default thresholds, error recovery strategies,
 * and mapping functions used across bulk and single settlement tasks.
 */

import BigNumber from 'bignumber.js';

export interface SystemThresholds {
  minLimitDefault: string;
  maxLimitDefault: string;
  dailyAggregateDefault: string;
  maxConcurrencyLimit: number;
}

export const SETTLEMENT_SYSTEM_DEFAULTS: SystemThresholds = {
  minLimitDefault: '10.00',
  maxLimitDefault: '100000.00',
  dailyAggregateDefault: '500000.00',
  maxConcurrencyLimit: 100,
};

export interface AssetPrecisionConfig {
  assetCode: string;
  decimals: number;
  roundingMode: 'down' | 'half-up' | 'up';
}

export const ASSET_PRECISION_MAPPINGS: Record<string, AssetPrecisionConfig> = {
  USDC: {
    assetCode: 'USDC',
    decimals: 7,
    roundingMode: 'down',
  },
  EURT: {
    assetCode: 'EURT',
    decimals: 6,
    roundingMode: 'down',
  },
  XLM: {
    assetCode: 'XLM',
    decimals: 7,
    roundingMode: 'down',
  },
  NGN: {
    assetCode: 'NGN',
    decimals: 2,
    roundingMode: 'down',
  },
};

/**
 * Returns the decimal precision configuration for a given asset code.
 * Defaults to 2 decimals with round-down strategy if asset is not pre-registered.
 */
export function getAssetPrecision(asset: string): AssetPrecisionConfig {
  const normalized = asset.toUpperCase();
  return ASSET_PRECISION_MAPPINGS[normalized] ?? {
    assetCode: normalized,
    decimals: 2,
    roundingMode: 'down',
  };
}

/**
 * Validates that an asset is currently supported by the payout engine.
 */
export function isSupportedAsset(asset: string): boolean {
  return asset.toUpperCase() in ASSET_PRECISION_MAPPINGS;
}

export interface SettlementInvariantInput {
  grossAmount: string;
  feeAmount: string;
  netAmount: string;
  feeBps?: number;
}

export function assertSettlementInvariants({
  grossAmount,
  feeAmount,
  netAmount,
  feeBps,
}: SettlementInvariantInput): void {
  const gross = new BigNumber(grossAmount);
  const fee = new BigNumber(feeAmount);
  const net = new BigNumber(netAmount);

  if (!gross.isFinite() || !fee.isFinite() || !net.isFinite()) {
    throw new Error('Settlement invariant violated: amounts must be finite decimal values');
  }

  if (!fee.plus(net).isEqualTo(gross)) {
    throw new Error('Settlement invariant violated: feeAmount + netAmount === grossAmount');
  }

  if (fee.isLessThan(0)) {
    throw new Error('Settlement invariant violated: feeAmount must be >= 0');
  }

  if (net.isGreaterThan(gross)) {
    throw new Error('Settlement invariant violated: netAmount must be <= grossAmount');
  }

  if (feeBps !== undefined && (feeBps < 0 || feeBps > 10_000)) {
    throw new Error('Settlement invariant violated: feeBps must be within [0, 10000]');
  }
}
