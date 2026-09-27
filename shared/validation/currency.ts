import { z } from 'zod';

// Extend this array to support new currencies
export const CurrencyCode = z.enum(['USDC', 'EURT', 'NGN']);

export type CurrencyCode = z.infer<typeof CurrencyCode>;

/** Maximum decimal places per supported asset. */
export const ASSET_DECIMALS: Record<string, number> = {
  USDC: 7,
  EURT: 7,
  NGN: 2,
};

/**
 * Validate that an amount string does not exceed the asset's decimal precision.
 * Returns true if valid, false if the amount has too many decimals for the asset.
 */
export function validateAmountPrecision(amount: string, asset: string): boolean {
  const decimals = ASSET_DECIMALS[asset];
  if (decimals === undefined) return false;
  const parts = amount.split('.');
  if (parts.length === 1) return true;
  return parts[1].length <= decimals;
}
