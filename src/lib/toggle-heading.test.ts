import { describe, expect, it } from "vitest";
import {
  MAX_HEADING_LEVEL,
  MIN_HEADING_LEVEL,
  blockId,
  canToggle,
  headingSubtrees,
  indentHeading,
  isHeading,
  isValidHeadingLevel,
  normalizeHeadingLevel,
  outdentHeading,
  toggleCollapse,
  visibleBlocks,
  type ToggleBlock,
} from "./toggle-heading";

/**
 * Toggle heading — pure outline logic for headings that double as collapsible
 * toggles (docs/MISSING_FEATURES §1). Red-first: the ownership rule and the
 * malformed-level handling are product decisions pinned here.
 *
 * A heading of level L owns every following block until the next heading of
 * level <= L; collapsing it hides exactly that owned run (nested headings and
 * their contents included). Toggle headings exist only at levels 1–3.
 */

const h = (id: string, level: number | undefined, extra: Partial<ToggleBlock> = {}): ToggleBlock => ({
  id,
  type: "heading",
  level,
  ...extra,
});
const p = (id: string): ToggleBlock => ({ id, type: "paragraph" });

/**
 *  a  (h1)
 *    a1
 *    b  (h2)
 *      b1
 *      b2
 *      c  (h3)
 *        c1
 *  d  (h1)
 *    d1
 */
const doc: ToggleBlock[] = [
  h("a", 1),
  p("a1"),
  h("b", 2),
  p("b1"),
  p("b2"),
  h("c", 3),
  p("c1"),
  h("d", 1),
  p("d1"),
];

const ids = (blocks: readonly ToggleBlock[]) => blocks.map((b) => b.id);

describe("headingSubtrees — ownership runs", () => {
  it("gives each heading the run up to the next heading of <= its level", () => {
    expect(headingSubtrees(doc)).toEqual([
      { headingId: "a", childIds: ["a1", "b", "b1", "b2", "c", "c1"] },
      { headingId: "b", childIds: ["b1", "b2", "c", "c1"] },
      { headingId: "c", childIds: ["c1"] },
      { headingId: "d", childIds: ["d1"] },
    ]);
  });

  it("nests a deeper heading under a shallower one but not vice versa", () => {
    const blocks = [h("outer", 1), h("inner", 2), p("x"), h("back", 1), p("y")];
    expect(headingSubtrees(blocks)).toEqual([
      { headingId: "outer", childIds: ["inner", "x"] },
      { headingId: "inner", childIds: ["x"] },
      { headingId: "back", childIds: ["y"] },
    ]);
  });

  it("gives a heading with no following content an empty run", () => {
    expect(headingSubtrees([h("only", 2)])).toEqual([{ headingId: "only", childIds: [] }]);
    expect(headingSubtrees([p("p1"), h("last", 1)])).toEqual([
      { headingId: "last", childIds: [] },
    ]);
  });

  it("returns [] for an empty document or a document with no headings", () => {
    expect(headingSubtrees([])).toEqual([]);
    expect(headingSubtrees([p("p1"), p("p2")])).toEqual([]);
  });

  it("stops a run at an equal-level heading", () => {
    const blocks = [h("one", 2), p("x"), h("two", 2), p("y")];
    expect(headingSubtrees(blocks)).toEqual([
      { headingId: "one", childIds: ["x"] },
      { headingId: "two", childIds: ["y"] },
    ]);
  });

  it("normalises malformed levels instead of crashing the walk", () => {
    const blocks = [h("bad", 0), p("x"), h("worse", Number.NaN), p("y")];
    // Both malformed headings normalise to level 1: `bad` owns x, and the
    // equal-level `worse` closes its run.
    expect(headingSubtrees(blocks)).toEqual([
      { headingId: "bad", childIds: ["x"] },
      { headingId: "worse", childIds: ["y"] },
    ]);
  });
});

describe("toggleCollapse — pure set edit", () => {
  it("opens by removing and closes by adding the heading id", () => {
    expect([...toggleCollapse(new Set<string>(), "a")]).toEqual(["a"]);
    expect([...toggleCollapse(new Set(["a", "b"]), "a")]).toEqual(["b"]);
  });

  it("never mutates the input set and returns a fresh instance", () => {
    const state = new Set<string>(["a"]);
    const next = toggleCollapse(state, "b");
    expect([...state]).toEqual(["a"]);
    expect(next).not.toBe(state);
  });

  it("toggling the same heading twice is a round trip", () => {
    const once = toggleCollapse(new Set<string>(), "a");
    expect([...toggleCollapse(once, "a")]).toEqual([]);
  });
});

describe("visibleBlocks — collapsed runs are hidden", () => {
  it("returns every block in order when nothing is collapsed", () => {
    expect(ids(visibleBlocks(doc, new Set()))).toEqual([
      "a",
      "a1",
      "b",
      "b1",
      "b2",
      "c",
      "c1",
      "d",
      "d1",
    ]);
  });

  it("hides only a collapsed heading's owned run (header stays visible)", () => {
    expect(ids(visibleBlocks(doc, new Set(["a"])))).toEqual(["a", "d", "d1"]);
    expect(ids(visibleBlocks(doc, new Set(["b"])))).toEqual(["a", "a1", "b", "d", "d1"]);
    expect(ids(visibleBlocks(doc, new Set(["c"])))).toEqual([
      "a",
      "a1",
      "b",
      "b1",
      "b2",
      "c",
      "d",
      "d1",
    ]);
  });

  it("unions nested collapses so a parent collapses everything below it", () => {
    const both = ids(visibleBlocks(doc, new Set(["a", "b"])));
    expect(both).toEqual(["a", "d", "d1"]);
  });

  it("ignores collapsed ids that are not headings or are unknown", () => {
    expect(ids(visibleBlocks(doc, new Set(["a1", "missing"])))).toEqual(ids(doc));
  });

  it("handles an empty document and never mutates its input", () => {
    expect(visibleBlocks([], new Set(["a"]))).toEqual([]);
    const snapshot = JSON.parse(JSON.stringify(doc)) as ToggleBlock[];
    visibleBlocks(doc, new Set(["a"]));
    expect(doc).toEqual(snapshot);
  });
});

describe("indentHeading / outdentHeading — level changes within 1..3", () => {
  it("indents one level deeper until the cap", () => {
    expect(indentHeading(1)).toBe(2);
    expect(indentHeading(2)).toBe(3);
    expect(indentHeading(3)).toBeNull();
    expect(MAX_HEADING_LEVEL).toBe(3);
  });

  it("outdents one level shallower until the floor", () => {
    expect(outdentHeading(3)).toBe(2);
    expect(outdentHeading(2)).toBe(1);
    expect(outdentHeading(1)).toBeNull();
    expect(MIN_HEADING_LEVEL).toBe(1);
  });

  it("rejects malformed input levels", () => {
    for (const bad of [0, 4, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(indentHeading(bad)).toBeNull();
      expect(outdentHeading(bad)).toBeNull();
    }
  });
});

describe("canToggle / isHeading / levels — validation", () => {
  it("allows toggle headings at levels 1..3 only", () => {
    expect(canToggle(h("a", 1))).toBe(true);
    expect(canToggle(h("b", 2))).toBe(true);
    expect(canToggle(h("c", 3))).toBe(true);
    expect(canToggle(h("d", 4))).toBe(false);
    expect(canToggle(h("e", 0))).toBe(false);
    expect(canToggle(h("f", 2.5))).toBe(false);
    expect(canToggle(h("g", undefined))).toBe(false);
  });

  it("rejects non-heading blocks even when they carry a level", () => {
    expect(canToggle(p("p1"))).toBe(false);
    expect(canToggle({ id: "x", type: "toggle", level: 2 })).toBe(false);
    expect(canToggle(undefined as unknown as ToggleBlock)).toBe(false);
  });

  it("detects headings by type", () => {
    expect(isHeading(h("a", 1))).toBe(true);
    expect(isHeading(p("p1"))).toBe(false);
  });

  it("validates integer levels inside the supported range", () => {
    expect([1, 2, 3].every(isValidHeadingLevel)).toBe(true);
    expect([0, 4, 1.5, Number.NaN, undefined, "2"].some(isValidHeadingLevel)).toBe(false);
  });

  it("normalises malformed levels by clamping/number-coercing", () => {
    expect(normalizeHeadingLevel(1)).toBe(1);
    expect(normalizeHeadingLevel(2.9)).toBe(2);
    expect(normalizeHeadingLevel(0)).toBe(MIN_HEADING_LEVEL);
    expect(normalizeHeadingLevel(-5)).toBe(MIN_HEADING_LEVEL);
    expect(normalizeHeadingLevel(9)).toBe(MAX_HEADING_LEVEL);
    expect(normalizeHeadingLevel(undefined)).toBe(MIN_HEADING_LEVEL);
    expect(normalizeHeadingLevel(Number.NaN)).toBe(MIN_HEADING_LEVEL);
  });
});

describe("blockId — stable identity with index fallback", () => {
  it("prefers a non-empty string id", () => {
    expect(blockId({ id: "abc", type: "paragraph" }, 3)).toBe("abc");
  });

  it("falls back to the positional id for missing/empty ids", () => {
    expect(blockId({ type: "paragraph" }, 0)).toBe("#0");
    expect(blockId({ id: "  ", type: "heading", level: 1 }, 4)).toBe("#4");
  });
});
