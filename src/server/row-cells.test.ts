import { describe, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";
import { createRowCellsInTransaction } from "@/server/row-cells";

/**
 * P2-T04 — UNIQUE_ID allocation against a persistent per-property counter.
 *
 * The transport edge is mocked out with a mini ledger that models the
 * Postgres behaviours the allocation depends on:
 *
 * - `property.update({ uniqueIdCounter: { increment: 1 } })` atomically
 *   re-reads the CURRENT counter and advances it (row-lock serialization),
 * - `property.updateMany` evaluates its guard (`uniqueIdCounter: 0`, or
 *   `uniqueIdCounter: { lt }`) against the same live state,
 * - the value list backing `propertyValue.findMany` is mutable, so a test
 *   can hard-purge stored values and prove the counter is independent.
 *
 * Races are simulated by sharing one ledger across two transactions that
 * interleave on the macrotask queue — every mock await yields, so the
 * challenger's findUnique/stamp/increment see whatever the first racer
 * already committed.
 */

type StoredValue = { propertyId: string; value: Prisma.JsonValue };

function tick() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

type Ledger = {
  counter: number;
  values: StoredValue[];
  created: { propertyId: string; pageId: string; value: Prisma.JsonValue }[];
  properties: { id: string; type: string; config: Prisma.JsonValue }[];
};

function makeLedger(
  counter = 0,
  values: StoredValue[] = [],
  properties: Ledger["properties"] = [],
): Ledger {
  return { counter, values, created: [], properties };
}

function makeTx(ledger: Ledger) {
  return {
    property: {
      findMany: async (args: {
        where: { databasePageId: string };
        select: unknown;
      }) => {
        await tick();
        return ledger.properties;
      },
      findUnique: async (args: { where: { id: string } }) => {
        await tick();
        if (args.where.id !== ledger.properties[0]?.id) return null;
        return { uniqueIdCounter: ledger.counter };
      },
      updateMany: async (args: {
        where: { id: string; uniqueIdCounter: number | { lt: number } };
        data: { uniqueIdCounter: number };
      }) => {
        await tick();
        const guard = args.where.uniqueIdCounter;
        if (typeof guard === "number") {
          if (ledger.counter !== guard) return { count: 0 };
        } else if (ledger.counter >= guard.lt) {
          return { count: 0 };
        }
        ledger.counter = Math.max(ledger.counter, args.data.uniqueIdCounter);
        return { count: 1 };
      },
      update: async (args: {
        where: { id: string };
        data: { uniqueIdCounter: { increment: number } };
      }) => {
        await tick();
        if (args.where.id !== ledger.properties[0]?.id) throw new Error("no such property");
        ledger.counter += args.data.uniqueIdCounter.increment;
        return { uniqueIdCounter: ledger.counter };
      },
    },
    propertyValue: {
      findMany: async (args: { where: { propertyId: string } }) => {
        await tick();
        return ledger.values
          .filter((entry) => entry.propertyId === args.where.propertyId)
          .map((entry) => ({ value: entry.value }));
      },
      createMany: async (args: {
        data: { propertyId: string; pageId: string; value: Prisma.JsonValue }[];
      }) => {
        await tick();
        ledger.created.push(...args.data);
        return { count: args.data.length };
      },
    },
  } as unknown as Prisma.TransactionClient;
}

function ledgerWithProperty(
  extra: Partial<{ config: Prisma.JsonValue; type: string }> = {},
): { ledger: Ledger; propertyId: string } {
  const ledger = makeLedger(0, [], [
    {
      id: "prop1",
      type: extra.type ?? "UNIQUE_ID",
      config: extra.config ?? null,
    },
  ]);
  return { ledger, propertyId: "prop1" };
}

describe("UNIQUE_ID counter allocation", () => {
  it("starts at ID-0001 for a property with no stored values and no config", async () => {
    const { ledger } = ledgerWithProperty();
    const tx = makeTx(ledger);
    await createRowCellsInTransaction(tx, "db1", "row1", "Row");
    // No stored config → the raw formatter uses the "" prefix, exactly like the
    // pre-P2-T04 allocation did; only the numbering source changed.
    expect(ledger.created).toEqual([
      { propertyId: "prop1", pageId: "row1", value: { number: 1, text: "-0001" } },
    ]);
    expect(ledger.counter).toBe(1);
  });

  it("honours prefix, startAt and zeroPad from the stored config", async () => {
    const { ledger } = ledgerWithProperty({
      config: { uniqueId: { prefix: "TASK", startAt: 5, zeroPad: 2 } },
    });
    await createRowCellsInTransaction(makeTx(ledger), "db1", "row1", "Row");
    expect(ledger.created[0]?.value).toEqual({ number: 5, text: "TASK-05" });
  });

  it("lazily backfills a virgin counter above every id already stored", async () => {
    const { ledger } = ledgerWithProperty({
      config: { uniqueId: { prefix: "ID" } },
    });
    ledger.values = [
      { propertyId: "prop1", value: { number: 3, text: "ID-0003" } },
      { propertyId: "prop1", value: "ID-0012" },
      { propertyId: "prop1", value: { text: "not-an-id" } }, // unparseable: ignored
    ];
    await createRowCellsInTransaction(makeTx(ledger), "db1", "row1", "Row");
    // The counter resumes above the max (12), not at 1.
    expect(ledger.created[0]?.value).toEqual({ number: 13, text: "ID-0013" });
    expect(ledger.counter).toBe(13);
  });

  it("the second allocation after backfill increments from the stamped counter", async () => {
    const { ledger } = ledgerWithProperty({
      config: { uniqueId: { prefix: "ID" } },
    });
    ledger.values = [{ propertyId: "prop1", value: { number: 7, text: "ID-0007" } }];
    await createRowCellsInTransaction(makeTx(ledger), "db1", "row1", "Row");
    // Backfill also persists the created value by the time the ledger is
    // re-read: carry the created row forward for the incremental allocation.
    const next = makeLedger(ledger.counter, [...ledger.values, ...ledger.created], [
      ...ledger.properties,
    ]);
    await createRowCellsInTransaction(makeTx(next), "db1", "row2", "Row");
    expect(next.created[0]?.value).toEqual({ number: 9, text: "ID-0009" });
  });

  it("two racing allocations get distinct sequential numbers", async () => {
    const { ledger } = ledgerWithProperty({
      config: { uniqueId: { prefix: "TASK" } },
    });
    // Simulate 12 legacy rows so the lazy backfill is part of the race.
    ledger.values = Array.from({ length: 12 }, (_, index) => ({
      propertyId: "prop1",
      value: { number: index + 1, text: `TASK-${String(index + 1).padStart(4, "0")}` },
    }));
    const txA = makeTx(ledger);
    const txB = makeTx(ledger);
    // Both transactions interleave on the task queue; the shared ledger models
    // the row-locked counter, so the guards decide which racer stamps.
    await Promise.all([
      createRowCellsInTransaction(txA, "db1", "rowA", "A"),
      createRowCellsInTransaction(txB, "db1", "rowB", "B"),
    ]);
    const numbers = ledger.created.map((cell) => (cell.value as { number: number }).number);
    expect(new Set(numbers).size).toBe(2);
    // Both numbers sit strictly above the preexisting high-water mark of 12.
    for (const number of numbers) expect(number).toBeGreaterThan(12);
    // The counter advanced by exactly two allocations, never backwards.
    expect(ledger.counter).toBe(14);
  });

  it("a hard purge never re-issues ids: the counter survives deleted values", async () => {
    const { ledger } = ledgerWithProperty({
      config: { uniqueId: { prefix: "ID" } },
    });
    ledger.values = [{ propertyId: "prop1", value: { number: 12, text: "ID-0012" } }];
    await createRowCellsInTransaction(makeTx(ledger), "db1", "row1", "Row");
    expect(ledger.counter).toBe(13);

    // Simulate the trash purge: values cascade away, Property (and its
    // counter) survives.
    ledger.values = [];

    await createRowCellsInTransaction(makeTx(ledger), "db1", "row2", "Row");
    expect(ledger.created[1]?.value).toEqual({ number: 14, text: "ID-0014" });
  });

  it("stores the same `{ number, text }` JSON shape as before", async () => {
    const { ledger } = ledgerWithProperty({
      config: { uniqueId: { prefix: "TASK", zeroPad: 4 } },
    });
    await createRowCellsInTransaction(makeTx(ledger), "db1", "row1", "Row");
    const value = ledger.created[0]?.value as { number: number; text: string };
    expect(Object.keys(value).sort()).toEqual(["number", "text"]);
    expect(value.text).toBe("TASK-0001");
  });
});
