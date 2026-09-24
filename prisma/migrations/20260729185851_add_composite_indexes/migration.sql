-- CreateIndex
CREATE INDEX "Payment_merchantId_status_createdAt_idx" ON "Payment"("merchantId", "status", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "Settlement_merchantId_status_initiatedAt_idx" ON "Settlement"("merchantId", "status", "initiatedAt" DESC);

-- CreateIndex
CREATE INDEX "IndexedEvent_contractId_ledger_idx" ON "IndexedEvent"("contractId", "ledger" DESC);

-- CreateIndex
CREATE INDEX "AuditLog_entityType_entityId_createdAt_idx" ON "AuditLog"("entityType", "entityId", "createdAt" DESC);
