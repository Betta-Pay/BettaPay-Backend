-- Migration: Close the null-stellarId dedup gap on IndexedEvent (#612)
--
-- IndexedEvent.stellarId is nullable (Soroban contract events don't always
-- carry one) and the existing composite unique index is a plain
-- @@unique([stellarId, contractId, ledger]). In Postgres, NULL <> NULL, so
-- that index never rejected two rows that both had stellarId = NULL for the
-- same (contractId, ledger) — the indexer could ingest the same
-- stellarId-less event twice.
--
-- 1. Deduplicate existing offenders: for every (contractId, ledger) group
--    with stellarId IS NULL, keep the earliest row (by indexedAt, then id)
--    and delete the rest. IndexedEventWebhookDelivery.indexedEventId is a
--    plain string column with no FK constraint, so this is safe.
-- 2. Recreate the composite unique index with NULLS NOT DISTINCT (Postgres
--    15+; this repo runs Postgres 16) so future duplicate-null rows are
--    rejected at the database level, the same as any other duplicate.

DELETE FROM "IndexedEvent" a
USING "IndexedEvent" b
WHERE a."stellarId" IS NULL
  AND b."stellarId" IS NULL
  AND a."contractId" = b."contractId"
  AND a."ledger" = b."ledger"
  AND (a."indexedAt", a."id") > (b."indexedAt", b."id");

DROP INDEX "IndexedEvent_stellarId_contractId_ledger_key";

CREATE UNIQUE INDEX "IndexedEvent_stellarId_contractId_ledger_key"
  ON "IndexedEvent" ("stellarId", "contractId", "ledger")
  NULLS NOT DISTINCT;
