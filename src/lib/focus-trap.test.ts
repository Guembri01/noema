import { describe, expect, it } from "vitest";
import {
  describeFocusPlan,
  firstStop,
  focusableSelector,
  isFocusable,
  lastStop,
  nextStop,
  resolveReturnTarget,
  trapPlan,
  visibleFocusables,
  type Focusable,
} from "./focus-trap";

/**
 * Pure focus-management engine (red-first) for the FEATURE_MATRIX row
 * "Focus management".
 *
 * B45 hardened the `ui/dialog` / `ui/dropdown-menu` primitives, but the
 * hand-rolled feature overlays (`topbar/actions-menu`, `who-has-access`,
 * `version-history`, `tickets/ticket-drawer`, `editor/equation-editor`) bypass
 * the primitive and have no Tab trap of their own. This module is the small,
 * DOM-free kernel those overlays can share: given a plain list of `Focusable`
 * descriptors, decide which element a Tab / Shift+Tab keydown should move to
 * (with wrap-around), which element an overlay should focus on open, whether
 * the invoker still exists to restore focus to, and what a resulting plan
 * means. No DOM, no React, inputs never mutated.
 */

const stop = (id: string, over: Partial<Focusable> = {}): Focusable => ({
  id,
  ...over,
});

/** Three ordinary, all-focusable stops - the common overlay case. */
const ring: Focusable[] = [stop("close"), stop("title"), stop("save")];

describe("focusableSelector", () => {
  it("names the standard focusable element kinds", () => {
    for (const part of [
      "a[href]",
      "button",
      "input",
      "select",
      "textarea",
      "[contenteditable]",
    ]) {
      expect(focusableSelector).toContain(part);
    }
  });

  it("excludes disabled controls and tabindex=-1 from the tab order", () => {
    expect(focusableSelector).toContain(":not([disabled])");
    expect(focusableSelector).toContain('[tabindex]:not([tabindex="-1"])');
  });
});

describe("isFocusable", () => {
  it("accepts a plain enabled, visible stop", () => {
    expect(isFocusable(stop("a"))).toBe(true);
  });

  it("rejects a disabled stop", () => {
    expect(isFocusable(stop("a", { disabled: true }))).toBe(false);
  });

  it("rejects a hidden stop", () => {
    expect(isFocusable(stop("a", { hidden: true }))).toBe(false);
  });

  it("rejects an explicit tabindex=-1 (programmatic focus only)", () => {
    expect(isFocusable(stop("a", { tabIndex: -1 }))).toBe(false);
  });

  it("accepts tabindex 0, positive values and an absent tabindex", () => {
    expect(isFocusable(stop("a", { tabIndex: 0 }))).toBe(true);
    expect(isFocusable(stop("a", { tabIndex: 3 }))).toBe(true);
    expect(isFocusable(stop("a", { tabIndex: undefined }))).toBe(true);
  });
});

describe("visibleFocusables", () => {
  it("keeps ordinary stops in order", () => {
    expect(visibleFocusables(ring)).toEqual(ring);
  });

  it("drops hidden stops", () => {
    const list = [stop("a"), stop("b", { hidden: true }), stop("c")];
    expect(visibleFocusables(list).map((el) => el.id)).toEqual(["a", "c"]);
  });

  it("also drops disabled and tabindex=-1 stops", () => {
    const list = [
      stop("a"),
      stop("b", { disabled: true }),
      stop("c", { tabIndex: -1 }),
      stop("d"),
    ];
    expect(visibleFocusables(list).map((el) => el.id)).toEqual(["a", "d"]);
  });

  it("returns [] for an empty list and a fresh array otherwise", () => {
    expect(visibleFocusables([])).toEqual([]);
    const out = visibleFocusables(ring);
    expect(out).not.toBe(ring);
  });

  it("does not mutate the input list", () => {
    const input = ring.map((el) => ({ ...el }));
    visibleFocusables(input);
    expect(input).toEqual(ring);
  });
});

describe("firstStop / lastStop", () => {
  it("returns the first and last stop", () => {
    expect(firstStop(ring)).toBe(ring[0]);
    expect(lastStop(ring)).toBe(ring[2]);
  });

  it("returns null on an empty list", () => {
    expect(firstStop([])).toBeNull();
    expect(lastStop([])).toBeNull();
  });

  it("returns the same element for a single-stop list", () => {
    const only = [stop("solo")];
    expect(firstStop(only)).toBe(only[0]);
    expect(lastStop(only)).toBe(only[0]);
  });
});

describe("nextStop", () => {
  it("moves forward with Tab", () => {
    expect(nextStop(ring, ring[0], {})).toBe(ring[1]);
    expect(nextStop(ring, ring[1], { shift: false })).toBe(ring[2]);
  });

  it("wraps Tab from the last stop back to the first", () => {
    expect(nextStop(ring, ring[2], {})).toBe(ring[0]);
  });

  it("moves backward with Shift+Tab", () => {
    expect(nextStop(ring, ring[2], { shift: true })).toBe(ring[1]);
    expect(nextStop(ring, ring[1], { shift: true })).toBe(ring[0]);
  });

  it("wraps Shift+Tab from the first stop back to the last", () => {
    expect(nextStop(ring, ring[0], { shift: true })).toBe(ring[2]);
  });

  it("enters the ring when there is no current stop", () => {
    expect(nextStop(ring, null, {})).toBe(ring[0]);
    expect(nextStop(ring, null, { shift: true })).toBe(ring[2]);
  });

  it("treats an unknown current stop like no current stop", () => {
    const ghost = stop("ghost");
    expect(nextStop(ring, ghost, {})).toBe(ring[0]);
    expect(nextStop(ring, ghost, { shift: true })).toBe(ring[2]);
  });

  it("matches the current stop by id across instances (re-render case)", () => {
    const current = stop("title"); // same id, different object than ring[1]
    expect(nextStop(ring, current, {})).toBe(ring[2]);
    expect(nextStop(ring, current, { shift: true })).toBe(ring[0]);
  });

  it("returns null on an empty list", () => {
    expect(nextStop([], stop("a"), {})).toBeNull();
    expect(nextStop([], null, { shift: true })).toBeNull();
  });

  it("stays on the only stop in both directions", () => {
    const only = [stop("solo")];
    expect(nextStop(only, only[0], {})).toBe(only[0]);
    expect(nextStop(only, only[0], { shift: true })).toBe(only[0]);
  });
});

describe("resolveReturnTarget", () => {
  it("returns the invoker when it is still connected", () => {
    const invoker = stop("invoke");
    expect(resolveReturnTarget({ invoker })).toBe(invoker);
  });

  it("falls back when the invoker was disconnected", () => {
    const invoker = stop("invoke", { connected: false });
    const fallback = stop("fallback");
    expect(resolveReturnTarget({ invoker, fallback })).toBe(fallback);
  });

  it("falls back when there is no invoker", () => {
    const fallback = stop("fallback");
    expect(resolveReturnTarget({ invoker: null, fallback })).toBe(fallback);
  });

  it("returns null when neither side is usable", () => {
    expect(resolveReturnTarget({ invoker: null, fallback: null })).toBeNull();
    expect(resolveReturnTarget({})).toBeNull();
  });

  it("ignores a disconnected fallback", () => {
    const invoker = stop("invoke", { connected: false });
    const fallback = stop("fallback", { connected: false });
    expect(resolveReturnTarget({ invoker, fallback })).toBeNull();
  });
});

describe("trapPlan", () => {
  it("returns null so the key passes through when nothing can take focus", () => {
    expect(trapPlan([], {})).toBeNull();
    expect(trapPlan(ring, { initial: ring[0] })).not.toBeNull();
  });

  it("returns null when every element is filtered out", () => {
    const list = [stop("a", { hidden: true }), stop("b", { disabled: true })];
    expect(trapPlan(list, {})).toBeNull();
  });

  it("enters at the first stop on Tab when focus is still outside", () => {
    const plan = trapPlan(ring, { initial: null });
    expect(plan).toEqual({ target: ring[0], reason: "enter", wrapped: false });
  });

  it("enters at the last stop on Shift+Tab when focus is outside", () => {
    const plan = trapPlan(ring, { initial: null, shift: true });
    expect(plan).toEqual({ target: ring[2], reason: "enter", wrapped: false });
  });

  it("advances to the next stop in the middle of the ring", () => {
    const plan = trapPlan(ring, { initial: ring[0] });
    expect(plan).toEqual({ target: ring[1], reason: "next", wrapped: false });
  });

  it("steps back to the previous stop with Shift", () => {
    const plan = trapPlan(ring, { initial: ring[2], shift: true });
    expect(plan).toEqual({ target: ring[1], reason: "prev", wrapped: false });
  });

  it("wraps Tab from the last stop to the first and flags it", () => {
    const plan = trapPlan(ring, { initial: ring[2] });
    expect(plan).toEqual({ target: ring[0], reason: "next", wrapped: true });
  });

  it("wraps Shift+Tab from the first stop to the last and flags it", () => {
    const plan = trapPlan(ring, { initial: ring[0], shift: true });
    expect(plan).toEqual({ target: ring[2], reason: "prev", wrapped: true });
  });

  it("marks a single-stop ring as 'only' in both directions", () => {
    const only = [stop("solo")];
    expect(trapPlan(only, { initial: only[0] })).toEqual({
      target: only[0],
      reason: "only",
      wrapped: false,
    });
    expect(trapPlan(only, { initial: only[0], shift: true })).toEqual({
      target: only[0],
      reason: "only",
      wrapped: false,
    });
  });

  it("treats a hidden/disabled initial stop as an entry, skipping it in the ring", () => {
    const list = [stop("a"), stop("b", { hidden: true }), stop("c")];
    expect(trapPlan(list, { initial: list[1] })).toEqual({
      target: list[0],
      reason: "enter",
      wrapped: false,
    });
    expect(trapPlan(list, { initial: list[1], shift: true })).toEqual({
      target: list[2],
      reason: "enter",
      wrapped: false,
    });
  });
});

describe("describeFocusPlan", () => {
  it("describes a release plan when there is nothing to focus", () => {
    expect(describeFocusPlan(null)).toBe("release: nothing to focus");
  });

  it("names the target id and the reason", () => {
    expect(describeFocusPlan(trapPlan(ring, { initial: ring[0] }))).toBe(
      "focus #title (next)",
    );
  });

  it("flags a wrap in the description", () => {
    expect(describeFocusPlan(trapPlan(ring, { initial: ring[2] }))).toBe(
      "focus #close (next, wrap)",
    );
  });
});
