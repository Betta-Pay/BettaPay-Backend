-- Migration: Document feeSnapshot schema validation (#625)
-- This migration adds documentation for the feeSnapshot JSON field
-- which now has schema validation enforced at the application layer.

COMMENT ON COLUMN "Settlement"."feeSnapshot" 
  IS 'Fee audit snapshot (validated against feeSnapshotSchema). Structure: { feeBpsApplied: number, maxFeeBpsApplied: number, discountApplied: number, monthlyVolumeAtTime: number, feeVersion: string }. Validated on write and read (#625)';
