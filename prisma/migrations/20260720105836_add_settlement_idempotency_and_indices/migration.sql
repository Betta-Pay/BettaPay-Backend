-- AlterTable
ALTER TABLE "IndexedEvent" ADD COLUMN     "contractName" TEXT;

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "convertTo" TEXT,
ADD COLUMN     "convertedAmount" TEXT,
ADD COLUMN     "fxQuoteExpiresAt" TIMESTAMP(3),
ADD COLUMN     "fxQuoteId" TEXT,
ADD COLUMN     "fxRate" TEXT;

-- AlterTable
ALTER TABLE "Settlement" ADD COLUMN     "idempotencyKey" TEXT,
ADD COLUMN     "idempotencyKeyExpiresAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "WebhookSubscription" ADD COLUMN     "merchantId" TEXT,
ADD COLUMN     "signingSecret" TEXT;

-- CreateIndex
CREATE INDEX "IndexedEvent_indexedAt_idx" ON "IndexedEvent"("indexedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Settlement_idempotencyKey_key" ON "Settlement"("idempotencyKey");
