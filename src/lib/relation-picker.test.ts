import { describe, expect, it } from "vitest";
import {
  applyTwoWayRelation,
  queryRelationCandidates,
  relationSummary,
  toggleRelation,
  type RelationCandidate,
} from "./relation-picker";

/**
 * Red-first suite for the relation picker + two-way relation helpers
 * (docs/specs/relations-rollups.md R21.5 picker, R21.7/R21.9 two-way writes;
 * FEATURE_MATRIX rows 290-293 "Relation property/single/multi/two-way" and
 * :727 "Ticket relations").
 *
 * The module owns the *pure* half: candidate filtering for the searchable
 * picker, the single/multi selection toggle, a human-readable summary for an
 * aria label, and the reciprocal write a two-way relation needs. No Prisma, no
 * React, no I/O.
 */

const candidates: RelationCandidate[] = [
  { id: "a", title: "Alpha" },
  { id: "b", title: "Beta" },
  { id: "c", title: "Gamma" },
  { id: "d", title: "Alpha Two" },
];

describe("queryRelationCandidates — picker filtering", () => {
  it("matches the title case-insensitively and trims the query", () => {
    expect(queryRelationCandidates(candidates, { query: "  ALPH  " }).map((c) => c.id)).toEqual([
      "a",
      "d",
    ]);
  });

  it("returns every candidate for an absent or blank query", () => {
    expect(queryRelationCandidates(candidates).map((c) => c.id)).toEqual(["a", "b", "c", "d"]);
    expect(queryRelationCandidates(candidates, { query: "   " }).map((c) => c.id)).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
  });

  it("hides already-linked ids in single-select mode", () => {
    expect(
      queryRelationCandidates(candidates, { excludeIds: ["b"], allowMultiple: false }).map(
        (c) => c.id,
      ),
    ).toEqual(["a", "c", "d"]);
  });

  it("keeps already-linked ids in multi-select mode so they can be unchecked", () => {
    expect(
      queryRelationCandidates(candidates, { excludeIds: ["b"], allowMultiple: true }).map(
        (c) => c.id,
      ),
    ).toEqual(["a", "b", "c", "d"]);
  });

  it("always drops the current row (self), even in multi-select mode", () => {
    expect(
      queryRelationCandidates(candidates, { selfId: "c", allowMultiple: true }).map((c) => c.id),
    ).toEqual(["a", "b", "d"]);
  });

  it("de-duplicates candidates by id, keeping the first occurrence", () => {
    const dupes: RelationCandidate[] = [
      { id: "a", title: "Alpha" },
      { id: "a", title: "Alpha (stale)" },
      { id: "b", title: "Beta" },
    ];
    const out = queryRelationCandidates(dupes);
    expect(out.map((c) => c.id)).toEqual(["a", "b"]);
    expect(out[0]?.title).toBe("Alpha");
  });

  it("skips entries with a missing or empty id", () => {
    const junk = [{ id: "", title: "blank" }, { id: "a", title: "Alpha" }] as RelationCandidate[];
    expect(queryRelationCandidates(junk).map((c) => c.id)).toEqual(["a"]);
  });

  it("applies a limit, treats zero as empty and an absent limit as no cap", () => {
    expect(queryRelationCandidates(candidates, { limit: 2 }).map((c) => c.id)).toEqual(["a", "b"]);
    expect(queryRelationCandidates(candidates, { limit: 0 })).toEqual([]);
    expect(queryRelationCandidates(candidates, { limit: -1 }).map((c) => c.id)).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
  });

  it("combines query, exclusion and limit in one pass", () => {
    expect(
      queryRelationCandidates(candidates, { query: "al", excludeIds: ["a"], limit: 1 }).map(
        (c) => c.id,
      ),
    ).toEqual(["d"]);
  });

  it("never mutates the candidate or exclude lists", () => {
    const exclude = ["b"];
    queryRelationCandidates(candidates, { excludeIds: exclude, allowMultiple: false });
    expect(candidates.map((c) => c.id)).toEqual(["a", "b", "c", "d"]);
    expect(exclude).toEqual(["b"]);
  });
});

describe("toggleRelation — single/multi selection", () => {
  it("appends an id in multi mode without mutating the input", () => {
    const current = ["a"];
    expect(toggleRelation(current, "b", { allowMultiple: true })).toEqual(["a", "b"]);
    expect(current).toEqual(["a"]);
  });

  it("replaces the selection in single mode", () => {
    expect(toggleRelation(["a"], "b", { allowMultiple: false })).toEqual(["b"]);
  });

  it("removes an already-selected id in either mode", () => {
    expect(toggleRelation(["a", "b"], "a", { allowMultiple: true })).toEqual(["b"]);
    expect(toggleRelation(["a", "b"], "b", { allowMultiple: false })).toEqual(["a"]);
  });

  it("is reversible in multi mode (on then off restores the original)", () => {
    const on = toggleRelation(["a"], "b", { allowMultiple: true });
    expect(toggleRelation(on, "b", { allowMultiple: true })).toEqual(["a"]);
  });

  it("ignores a blank id and cleans duplicate/empty ids from the current list", () => {
    expect(toggleRelation(["a"], "", { allowMultiple: true })).toEqual(["a"]);
    expect(toggleRelation(["a", "a", ""], "b", { allowMultiple: true })).toEqual(["a", "b"]);
  });
});

describe("relationSummary — human-readable label", () => {
  const byId = new Map<string, { readonly title: string }>([
    ["a", { title: "Alpha" }],
    ["b", { title: "Beta" }],
  ]);

  it("reports the empty state", () => {
    expect(relationSummary([], byId)).toBe("No related pages");
  });

  it("singularises one link", () => {
    expect(relationSummary(["a"], byId)).toBe("1 related page: Alpha");
  });

  it("pluralises several links in selection order", () => {
    expect(relationSummary(["a", "b"], byId)).toBe("2 related pages: Alpha, Beta");
  });

  it("falls back to the id for a dangling link and de-duplicates ids", () => {
    expect(relationSummary(["x"], byId)).toBe("1 related page: x");
    expect(relationSummary(["a", "a"], byId)).toBe("1 related page: Alpha");
  });
});

describe("applyTwoWayRelation — reciprocal write", () => {
  it("exchanges the two sides so each lists the other", () => {
    expect(applyTwoWayRelation(["a"], ["b", "c"])).toEqual({
      sourceIds: ["b", "c"],
      targetIds: ["a"],
    });
  });

  it("cleans and de-duplicates both sides", () => {
    expect(applyTwoWayRelation(["a", "a", ""], ["b", "b"])).toEqual({
      sourceIds: ["b"],
      targetIds: ["a"],
    });
  });

  it("is an involution — applying it twice restores the cleaned inputs", () => {
    const once = applyTwoWayRelation(["a"], ["b", "c"]);
    expect(applyTwoWayRelation(once.sourceIds, once.targetIds)).toEqual({
      sourceIds: ["a"],
      targetIds: ["b", "c"],
    });
  });

  it("never mutates its inputs", () => {
    const source = ["a"];
    const target = ["b"];
    applyTwoWayRelation(source, target);
    expect(source).toEqual(["a"]);
    expect(target).toEqual(["b"]);
  });
});
