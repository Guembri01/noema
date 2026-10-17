/**
 * Node acceptance for the database views' motion helpers (`group-motion.ts`).
 *
 * The reordering/reveal arithmetic and the token-only styles are pure, so they
 * are pinned here without a DOM. `view-renderers.tsx` wires them into the table,
 * list and board renderers; the FLIP slide itself is `@/lib/layout-shift`'s job
 * and is tested there.
 */
import { describe, expect, it } from "vitest";
import { DUR } from "@/lib/design-tokens";
import {
  ROW_MOTION_MS,
  enteredIds,
  groupChevronClass,
  leftIds,
  retainLeaving,
  rowIdsKey,
  rowMotionClass,
  rowMotionState,
  rowMotionStyle,
  sameIds,
} from "./group-motion";

describe("row id signatures", () => {
  it("compares id sequences by value, order included", () => {
    expect(sameIds(["a", "b"], ["a", "b"])).toBe(true);
    expect(sameIds(["a", "b"], ["b", "a"])).toBe(false);
    expect(sameIds(["a"], ["a", "b"])).toBe(false);
    expect(sameIds([], [])).toBe(true);
  });

  it("reports the rows that entered and the rows that left", () => {
    expect(enteredIds(["a", "b"], ["a", "b", "c"])).toEqual(["c"]);
    expect(enteredIds(["a", "b"], ["b", "a"])).toEqual([]);
    expect(leftIds(["a", "b", "c"], ["a", "c"])).toEqual(["b"]);
    expect(leftIds(["a", "b"], ["b", "a"])).toEqual([]);
  });

  it("folds the ordered ids into one stable dependency value", () => {
    expect(rowIdsKey(["a", "b", "c"])).toBe(rowIdsKey(["a", "b", "c"]));
    expect(rowIdsKey(["a", "b", "c"])).not.toBe(rowIdsKey(["b", "a", "c"]));
    // A cell edit changes content, never the id signature.
    expect(rowIdsKey(["a"])).toBe(rowIdsKey(["a"]));
  });
});

describe("retainLeaving — one slot for a removed row while it fades", () => {
  const keyOf = (item: { id: string }) => item.id;
  const item = (id: string) => ({ id });

  it("puts a removed row back at the index it held", () => {
    expect(retainLeaving([item("a"), item("c")], [item("a"), item("b"), item("c")], keyOf)).toEqual([
      item("a"),
      item("b"),
      item("c"),
    ]);
  });

  it("restores several removed rows in their old order", () => {
    expect(retainLeaving([item("b")], [item("a"), item("b"), item("c")], keyOf)).toEqual([
      item("a"),
      item("b"),
      item("c"),
    ]);
  });

  it("restores the whole list when everything left, and is a copy otherwise", () => {
    expect(retainLeaving([], [item("a"), item("b")], keyOf)).toEqual([item("a"), item("b")]);
    expect(retainLeaving([item("a")], [], keyOf)).toEqual([item("a")]);
  });

  it("never undoes a reorder: present rows keep the current order", () => {
    // `c` moved in front of `a`; the exited `b` is re-inserted at the slot it
    // held (between `c` and `a` by its old index) — the present rows never
    // move to make room for a row that is on its way out.
    expect(retainLeaving([item("c"), item("a")], [item("a"), item("b"), item("c")], keyOf)).toEqual([
      item("c"),
      item("b"),
      item("a"),
    ]);
    expect(
      retainLeaving([item("c"), item("a")], [item("a"), item("b"), item("c")], keyOf)
        .filter((entry) => entry.id !== "b")
        .map((entry) => entry.id),
    ).toEqual(["c", "a"]);
  });

  it("does not mutate its inputs", () => {
    const current = [item("a")];
    const previous = [item("a"), item("b")];
    const snapshot = [...previous];
    retainLeaving(current, previous, keyOf);
    expect(previous).toEqual(snapshot);
    expect(current).toEqual([item("a")]);
  });
});

describe("row motion state", () => {
  it("marks a just-added row as entering and an absent one as leaving", () => {
    const present = new Set(["a", "b"]);
    const entering = new Set(["b"]);
    expect(rowMotionState("b", { present, entering })).toBe("enter");
    expect(rowMotionState("a", { present, entering })).toBe("idle");
    expect(rowMotionState("c", { present, entering })).toBe("leave");
  });

  it("fades an entering row in on the panel tier, token only", () => {
    const style = rowMotionStyle("enter");
    expect(style.animation).toContain("--dur-2");
    expect(style.animation).toContain("--ease-smooth");
    expect(style.animation).toContain("fade");
    // Never an ad-hoc duration or a literal easing keyword.
    expect(style.animation).not.toMatch(/\d+\s*m?s\b/);
    expect(style.animation).not.toMatch(/(^|[\s(])ease([\s)]|$)/);
  });

  it("fades a leaving row out in place and takes it out of the pointer flow", () => {
    const style = rowMotionStyle("leave");
    expect(style.opacity).toBe(0);
    expect(style.transition).toContain("opacity");
    expect(style.transition).toContain("--dur-2");
    expect(style.pointerEvents).toBe("none");
    expect(rowMotionClass("leave")).toContain("pointer-events-none");
  });

  it("leaves an idle row completely untouched", () => {
    expect(rowMotionStyle("idle")).toEqual({});
    expect(rowMotionClass("idle")).toBe("");
  });

  it("exposes the duration as the panel tier", () => {
    expect(ROW_MOTION_MS).toBe(DUR.base);
  });
});

describe("group chevron", () => {
  it("rotates on the shared transform token when expanded", () => {
    expect(groupChevronClass(true)).toContain("rotate-90");
    expect(groupChevronClass(true)).toContain("u-transform");
    expect(groupChevronClass(false)).not.toContain("rotate-90");
  });
});
