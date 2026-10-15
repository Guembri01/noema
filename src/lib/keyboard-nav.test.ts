import { describe, expect, it } from "vitest";
import {
  DEFAULT_PAGE_STEP,
  nextIndex,
  pageStepIndex,
  rovingTabIndex,
  typeaheadIndex,
} from "@/lib/keyboard-nav";

/**
 * H2 — keyboard navigation index math.
 *
 * The arrow/Home/End stepping, the roving tab index a toolbar exposes, the
 * single-key typeahead of a listbox and the PageUp/PageDown jump share one
 * rule: given a cursor and a collection size, hand back a safe, in-range index
 * (or `-1` when there is nothing to point at), deterministically and without
 * touching the input.
 */
describe("nextIndex", () => {
  it("steps down through the list and wraps past the end", () => {
    expect(nextIndex(0, { key: "ArrowDown", count: 3 })).toBe(1);
    expect(nextIndex(1, { key: "ArrowDown", count: 3 })).toBe(2);
    expect(nextIndex(2, { key: "ArrowDown", count: 3 })).toBe(0);
  });

  it("steps up through the list and wraps before the start", () => {
    expect(nextIndex(2, { key: "ArrowUp", count: 3 })).toBe(1);
    expect(nextIndex(1, { key: "ArrowUp", count: 3 })).toBe(0);
    expect(nextIndex(0, { key: "ArrowUp", count: 3 })).toBe(2);
  });

  it("jumps to the ends for Home and End", () => {
    expect(nextIndex(1, { key: "Home", count: 5 })).toBe(0);
    expect(nextIndex(1, { key: "End", count: 5 })).toBe(4);
    expect(nextIndex(99, { key: "Home", count: 5 })).toBe(0);
  });

  it("clamps instead of wrapping when wrap is disabled", () => {
    expect(nextIndex(2, { key: "ArrowDown", count: 3, wrap: false })).toBe(2);
    expect(nextIndex(0, { key: "ArrowUp", count: 3, wrap: false })).toBe(0);
    expect(nextIndex(0, { key: "ArrowDown", count: 3, wrap: false })).toBe(1);
  });

  it("pins an out-of-range cursor into the list before stepping", () => {
    expect(nextIndex(99, { key: "ArrowUp", count: 3 })).toBe(1);
    expect(nextIndex(-4, { key: "ArrowDown", count: 3 })).toBe(1);
  });

  it("stays put on a single-row list", () => {
    expect(nextIndex(0, { key: "ArrowDown", count: 1 })).toBe(0);
    expect(nextIndex(0, { key: "ArrowUp", count: 1 })).toBe(0);
  });

  it("reports no cursor for an empty list", () => {
    expect(nextIndex(0, { key: "ArrowDown", count: 0 })).toBe(-1);
    expect(nextIndex(0, { key: "End", count: -3 })).toBe(-1);
  });
});

describe("rovingTabIndex", () => {
  it("returns the clamped active index", () => {
    expect(rovingTabIndex(2, 5)).toBe(2);
    expect(rovingTabIndex(0, 5)).toBe(0);
    expect(rovingTabIndex(4, 5)).toBe(4);
  });

  it("clamps an out-of-range cursor into the list", () => {
    expect(rovingTabIndex(99, 5)).toBe(4);
    expect(rovingTabIndex(-2, 5)).toBe(0);
    expect(rovingTabIndex(3.9, 5)).toBe(3);
  });

  it("has no focusable index for an empty list", () => {
    expect(rovingTabIndex(0, 0)).toBe(-1);
    expect(rovingTabIndex(3, -1)).toBe(-1);
  });
});

describe("typeaheadIndex", () => {
  const items = ["Apple", "Banana", "Blueberry", "Cherry", "apricot"];

  it("finds the first prefix match from the top", () => {
    expect(typeaheadIndex(items, "b", -1)).toBe(1);
    expect(typeaheadIndex(items, "Ap", -1)).toBe(0);
  });

  it("is case-insensitive", () => {
    expect(typeaheadIndex(items, "APR", -1)).toBe(4);
    expect(typeaheadIndex(items, "ch", -1)).toBe(3);
  });

  it("searches forward and wraps to cycle repeated presses", () => {
    expect(typeaheadIndex(items, "b", 1)).toBe(2);
    expect(typeaheadIndex(items, "b", 2)).toBe(1);
    expect(typeaheadIndex(["Sun", "Mon", "Sat"], "s", 1)).toBe(2);
  });

  it("returns -1 when nothing matches", () => {
    expect(typeaheadIndex(items, "z", -1)).toBe(-1);
    expect(typeaheadIndex([], "a", -1)).toBe(-1);
    expect(typeaheadIndex(items, "", -1)).toBe(-1);
  });

  it("does not mutate the input list", () => {
    const list = ["One", "Two"];
    typeaheadIndex(list, "t", -1);
    expect(list).toEqual(["One", "Two"]);
  });
});

describe("pageStepIndex", () => {
  it("jumps a whole page down and clamps at the last row", () => {
    expect(pageStepIndex(0, { key: "PageDown", count: 50 })).toBe(DEFAULT_PAGE_STEP);
    expect(pageStepIndex(45, { key: "PageDown", count: 50 })).toBe(49);
  });

  it("jumps a whole page up and clamps at the first row", () => {
    expect(pageStepIndex(25, { key: "PageUp", count: 50 })).toBe(15);
    expect(pageStepIndex(4, { key: "PageUp", count: 50 })).toBe(0);
  });

  it("honours a custom step", () => {
    expect(pageStepIndex(3, { key: "PageDown", count: 20, step: 5 })).toBe(8);
    expect(pageStepIndex(3, { key: "PageUp", count: 20, step: 5 })).toBe(0);
  });

  it("clamps the cursor before stepping and rejects a non-positive step", () => {
    expect(pageStepIndex(99, { key: "PageUp", count: 20 })).toBe(9);
    expect(pageStepIndex(4, { key: "PageDown", count: 20, step: 0 })).toBe(14);
  });

  it("reports no cursor for an empty list", () => {
    expect(pageStepIndex(0, { key: "PageDown", count: 0 })).toBe(-1);
    expect(pageStepIndex(2, { key: "PageUp", count: 0 })).toBe(-1);
  });
});
