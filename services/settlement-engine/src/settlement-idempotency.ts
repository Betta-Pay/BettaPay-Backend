/**
 * settlement-idempotency.ts
 *
 * Canonical payload hashing for POST /api/settlements idempotency replays.
 *
 * An Idempotency-Key must always map to the same request parameters. The hash
 * covers the fields that define the settlement (merchant, amount, asset) in a
 * fixed key order with a normalised amount, so `"100"` and `"100.00"` are the
 * same payload while a different amount or merchant is a key collision.
 * No I/O — safe to import in tests.
 */

import * as crypto from 'crypto';
import BigNumber from 'bignumber.js';

export interface SettlementPayloadFields {
  merchantId: string;
  amount: string;
  asset: string;
}

/** Redis key holding the canonical payload hash for an idempotency key. */
export function idempotencyHashKey(idempotencyKey: string): string {
  return `idempotency:hash:${idempotencyKey}`;
}

export function computeSettlementPayloadHash(fields: SettlementPayloadFields): string {
  const amount = new BigNumber(fields.amount);
  const canonical = JSON.stringify([
    fields.merchantId,
    amount.isFinite() ? amount.toFixed() : fields.amount,
    fields.asset,
  ]);
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

/**
 * Derives the payload hash from a persisted settlement. Used when the stored
 * hash is unavailable (Redis down or key evicted), so a replay can still be
 * verified against what was actually created.
 */
export function settlementPayloadHash(settlement: {
  merchantId: string;
  grossAmount: string;
  asset: string;
}): string {
  return computeSettlementPayloadHash({
    merchantId: settlement.merchantId,
    amount: settlement.grossAmount,
    asset: settlement.asset,
  });
}
