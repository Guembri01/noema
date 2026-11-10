-- P2-T04: persistent per-property UNIQUE_ID counter.
--
-- `Property.uniqueIdCounter` stores the highest id number ever issued for the
-- property (0 = nothing issued yet). Allocation is an atomic
-- `UPDATE ... SET "uniqueIdCounter" = "uniqueIdCounter" + 1` inside the
-- row-create transaction, so concurrent row creates serialize on the row lock
-- and can never mint the same id twice. Because the counter lives on Property,
-- a hard purge of rows (which cascades PropertyValue deletes) no longer
-- re-issues ids: values are deleted, the counter survives.
--
-- Backfill note: existing properties migrate lazily — the first allocation
-- after this migration finds the counter still at its default 0, computes the
-- high-water mark of the ids already stored (the old max-of-remaining scan)
-- and stamps the counter with that value inside the same transaction, guarded
-- so the counter can only ever move forward. The preexisting value JSON is
-- intentionally NOT parsed in SQL: stored cells may carry the number under
-- `number`/`value`/`text`/`id` as either digits-only strings or integers, at
-- which SQL-shaped parsing is fragile compared to the shared TS engine.

ALTER TABLE "Property" ADD COLUMN "uniqueIdCounter" INTEGER NOT NULL DEFAULT 0;
