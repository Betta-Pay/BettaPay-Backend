-- Migration: Add a merchant history index for filtered, ordered payment lookups (#855)
--
-- Listing payment history is keyed by merchantId and sorted by createdAt desc.
-- The new composite index keeps merchant-scoped history pages efficient without
-- changing the payment schema or API response payloads.

CREATE INDEX "Payment_merchantId_createdAt_idx"
  ON "Payment" ("merchantId", "createdAt" DESC);

-- Reverse migration
DROP INDEX "Payment_merchantId_createdAt_idx";
