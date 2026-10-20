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

/**
 * Prisma Query Timeout Configuration (#923)
 *
 * Configurable statement timeout for settlement Prisma queries to prevent
 * slow database calls from holding connection-pool slots indefinitely.
 *
 * Timeout is applied via SET LOCAL statement_timeout in PostgreSQL.
 * Queries exceeding this timeout will be aborted and surface as QueryTimeoutError.
 *
 * Default: 5000ms (5 seconds)
 * Min: 1000ms (1 second)
 * Max: 60000ms (60 seconds)
 */
export const SETTLEMENT_QUERY_TIMEOUT_MS = Number(
  process.env.SETTLEMENT_QUERY_TIMEOUT_MS ?? 5000
);

export function validateQueryTimeout(): void {
  const MIN_TIMEOUT = 1000;
  const MAX_TIMEOUT = 60000;

  if (
    SETTLEMENT_QUERY_TIMEOUT_MS < MIN_TIMEOUT ||
    SETTLEMENT_QUERY_TIMEOUT_MS > MAX_TIMEOUT
  ) {
    throw new Error(
      `SETTLEMENT_QUERY_TIMEOUT_MS (${SETTLEMENT_QUERY_TIMEOUT_MS}ms) must be within [${MIN_TIMEOUT}, ${MAX_TIMEOUT}]`
    );
  }
}

/**
 * Settlement Engine merchant max concurrency (#839).
 * Resolves MERCHANT_MAX_CONCURRENCY from validated environment or defaults to 10.
 */
export function getMerchantMaxConcurrency(env?: { MERCHANT_MAX_CONCURRENCY?: number | string }): number {
  const raw = env?.MERCHANT_MAX_CONCURRENCY ?? process.env.MERCHANT_MAX_CONCURRENCY;
  if (raw !== undefined && raw !== null && raw !== '') {
    const val = Number(raw);
    if (Number.isFinite(val) && val > 0) {
      return Math.floor(val);
    }
  }
  return 10;
}

