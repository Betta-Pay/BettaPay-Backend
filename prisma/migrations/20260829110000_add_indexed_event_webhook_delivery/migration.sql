CREATE TABLE "IndexedEventWebhookDelivery" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "indexedEventId" TEXT NOT NULL,
  "subscriptionId" TEXT NOT NULL,
  "url" TEXT NOT NULL,
  "event" JSONB NOT NULL,
  "signingSecret" TEXT,
  "headers" JSONB,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "processedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "IndexedEventWebhookDelivery_indexedEventId_subscriptionId_key" ON "IndexedEventWebhookDelivery"("indexedEventId", "subscriptionId");
CREATE INDEX "IndexedEventWebhookDelivery_status_createdAt_idx" ON "IndexedEventWebhookDelivery"("status", "createdAt");
