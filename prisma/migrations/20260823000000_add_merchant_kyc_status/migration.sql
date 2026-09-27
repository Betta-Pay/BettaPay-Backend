-- Add KYC status to merchants. Existing rows default to 'unverified'.
-- The Prisma schema declares KycStatus as an enum and the Merchant model
-- references it via `kycStatus KycStatus @default(unverified)`, but no
-- migration was generated for it, causing CI seed failures with the
-- Prisma 7.9 driver adapter.
--
-- Written to be re-runnable (idempotent) so the CI rollback-then-reapply
-- flow works correctly.

-- CreateEnum (idempotent)
DO $$ BEGIN
  CREATE TYPE "KycStatus" AS ENUM ('unverified', 'pending', 'verified', 'rejected');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- AlterTable (idempotent)
ALTER TABLE "Merchant"
  ADD COLUMN IF NOT EXISTS "kycStatus" "KycStatus" NOT NULL DEFAULT 'unverified';