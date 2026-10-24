import { describe, expect, it } from "vitest";
import {
  buildInverseBackfill,
  nextInversePageIds,
  normalizeRelationConfig,
  normalizeRelationPageIds,
  pruneRelationIds,
} from "@/lib/relation-config";

describe("normalizeRelationConfig", () => {
  it("fills the R21.1 shape for a legacy target-only config", () => {
    expect(normalizeRelationConfig({ targetDatabaseId: " db-b " })).toEqual({
      targetDatabaseId: "db-b",
      multi: true,
      inversePropertyId: null,
    });
  });

  it("keeps a single-cardinality pair and parses serialized JSON", () => {
    expect(
      normalizeRelationConfig(
        JSON.stringify({
          targetDatabaseId: "db-b",
          multi: false,
          inversePropertyId: " rel-back ",
        }),
      ),
    ).toEqual({
      targetDatabaseId: "db-b",
      multi: false,
      inversePropertyId: "rel-back",
    });
  });

  it("degrades malformed input to the empty, safe config", () => {
    expect(normalizeRelationConfig(null)).toEqual({
      targetDatabaseId: null,
      multi: true,
      inversePropertyId: null,
    });
    expect(normalizeRelationConfig({ targetDatabaseId: 42 })).toEqual({
      targetDatabaseId: null,
      multi: true,
      inversePropertyId: null,
    });
    expect(normalizeRelationConfig("not json")).toEqual({
      targetDatabaseId: null,
      multi: true,
      inversePropertyId: null,
    });
  });
});

describe("normalizeRelationPageIds", () => {
  it("drops blanks, trims and de-duplicates in first-seen order", () => {
    expect(
      normalizeRelationPageIds({ pageIds: [" b ", "", "a", "b", 3, null] }, true),
    ).toEqual(["b", "a"]);
  });

  it("clamps a single relation to its first id", () => {
    expect(normalizeRelationPageIds({ pageIds: ["a", "b"] }, false)).toEqual(["a"]);
  });

  it("distinguishes malformed values from an empty selection", () => {
    expect(normalizeRelationPageIds(null, true)).toBeNull();
    expect(normalizeRelationPageIds({}, true)).toBeNull();
    expect(normalizeRelationPageIds({ pageIds: "a" }, true)).toBeNull();
    expect(normalizeRelationPageIds({ pageIds: [] }, true)).toEqual([]);
  });
});

describe("pruneRelationIds", () => {
  it("keeps only ids the target query resolved", () => {
    expect(pruneRelationIds(["a", "b", "c"], new Set(["a", "c"]))).toEqual([
      "a",
      "c",
    ]);
  });
});

describe("nextInversePageIds", () => {
  it("appends and de-duplicates on a multi reciprocal", () => {
    expect(nextInversePageIds({ pageIds: ["a"] }, "b", "add", true)).toEqual([
      "a",
      "b",
    ]);
    expect(nextInversePageIds({ pageIds: ["a"] }, "a", "add", true)).toEqual([
      "a",
    ]);
  });

  it("replaces the previous source on a single reciprocal", () => {
    expect(nextInversePageIds({ pageIds: ["a"] }, "b", "add", false)).toEqual([
      "b",
    ]);
  });

  it("removes only the named source", () => {
    expect(
      nextInversePageIds({ pageIds: ["a", "b"] }, "a", "remove", true),
    ).toEqual(["b"]);
    expect(
      nextInversePageIds({ pageIds: ["a"] }, "missing", "remove", true),
    ).toEqual(["a"]);
  });
});

describe("buildInverseBackfill", () => {
  it("merges existing reciprocal cells with every source link", () => {
    expect(
      buildInverseBackfill({
        links: [
          { sourceRowId: "a1", targetRowId: "b1" },
          { sourceRowId: "a2", targetRowId: "b1" },
          { sourceRowId: "a1", targetRowId: "b2" },
        ],
        existing: { b2: ["a9"] },
        multi: true,
      }),
    ).toEqual({ b1: ["a1", "a2"], b2: ["a9", "a1"] });
  });

  it("clamps each reciprocal cell when the pair is single", () => {
    expect(
      buildInverseBackfill({
        links: [
          { sourceRowId: "a1", targetRowId: "b1" },
          { sourceRowId: "a2", targetRowId: "b1" },
        ],
        multi: false,
      }),
    ).toEqual({ b1: ["a2"] });
  });
});
