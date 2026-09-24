import type { FeeAuditSnapshot } from "./settlement-amounts.js";
import { feeSnapshotSchema } from "@bettapay/validation";

/** The subset of a Settlement row that the webhook payload is built from. */
export interface SettlementWebhookSource {
  id: string;
  merchantId: string;
  status: string;
  asset: string;
  grossAmount: string;
  feeAmount: string;
  netAmount: string;
  feeBps: number;
  feeSnapshot: unknown;
  webhookUrl: string | null;
  createdAt?: Date | string | null;
  completedAt?: Date | string | null;
}

/**
 * Projects a Settlement row into the `settlement.completed` /
 * `settlement.failed` webhook payload `data` (issue #538).
 *
 * An explicit projection rather than the raw Prisma row: internal columns
 * (`idempotencyKey*`, `webhookHeaders`, …) are never sent, and the fee audit
 * trail is *guaranteed* present so a merchant can verify fee computation from
 * the webhook alone — the full `feeSnapshot` breakdown plus a top-level
 * `feeVersion` for quick reconciliation. Fields are documented in
 * `docs/INDEXER_AND_WEBHOOKS.md`.
 *
 * `webhookUrl` is deliberately excluded from the returned `data` (#608): it
 * is the delivery *target* — often an internal Vercel preview / ngrok /
 * staging hostname — not settlement data, and mirroring it back to the
 * merchant that configured it leaks infrastructure topology for no reason.
 * Internal delivery routing reads `webhookUrl` directly off the `Settlement`
 * row (see the call sites of `buildSettlementWebhookData`), never from this
 * projection.
 *
 * Corrupt feeSnapshot validation (#625): validates the snapshot against the
 * schema and logs errors if corrupt, returning null instead of propagating
 * garbage.
 */
export function buildSettlementWebhookData(
  s: SettlementWebhookSource,
): Record<string, unknown> {
  let feeSnapshot: FeeAuditSnapshot | null = null;

  // Validate feeSnapshot if present (#625)
  if (s.feeSnapshot) {
    const validationResult = feeSnapshotSchema.safeParse(s.feeSnapshot);
    if (validationResult.success) {
      feeSnapshot = validationResult.data as FeeAuditSnapshot;
    } else {
      console.error(
        "Corrupt feeSnapshot detected in settlement, returning null",
        {
          settlementId: s.id,
          merchantId: s.merchantId,
          corruptSnapshot: s.feeSnapshot,
          validationError: validationResult.error.message,
        },
      );
    }
  }

  return {
    id: s.id,
    merchantId: s.merchantId,
    status: s.status,
    asset: s.asset,
    grossAmount: s.grossAmount,
    feeAmount: s.feeAmount,
    netAmount: s.netAmount,
    feeBps: s.feeBps,
    feeSnapshot,
    feeVersion: feeSnapshot?.feeVersion ?? null,
    createdAt: s.createdAt ?? null,
    completedAt: s.completedAt ?? null,
  };
}
