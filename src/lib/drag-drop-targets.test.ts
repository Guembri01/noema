import { describe, expect, it } from "vitest";
import {
  canDrop,
  dropIndicatorStyle,
  moveWithinList,
  resolveDropTarget,
  type DropRect,
} from "@/lib/drag-drop-targets";

/**
 * F6 — drag-and-drop target resolution (docs/MISSING_FEATURES.md, "Drag &
 * drop"): the pure hit-testing kernel behind dropping a row/card between or
 * onto its peers.
 *
 * Red-first: `src/lib/drag-drop-targets.ts` did not exist when this file was
 * written, so the whole suite fails on the missing module until the pure
 * resolver lands. Everything here is data in / data out — no DOM, no React —
 * and every helper must leave its inputs untouched.
 */

const rects: DropRect[] = [
  { id: "a", top: 0, height: 40 },
  { id: "b", top: 40, height: 40 },
  { id: "c", top: 80, height: 40 },
];

describe("drag-drop-targets: resolveDropTarget", () => {
  it("returns `inside` index 0 for an empty list", () => {
    expect(resolveDropTarget([], 123)).toEqual({ index: 0, mode: "inside" });
  });

  it("resolves above the first row to `before` it", () => {
    expect(resolveDropTarget(rects, -10)).toEqual({ index: 0, mode: "before" });
    expect(resolveDropTarget(rects, 0)).toEqual({ index: 0, mode: "before" });
  });

  it("resolves below the last row to `after` it", () => {
    expect(resolveDropTarget(rects, 120)).toEqual({ index: 2, mode: "after" });
    expect(resolveDropTarget(rects, 999)).toEqual({ index: 2, mode: "after" });
  });

  it("uses before/after within an item's edge bands and inside in its middle", () => {
    expect(resolveDropTarget(rects, 2)).toEqual({ index: 0, mode: "before" });
    expect(resolveDropTarget(rects, 38)).toEqual({ index: 0, mode: "after" });
    expect(resolveDropTarget(rects, 20)).toEqual({ index: 0, mode: "inside" });
  });

  it("honours an explicit vertical threshold", () => {
    const big = [{ id: "a", top: 0, height: 40 }];
    expect(resolveDropTarget(big, 15, { threshold: 20 })).toEqual({
      index: 0,
      mode: "before",
    });
    expect(resolveDropTarget(big, 25, { threshold: 20 })).toEqual({
      index: 0,
      mode: "after",
    });
    expect(resolveDropTarget(big, 20, { threshold: 20 })).toEqual({
      index: 0,
      mode: "inside",
    });
  });

  it("treats a zero threshold as inside everywhere within an item", () => {
    expect(resolveDropTarget(rects, 1, { threshold: 0 })).toEqual({
      index: 0,
      mode: "inside",
    });
    expect(resolveDropTarget(rects, 39, { threshold: 0 })).toEqual({
      index: 0,
      mode: "inside",
    });
  });

  it("switches to `inside` once the pointer travels right past indentWidth", () => {
    expect(resolveDropTarget(rects, 2, { indentWidth: 24, indentOffset: 30 })).toEqual({
      index: 0,
      mode: "inside",
    });
    expect(resolveDropTarget(rects, 2, { indentWidth: 24, indentOffset: 24 })).toEqual({
      index: 0,
      mode: "inside",
    });
    expect(resolveDropTarget(rects, 2, { indentWidth: 24, indentOffset: 10 })).toEqual({
      index: 0,
      mode: "before",
    });
  });

  it("resolves a gap between rows to `before` the following row", () => {
    const spaced: DropRect[] = [
      { id: "a", top: 0, height: 20 },
      { id: "b", top: 40, height: 20 },
    ];
    expect(resolveDropTarget(spaced, 30)).toEqual({ index: 1, mode: "before" });
  });

  it("is deterministic and never mutates the rects", () => {
    const before = rects.map((r) => ({ ...r }));
    const first = resolveDropTarget(rects, 20);
    const second = resolveDropTarget(rects, 20);
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(rects).toEqual(before);
  });
});

describe("drag-drop-targets: canDrop", () => {
  // a → b → c (c is the deepest); x is unrelated.
  const parents: Record<string, string | null> = { a: null, b: "a", c: "b", x: null };
  const parentOf = (id: string): string | null => parents[id] ?? null;

  it("rejects dropping an item onto itself", () => {
    expect(canDrop("a", "a", parentOf)).toBe(false);
  });

  it("rejects dropping onto a direct child", () => {
    expect(canDrop("a", "b", parentOf)).toBe(false);
  });

  it("rejects dropping onto a deeper descendant", () => {
    expect(canDrop("a", "c", parentOf)).toBe(false);
  });

  it("allows dropping onto an ancestor, a sibling and an unrelated item", () => {
    expect(canDrop("c", "a", parentOf)).toBe(true);
    expect(canDrop("b", "x", parentOf)).toBe(true);
    expect(canDrop("a", "x", parentOf)).toBe(true);
  });

  it("allows dropping onto the root (a null parent)", () => {
    expect(canDrop("b", "a", parentOf)).toBe(true);
  });

  it("terminates safely on a malformed parent cycle", () => {
    const cyclic = (id: string): string | null => (id === "a" ? "b" : id === "b" ? "a" : null);
    expect(canDrop("z", "a", cyclic)).toBe(true);
    expect(canDrop("a", "b", cyclic)).toBe(false);
  });
});

describe("drag-drop-targets: moveWithinList", () => {
  const ids = ["a", "b", "c", "d"];

  it("moves an item down and up to the requested index", () => {
    expect(moveWithinList(ids, 0, 2)).toEqual(["b", "c", "a", "d"]);
    expect(moveWithinList(ids, 3, 1)).toEqual(["a", "d", "b", "c"]);
  });

  it("clamps the destination past either end of the list", () => {
    expect(moveWithinList(ids, 1, 99)).toEqual(["a", "c", "d", "b"]);
    expect(moveWithinList(ids, 1, -5)).toEqual(["b", "a", "c", "d"]);
  });

  it("returns a fresh, unchanged copy for an out-of-range source", () => {
    const copy = moveWithinList(ids, 9, 0);
    expect(copy).toEqual(ids);
    expect(copy).not.toBe(ids);
    expect(moveWithinList(ids, -1, 0)).toEqual(ids);
  });

  it("never mutates the input array", () => {
    const before = [...ids];
    moveWithinList(ids, 0, 3);
    expect(ids).toEqual(before);
  });
});

describe("drag-drop-targets: dropIndicatorStyle", () => {
  it("draws a top border for a `before` drop", () => {
    expect(dropIndicatorStyle({ index: 0, mode: "before" })).toEqual({
      borderTop: "2px solid var(--accent)",
    });
  });

  it("draws a bottom border for an `after` drop", () => {
    expect(dropIndicatorStyle({ index: 2, mode: "after" })).toEqual({
      borderBottom: "2px solid var(--accent)",
    });
  });

  it("draws an inset outline for an `inside` drop", () => {
    expect(dropIndicatorStyle({ index: 1, mode: "inside" })).toEqual({
      outline: "2px solid var(--accent)",
      outlineOffset: "-2px",
    });
  });
});
