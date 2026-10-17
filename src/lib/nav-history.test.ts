import { describe, expect, it } from "vitest";
import {
  afterGoingBack,
  afterGoingForward,
  afterNavigating,
  canGoBack,
  canGoForward,
  NAV_HISTORY_INITIAL,
  type NavHistory,
} from "./nav-history";

/**
 * The back/forward availability model.
 *
 * It exists because the browser's history is opaque — `history.length` cannot
 * answer "is there anything ahead?" — and because the installed desktop app has
 * no browser chrome, so these buttons are the only way back. Pure, so the rules
 * are pinned without a DOM, a router or a browser.
 */
const walk = (steps: string[]): NavHistory =>
  steps.reduce<NavHistory>((state, step) => {
    if (step === "push") return afterNavigating(state, { replace: false });
    if (step === "replace") return afterNavigating(state, { replace: true });
    if (step === "back") return afterGoingBack(state);
    if (step === "forward") return afterGoingForward(state);
    return state;
  }, NAV_HISTORY_INITIAL);

describe("nav history", () => {
  it("starts with neither direction available", () => {
    expect(canGoBack(NAV_HISTORY_INITIAL)).toBe(false);
    expect(canGoForward(NAV_HISTORY_INITIAL)).toBe(false);
  });

  it("enables back after a navigation and clears the forward stack", () => {
    const after = walk(["push", "back", "push"]);
    expect(canGoBack(after)).toBe(true);
    expect(canGoForward(after)).toBe(false);
  });

  it("a replace does not deepen the stack", () => {
    expect(walk(["replace"])).toEqual(NAV_HISTORY_INITIAL);
    expect(walk(["push", "replace"])).toEqual(walk(["push"]));
  });

  it("going back reveals a forward entry, going forward consumes it", () => {
    const back = walk(["push", "push", "back"]);
    expect(canGoForward(back)).toBe(true);
    expect(back.depth).toBe(1);
    const forward = afterGoingForward(back);
    expect(forward.depth).toBe(2);
    expect(canGoForward(forward)).toBe(false);
  });

  it("never goes below zero in either direction", () => {
    expect(walk(["back", "back"])).toEqual(NAV_HISTORY_INITIAL);
    expect(walk(["forward", "forward"])).toEqual(NAV_HISTORY_INITIAL);
    expect(walk(["push", "back", "back"]).depth).toBe(0);
    expect(walk(["push", "back", "back"]).forward).toBe(1);
  });

  it("a round trip returns to the starting point", () => {
    expect(walk(["push", "push", "back", "forward"])).toEqual(walk(["push", "push"]));
  });

  it("is immutable: the input state is never mutated", () => {
    const state: NavHistory = { depth: 2, forward: 1 };
    const snapshot = { ...state };
    afterGoingBack(state);
    afterGoingForward(state);
    afterNavigating(state, { replace: false });
    expect(state).toEqual(snapshot);
  });
});
