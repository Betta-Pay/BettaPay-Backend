-- #1096: reject non-numeric amount strings and orphaned batch references at
-- the database level.
--
-- Amounts stay String columns (exact decimal round-tripping); these CHECKs
-- mirror the app-layer AmountString regex (non-negative decimal, no exponent).
-- Prisma does not model CHECK constraints, so the CI rollback job (driven by
-- `prisma migrate diff`) leaves them in place; DROP ... IF EXISTS keeps this
-- migration re-runnable.

ALTER TABLE "Settlement" DROP CONSTRAINT IF EXISTS "Settlement_totalAmount_numeric_check";
ALTER TABLE "Settlement" ADD CONSTRAINT "Settlement_totalAmount_numeric_check" CHECK ("totalAmount" ~ '^[0-9]+(\.[0-9]+)?$');
ALTER TABLE "Settlement" DROP CONSTRAINT IF EXISTS "Settlement_grossAmount_numeric_check";
ALTER TABLE "Settlement" ADD CONSTRAINT "Settlement_grossAmount_numeric_check" CHECK ("grossAmount" ~ '^[0-9]+(\.[0-9]+)?$');
ALTER TABLE "Settlement" DROP CONSTRAINT IF EXISTS "Settlement_feeAmount_numeric_check";
ALTER TABLE "Settlement" ADD CONSTRAINT "Settlement_feeAmount_numeric_check" CHECK ("feeAmount" ~ '^[0-9]+(\.[0-9]+)?$');
ALTER TABLE "Settlement" DROP CONSTRAINT IF EXISTS "Settlement_netAmount_numeric_check";
ALTER TABLE "Settlement" ADD CONSTRAINT "Settlement_netAmount_numeric_check" CHECK ("netAmount" ~ '^[0-9]+(\.[0-9]+)?$');

ALTER TABLE "SettlementBatch" DROP CONSTRAINT IF EXISTS "SettlementBatch_totalGross_numeric_check";
ALTER TABLE "SettlementBatch" ADD CONSTRAINT "SettlementBatch_totalGross_numeric_check" CHECK ("totalGross" ~ '^[0-9]+(\.[0-9]+)?$');
ALTER TABLE "SettlementBatch" DROP CONSTRAINT IF EXISTS "SettlementBatch_totalFees_numeric_check";
ALTER TABLE "SettlementBatch" ADD CONSTRAINT "SettlementBatch_totalFees_numeric_check" CHECK ("totalFees" ~ '^[0-9]+(\.[0-9]+)?$');
ALTER TABLE "SettlementBatch" DROP CONSTRAINT IF EXISTS "SettlementBatch_totalNet_numeric_check";
ALTER TABLE "SettlementBatch" ADD CONSTRAINT "SettlementBatch_totalNet_numeric_check" CHECK ("totalNet" ~ '^[0-9]+(\.[0-9]+)?$');

-- The bulk settlement endpoint previously stamped settlements with a
-- generated batch id without creating a SettlementBatch row. Backfill one row
-- per such id from its settlements so the FK below can be added without
-- nulling existing links.
INSERT INTO "SettlementBatch" ("id", "asset", "totalCount", "totalGross", "totalFees", "totalNet", "createdAt")
SELECT
    s."batchId",
    CASE WHEN COUNT(DISTINCT s."asset") = 1 THEN MIN(s."asset") ELSE 'MIXED' END,
    COUNT(*)::INTEGER,
    SUM(s."grossAmount"::NUMERIC)::TEXT,
    SUM(s."feeAmount"::NUMERIC)::TEXT,
    SUM(s."netAmount"::NUMERIC)::TEXT,
    MIN(s."initiatedAt")
FROM "Settlement" s
WHERE s."batchId" IS NOT NULL
GROUP BY s."batchId"
ON CONFLICT ("id") DO NOTHING;

-- AddForeignKey
ALTER TABLE "Settlement" ADD CONSTRAINT "Settlement_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "SettlementBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;
