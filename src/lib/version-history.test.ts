import { describe, expect, it } from "vitest";
import {
  buildVersionRecord,
  diffVersions,
  normalizeVersionLabel,
  pickLatestNamedVersion,
  pickVersionAuthor,
  restoreVersionSummary,
} from "./version-history";

/**
 * B67 - pure version-history helpers (docs/specs/version-history-v2.md M1).
 *
 * Red-first: this file was written BEFORE `src/lib/version-history.ts` existed
 * (module-not-found), and after the fix the summary case still failed against
 * the old inline expression `new Date(version.id ? Date.now() : 0)` - i.e. it
 * always rendered *today*, never the restored version's date.
 *
 * Covers: R30.5 (summary cites `version.createdAt`), R30.11-lite (one
 * membership-independent author resolver shared by both history surfaces).
 *
 * M2 slice (docs/MISSING_FEATURES.md §10 "Version diff" + "Named versions"):
 * the `diffVersions` / `buildVersionRecord` / `pickLatestNamedVersion` /
 * `normalizeVersionLabel` blocks below were written FIRST against exports that
 * did not exist yet (import error -> suite red), then implemented to green.
 */
describe("restoreVersionSummary (R30.5)", () => {
  it("cites the restored version's own date, not today", () => {
    const createdAt = new Date("2020-05-04T10:30:00.000Z");
    const summary = restoreVersionSummary(createdAt);
    expect(summary).toBe(`Restored the version from ${createdAt.toLocaleDateString()}`);
    // 2020-05-04 can never equal the day this test runs.
    expect(summary).not.toContain(new Date().toLocaleDateString());
    expect(summary).toContain("Restored the version from");
  });
});

describe("pickVersionAuthor (R30.11 lite)", () => {
  const users = [
    { id: "u1", name: "Ada Lovelace", email: "ada@example.test" },
    { id: "u2", name: "Grace Hopper", email: "grace@example.test" },
  ];

  it("resolves an author from the User row by id alone (membership is irrelevant)", () => {
    expect(pickVersionAuthor("u2", users)).toEqual(users[1]);
    expect(pickVersionAuthor("u1", users)).toEqual(users[0]);
  });

  it("returns null for a deleted/unknown author - the surface renders its label", () => {
    expect(pickVersionAuthor("deleted-user", users)).toBeNull();
  });

  it("returns null for versions that carry no author id", () => {
    expect(pickVersionAuthor(null, users)).toBeNull();
    expect(pickVersionAuthor(undefined, users)).toBeNull();
    expect(pickVersionAuthor("", users)).toBeNull();
  });
});

/**
 * M2 - Version diff (docs/MISSING_FEATURES.md §10 "Version diff" / 🧭).
 * Pure block-level diff between two snapshots: id-based comparison plus an LCS
 * pass (computed as an LIS over the a-order permutation) for reordering.
 */
describe("diffVersions (block-level diff)", () => {
  const p = (id: string, text: string) => ({
    id,
    type: "paragraph",
    content: [{ type: "text", text }],
  });
  const none = { added: [], removed: [], changed: [], moved: [] };

  it("reports no change for identical snapshots, whatever the key order", () => {
    const doc = [p("b1", "one"), p("b2", "two")];
    expect(diffVersions(doc, doc)).toEqual(none);
    // Serialisation order of a block's own keys is not content.
    const sameBlockOtherKeyOrder = [
      { content: [{ text: "one", type: "text" }], type: "paragraph", id: "b1" },
    ];
    expect(diffVersions([p("b1", "one")], sameBlockOtherKeyOrder)).toEqual(none);
    expect(diffVersions([], [])).toEqual(none);
  });

  it("classifies a pure insert as added and nothing else", () => {
    const before = [p("b1", "one"), p("b3", "three")];
    const after = [p("b1", "one"), p("b2", "two"), p("b3", "three")];
    expect(diffVersions(before, after)).toEqual({
      added: ["b2"],
      removed: [],
      changed: [],
      moved: [],
    });
  });

  it("classifies a pure delete as removed and nothing else", () => {
    const before = [p("b1", "one"), p("b2", "two"), p("b3", "three")];
    const after = [p("b1", "one"), p("b3", "three")];
    expect(diffVersions(before, after)).toEqual({
      added: [],
      removed: ["b2"],
      changed: [],
      moved: [],
    });
  });

  it("classifies an edit-in-place as changed only (order untouched)", () => {
    const before = [p("b1", "one"), p("b2", "two"), p("b3", "three")];
    const after = [p("b1", "one"), p("b2", "two EDITED"), p("b3", "three")];
    expect(diffVersions(before, after)).toEqual({
      added: [],
      removed: [],
      changed: ["b2"],
      moved: [],
    });
  });

  it("classifies a reorder as moved only, flagging just the block off the LCS spine", () => {
    const before = [p("b1", "one"), p("b2", "two"), p("b3", "three")];
    // Only b3 moved: the LCS spine keeps b1, b2 (their relative order holds).
    const after = [p("b3", "three"), p("b1", "one"), p("b2", "two")];
    expect(diffVersions(before, after)).toEqual({
      added: [],
      removed: [],
      changed: [],
      moved: ["b3"],
    });
    // A block appended-and-swapped in place keeps the rest of the spine stable.
    const appendAtFront = [p("b4", "four"), p("b1", "one"), p("b2", "two"), p("b3", "three")];
    expect(diffVersions(before, appendAtFront)).toEqual({
      added: ["b4"],
      removed: [],
      changed: [],
      moved: [],
    });
  });

  it("reports added, removed, changed and moved together for a mixed revision", () => {
    const before = [p("b1", "one"), p("b2", "two"), p("b3", "three"), p("b4", "four")];
    const after = [p("b3", "three EDITED"), p("b4", "four"), p("b5", "five")];
    expect(diffVersions(before, after)).toEqual({
      added: ["b5"],
      removed: ["b1", "b2"],
      changed: ["b3"],
      moved: [],
    });
    // b2 removed leaves b1..b3 -> b3..b4 relative order intact, so nothing moved.
    const reorderAndEdit = [p("b4", "four"), p("b1", "one"), p("b2", "two"), p("b3", "three EDITED")];
    expect(diffVersions(before, reorderAndEdit)).toEqual({
      added: [],
      removed: [],
      changed: ["b3"],
      moved: ["b4"],
    });
  });

  it("accepts JSON strings exactly like the equivalent array input", () => {
    const before = [p("b1", "one"), p("b2", "two")];
    const after = [p("b2", "two EDITED"), p("b3", "three")];
    expect(diffVersions(JSON.stringify(before), JSON.stringify(after))).toEqual(
      diffVersions(before, after),
    );
    expect(diffVersions(JSON.stringify(before), JSON.stringify(after))).toEqual({
      added: ["b3"],
      removed: ["b1"],
      changed: ["b2"],
      moved: [],
    });
  });

  it("never throws on malformed/legacy JSON - it degrades to the readable side", () => {
    // R30.8 no-throw rule: an unreadable snapshot is treated as empty rather
    // than crashing the history panel.
    const readable = [p("b1", "one")];
    expect(() => diffVersions("{ nope", readable)).not.toThrow();
    expect(diffVersions("{ nope", readable)).toEqual({
      added: ["b1"],
      removed: [],
      changed: [],
      moved: [],
    });
    // Correct shape (an array) but no stable ids -> not id-diffable either.
    expect(diffVersions(JSON.stringify([1, 2]), readable)).toEqual({
      added: ["b1"],
      removed: [],
      changed: [],
      moved: [],
    });
    expect(diffVersions("{ nope", "also nope")).toEqual(none);
  });
});

/**
 * M2 - Named versions (docs/MISSING_FEATURES.md §10 "Named versions" / 🧭).
 * Lib-level only: no DB column, so wiring a persistent `label` onto
 * `PageVersion` is a reported schema follow-up (R30.10), not part of this file.
 */
describe("normalizeVersionLabel (R30.10-lite)", () => {
  it("trims a label and treats blank input as unnamed", () => {
    expect(normalizeVersionLabel(undefined)).toBeNull();
    expect(normalizeVersionLabel(null)).toBeNull();
    expect(normalizeVersionLabel("")).toBeNull();
    expect(normalizeVersionLabel("   \n ")).toBeNull();
    expect(normalizeVersionLabel("  Launch day  ")).toBe("Launch day");
  });

  it("enforces the 100-char cap from R30.10", () => {
    expect(normalizeVersionLabel("x".repeat(100))).toBe("x".repeat(100));
    expect(() => normalizeVersionLabel("x".repeat(101))).toThrow(RangeError);
  });
});

describe("buildVersionRecord (R30.10-lite)", () => {
  const createdAt = new Date("2020-05-04T10:30:00.000Z");

  it("labels a snapshot and summarises it with the label + the version's own date", () => {
    const record = buildVersionRecord({ id: "v1", createdAt, label: "  v1 - launch  " });
    expect(record.id).toBe("v1");
    expect(record.createdAt).toBe(createdAt);
    expect(record.label).toBe("v1 - launch");
    expect(record.isNamed).toBe(true);
    expect(record.summary).toContain('"v1 - launch"');
    expect(record.summary).toContain(createdAt.toLocaleDateString());
    // The version's own date, never today (same rule as restoreVersionSummary).
    expect(record.summary).not.toContain(new Date().toLocaleDateString());
  });

  it("treats an absent/blank label as an ordinary auto snapshot", () => {
    for (const label of [undefined, null, "", "   "]) {
      const record = buildVersionRecord({ id: "v2", createdAt, label });
      expect(record.label).toBeNull();
      expect(record.isNamed).toBe(false);
      expect(record.summary).not.toContain("Named");
      expect(record.summary).toContain(createdAt.toLocaleDateString());
    }
  });

  it("propagates the over-cap label rejection", () => {
    expect(() =>
      buildVersionRecord({ id: "v3", createdAt, label: "x".repeat(101) }),
    ).toThrow(RangeError);
  });
});

describe("pickLatestNamedVersion (R30.10-lite)", () => {
  const at = (iso: string) => new Date(iso);

  it("returns the newest labelled snapshot, skipping newer unnamed ones", () => {
    const records = [
      buildVersionRecord({ id: "v1", createdAt: at("2020-01-01T00:00:00Z"), label: "first" }),
      // Newest row overall, but auto-generated -> not a named version.
      buildVersionRecord({ id: "v2", createdAt: at("2020-03-01T00:00:00Z") }),
      buildVersionRecord({ id: "v3", createdAt: at("2020-02-01T00:00:00Z"), label: "second" }),
    ];
    expect(pickLatestNamedVersion(records)?.id).toBe("v3");
    expect(pickLatestNamedVersion(records)?.label).toBe("second");
  });

  it("returns null when there is no named version at all", () => {
    expect(pickLatestNamedVersion([])).toBeNull();
    expect(
      pickLatestNamedVersion([buildVersionRecord({ id: "v1", createdAt: at("2020-01-01T00:00:00Z") })]),
    ).toBeNull();
  });

  it("accepts raw rows (blank label = unnamed) and breaks createdAt ties by input order", () => {
    const rows = [
      { id: "t1", createdAt: at("2020-05-04T10:30:00Z"), label: "  one  " },
      { id: "t2", createdAt: at("2020-05-04T10:30:00Z"), label: "   " },
      { id: "t3", createdAt: at("2020-05-04T10:30:00Z"), label: "two" },
      { id: "t4", createdAt: at("2020-06-01T00:00:00Z") },
    ];
    const latest = pickLatestNamedVersion(rows);
    expect(latest?.id).toBe("t1");
    expect(latest?.label).toBe("one");
    expect(latest?.isNamed).toBe(true);
  });
});
