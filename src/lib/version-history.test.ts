import { describe, expect, it } from "vitest";
import {
  DEFAULT_RETENTION,
  DEFAULT_SNAPSHOT_INTERVAL_MS,
  FORMER_MEMBER_LABEL,
  attributeBlocks,
  buildVersionRecord,
  diffVersions,
  normalizeVersionLabel,
  pickLatestNamedVersion,
  pickVersionAuthor,
  pruneVersions,
  resolveVersionAuthorship,
  restoreVersionSummary,
  shouldSnapshot,
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

/**
 * M3 slice - the four remaining section-10 behaviours, still lib-level:
 * cadence (R30.3), retention (R30.7), authorship fields (R30.11) and
 * block-level attribution (R30.16 stage 1). Written BEFORE the exports existed
 * (named-import error -> suite red), then implemented to green.
 */

describe("shouldSnapshot (R30.3 cadence)", () => {
  const now = new Date("2021-01-01T12:00:00.000Z");
  const at = (msAgo: number) => new Date(now.getTime() - msAgo);

  it("always snapshots when there is no previous row", () => {
    expect(shouldSnapshot(null, now)).toBe(true);
    expect(shouldSnapshot(undefined, now)).toBe(true);
  });

  it("uses a 5-minute default window (R30.3/D2)", () => {
    expect(DEFAULT_SNAPSHOT_INTERVAL_MS).toBe(5 * 60 * 1000);
    expect(shouldSnapshot({ createdAt: at(5 * 60 * 1000 - 1) }, now)).toBe(false);
    expect(shouldSnapshot({ createdAt: at(5 * 60 * 1000) }, now)).toBe(true);
    expect(shouldSnapshot({ createdAt: at(5 * 60 * 1000 + 1) }, now)).toBe(true);
  });

  it("honours a custom minIntervalMs", () => {
    const options = { minIntervalMs: 1000 };
    expect(shouldSnapshot({ createdAt: at(999) }, now, options)).toBe(false);
    expect(shouldSnapshot({ createdAt: at(1000) }, now, options)).toBe(true);
  });

  it("skips an unchanged payload even when the window has elapsed (R30.3 dedupe)", () => {
    expect(shouldSnapshot({ createdAt: at(60 * 60 * 1000) }, now, { changed: false })).toBe(false);
    expect(shouldSnapshot(null, now, { changed: false })).toBe(false);
    // Omitting `changed` is the pure clock gate (assume changed).
    expect(shouldSnapshot({ createdAt: at(60 * 60 * 1000) }, now)).toBe(true);
  });

  it("treats a non-positive window as always due", () => {
    expect(shouldSnapshot({ createdAt: now }, now, { minIntervalMs: 0 })).toBe(true);
  });
});

describe("pruneVersions (R30.7 retention tiers)", () => {
  const now = new Date("2021-06-01T12:00:00.000Z");
  const DAY_MS = 24 * 60 * 60 * 1000;
  const WEEK_MS = 7 * DAY_MS;
  const days = (n: number) => new Date(now.getTime() - n * DAY_MS);
  const row = (id: string, createdAt: Date, label?: string | null) => ({ id, createdAt, label });

  it("publishes the D3 defaults", () => {
    expect(DEFAULT_RETENTION).toEqual({ fullFidelityDays: 30, dailyWindowDays: 90, maxRows: 500 });
  });

  it("keeps everything inside the full-fidelity window, in input order", () => {
    const rows = [row("a", days(0)), row("b", days(10)), row("c", days(29))];
    const result = pruneVersions(rows, now);
    expect(result.keep.map((entry) => entry.id)).toEqual(["a", "b", "c"]);
    expect(result.prune).toEqual([]);
    expect(result.prunedIds).toEqual([]);
  });

  it("never prunes labelled rows, however old", () => {
    const rows = [row("pinned", days(400), "keep me"), row("newest", days(1))];
    const result = pruneVersions(rows, now);
    expect(result.prunedIds).toEqual([]);
    expect(result.keep.map((entry) => entry.id)).toEqual(["pinned", "newest"]);
  });

  it("never prunes the newest row even beyond every tier", () => {
    const rows = [row("newest", days(500)), row("older", days(501))];
    const result = pruneVersions(rows, now, { maxRows: 1 });
    expect(result.prunedIds).toEqual(["older"]);
    expect(result.keep.map((entry) => entry.id)).toEqual(["newest"]);
  });

  it("thins the daily tier to one row per UTC day (keeping the newest)", () => {
    const base = days(40).getTime();
    const dayStart = Math.floor(base / DAY_MS) * DAY_MS;
    const older = row("older", new Date(dayStart + 1000));
    const newer = row("newer", new Date(dayStart + 2000));
    const result = pruneVersions([older, newer], now);
    expect(result.prunedIds).toEqual(["older"]);
    expect(result.keep.map((entry) => entry.id)).toEqual(["newer"]);
  });

  it("treats the 30-day boundary as the daily tier (age >= fullFidelityDays)", () => {
    const base = days(30).getTime();
    const dayStart = Math.floor(base / DAY_MS) * DAY_MS;
    const older = row("older", new Date(dayStart + 1000));
    const newer = row("newer", new Date(dayStart + 2000));
    expect(pruneVersions([older, newer], now).prunedIds).toEqual(["older"]);
  });

  it("thins beyond the daily window to one row per 7-day bucket", () => {
    const base = days(100).getTime();
    const weekStart = Math.floor(base / WEEK_MS) * WEEK_MS;
    const older = row("older", new Date(weekStart + 1000));
    const newer = row("newer", new Date(weekStart + 2000));
    const result = pruneVersions([older, newer], now);
    expect(result.prunedIds).toEqual(["older"]);
    expect(result.keep.map((entry) => entry.id)).toEqual(["newer"]);
  });

  it("caps unlabelled rows, pruning the oldest first", () => {
    const rows = [row("n1", days(1)), row("n2", days(2)), row("n3", days(3)), row("n4", days(4))];
    const result = pruneVersions(rows, now, { maxRows: 2 });
    expect(result.prunedIds).toEqual(["n3", "n4"]);
    expect(result.keep.map((entry) => entry.id)).toEqual(["n1", "n2"]);
  });

  it("does not count labelled rows toward the cap", () => {
    const rows = [
      row("auto1", days(1)),
      row("auto2", days(2)),
      row("auto3", days(3)),
      row("pinned", days(4), "pinned"),
    ];
    const result = pruneVersions(rows, now, { maxRows: 2 });
    expect(result.prunedIds).toEqual(["auto3"]);
    expect(result.keep.map((entry) => entry.id)).toEqual(["auto1", "auto2", "pinned"]);
  });
});

describe("resolveVersionAuthorship (R30.11)", () => {
  const users = [
    { id: "u1", name: "Ada Lovelace", email: "ada@example.test" },
    { id: "u2", name: "Grace Hopper", email: "grace@example.test" },
  ];

  it("resolves a present author to their name", () => {
    const authorship = resolveVersionAuthorship("u2", users);
    expect(authorship.createdById).toBe("u2");
    expect(authorship.author).toEqual(users[1]);
    expect(authorship.label).toBe("Grace Hopper");
    expect(authorship.isFormerMember).toBe(false);
  });

  it("renders a stable former-member label for a departed/deleted author", () => {
    const authorship = resolveVersionAuthorship("deleted-user", users);
    expect(authorship.author).toBeNull();
    expect(authorship.label).toBe(FORMER_MEMBER_LABEL);
    expect(authorship.isFormerMember).toBe(true);
  });

  it("carries no label when the row never had an author", () => {
    for (const id of [null, undefined, ""]) {
      const authorship = resolveVersionAuthorship(id, users);
      expect(authorship.createdById).toBeNull();
      expect(authorship.author).toBeNull();
      expect(authorship.label).toBeNull();
      expect(authorship.isFormerMember).toBe(false);
    }
  });
});

describe("buildVersionRecord authorship fields (R30.11)", () => {
  const createdAt = new Date("2020-05-04T10:30:00.000Z");
  const users = [{ id: "u1", name: "Ada Lovelace", email: "ada@example.test" }];

  it("attaches resolved authorship when given an author id + users", () => {
    const record = buildVersionRecord({ id: "v1", createdAt, createdById: "u1", users });
    expect(record.authorship.label).toBe("Ada Lovelace");
    expect(record.authorship.isFormerMember).toBe(false);
  });

  it("marks a departed author without changing the label or the summary", () => {
    const record = buildVersionRecord({ id: "v1", createdAt, label: "keep", createdById: "gone", users });
    expect(record.authorship.isFormerMember).toBe(true);
    expect(record.authorship.label).toBe(FORMER_MEMBER_LABEL);
    expect(record.label).toBe("keep");
    expect(record.summary).toContain(createdAt.toLocaleDateString());
  });

  it("defaults to no authorship when the input carries none", () => {
    const record = buildVersionRecord({ id: "v1", createdAt });
    expect(record.authorship).toEqual({
      createdById: null,
      author: null,
      label: null,
      isFormerMember: false,
    });
  });
});

describe("attributeBlocks (R30.16 block-level attribution)", () => {
  const p = (id: string, text: string) => ({
    id,
    type: "paragraph",
    content: [{ type: "text", text }],
  });

  it("attributes every block as unchanged for identical snapshots", () => {
    const doc = [p("b1", "one"), p("b2", "two")];
    const attributed = attributeBlocks(doc, doc);
    expect(attributed.map((entry) => [entry.id, entry.kind, entry.changed, entry.moved])).toEqual([
      ["b1", "unchanged", false, false],
      ["b2", "unchanged", false, false],
    ]);
    expect(attributed[0]).toMatchObject({ aIndex: 0, bIndex: 0, before: doc[0], after: doc[0] });
  });

  it("attributes an insert with a null a-side and a positional b index", () => {
    const before = [p("b1", "one"), p("b3", "three")];
    const after = [p("b1", "one"), p("b2", "two"), p("b3", "three")];
    const attributed = attributeBlocks(before, after);
    expect(attributed.map((entry) => entry.id)).toEqual(["b1", "b2", "b3"]);
    expect(attributed[1]).toMatchObject({
      id: "b2",
      kind: "added",
      aIndex: null,
      bIndex: 1,
      before: null,
    });
    expect(attributed[1].after).toEqual(after[1]);
  });

  it("attributes a delete on the a-side after the b-ordered blocks", () => {
    const before = [p("b1", "one"), p("b2", "two"), p("b3", "three")];
    const after = [p("b1", "one"), p("b3", "three")];
    const attributed = attributeBlocks(before, after);
    expect(attributed.map((entry) => [entry.id, entry.kind])).toEqual([
      ["b1", "unchanged"],
      ["b3", "unchanged"],
      ["b2", "removed"],
    ]);
    expect(attributed[2]).toMatchObject({ aIndex: 1, bIndex: null, after: null });
  });

  it("attributes an edit as changed with both payloads attached", () => {
    const before = [p("b1", "one"), p("b2", "two")];
    const after = [p("b1", "one"), p("b2", "two EDITED")];
    const edited = attributeBlocks(before, after)[1];
    expect(edited).toMatchObject({
      id: "b2",
      kind: "changed",
      changed: true,
      moved: false,
      aIndex: 1,
      bIndex: 1,
    });
    expect(edited.before).toEqual(before[1]);
    expect(edited.after).toEqual(after[1]);
  });

  it("attributes a reorder as moved, and an edit + move as changed + moved", () => {
    const before = [p("b1", "one"), p("b2", "two"), p("b3", "three")];
    const reordered = attributeBlocks(before, [p("b3", "three"), p("b1", "one"), p("b2", "two")]);
    expect(reordered.find((entry) => entry.id === "b3")).toMatchObject({
      kind: "moved",
      moved: true,
      changed: false,
    });
    const editedMove = attributeBlocks(before, [p("b3", "three EDITED"), p("b1", "one"), p("b2", "two")]);
    expect(editedMove.find((entry) => entry.id === "b3")).toMatchObject({
      kind: "changed",
      changed: true,
      moved: true,
    });
  });

  it("accepts JSON strings and never throws on malformed input", () => {
    const before = [p("b1", "one")];
    expect(() => attributeBlocks("{ nope", before)).not.toThrow();
    expect(attributeBlocks("{ nope", before).map((entry) => entry.kind)).toEqual(["added"]);
    expect(attributeBlocks(JSON.stringify(before), JSON.stringify(before))[0].kind).toBe("unchanged");
  });
});
