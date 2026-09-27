-- Adds per-subscription/per-settlement custom webhook headers (#569).
--
-- Both columns are nullable JSON with no default, so existing rows are
-- unaffected and delivery falls back to sending only Content-Type (and the
-- signature header, when a signing secret is configured) when unset.
--
-- Written to be re-runnable (idempotent) so the CI rollback-then-reapply
-- flow works correctly.

-- AlterTable (idempotent)
ALTER TABLE "Settlement" ADD COLUMN IF NOT EXISTS "webhookHeaders" JSONB;

-- AlterTable (idempotent)
ALTER TABLE "WebhookSubscription" ADD COLUMN IF NOT EXISTS "headers" JSONB;
