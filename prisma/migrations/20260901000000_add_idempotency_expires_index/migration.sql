-- CreateIndex
CREATE INDEX "Payment_idempotencyKeyExpiresAt_idx" ON "Payment"("idempotencyKeyExpiresAt");

-- CreateIndex
CREATE INDEX "Settlement_idempotencyKeyExpiresAt_idx" ON "Settlement"("idempotencyKeyExpiresAt");
