-- Migration: Document atomic batch processing pattern (#618)
-- This migration adds documentation for the processedAt field which
-- serves as an atomic claim flag for batch processing.

COMMENT ON COLUMN "SettlementBatch"."processedAt" 
  IS 'Atomic claim timestamp for batch processing. Only one worker can successfully UPDATE to non-NULL. See settlement-batch-processor.ts for usage (#618)';

-- Add index to efficiently query unprocessed batches
CREATE INDEX IF NOT EXISTS "SettlementBatch_processedAt_idx" 
  ON "SettlementBatch"("processedAt") 
  WHERE "processedAt" IS NULL;
