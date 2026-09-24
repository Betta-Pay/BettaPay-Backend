ALTER TABLE "WebhookSubscription"
  ADD COLUMN "lastTestedAt" TIMESTAMP(3),
  ADD COLUMN "lastTestStatus" TEXT,
  ADD COLUMN "lastTestStatusCode" INTEGER;
