-- #317 — Add merchant suspension status without data deletion.
-- Creates a Postgres enum so the column can only contain 'active' or 'suspended',
-- and backfills existing rows to 'active' so behavior is unchanged for current data.

-- CreateEnum
CREATE TYPE "MerchantStatus" AS ENUM ('active', 'suspended');

-- AlterTable
ALTER TABLE "Merchant" ADD COLUMN "status" "MerchantStatus" NOT NULL DEFAULT 'active';

-- CreateIndex
CREATE INDEX "Merchant_status_idx" ON "Merchant"("status");
