-- Settlement retry chain self-reference guard (#626).
--
-- The retry chain links settlements via supersededById → id. A row must never
-- point at itself: that would create a 1-row loop that breaks chain unwinding
-- and lets an orphan exist with supersededById set to its own id. Prisma's
-- schema cannot express this inline, so it lives as a raw CHECK constraint
-- (kept as DEFERRABLE so transaction-time ordering never bites).
--
-- The reverse-lookup index @@index([supersededById]) already ships in the
-- original add_settlement_retry migration; this migration only adds the
-- guard.

ALTER TABLE "Settlement"
  ADD CONSTRAINT "Settlement_supersededById_no_self"
  CHECK ("supersededById" IS NULL OR "supersededById" <> "id");