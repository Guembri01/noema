import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// The bar itself takes no hooks, but the module imports Next's navigation —
// stub it so the pure state machine and static markup can run under node.
vi.mock("next/navigation", () => ({
  usePathname: () => "/w/demo",
  useSearchParams: () => new URLSearchParams(),
}));

import {
  IDLE_PROGRESS,
  PROGRESS_START,
  PROGRESS_TRICKLE_CAP,
  RouteProgressBar,
  completeProgress,
  settleProgress,
  startProgress,
  trickleProgress,
  type ProgressState,
} from "./route-progress";

function render(state: ProgressState, reducedMotion = false): string {
  return renderToStaticMarkup(
    createElement(RouteProgressBar, { state, reducedMotion }),
  );
}

describe("route progress state machine", () => {
  it("starts visible with a small head below the trickle cap", () => {
    const state = startProgress();
    expect(state.phase).toBe("loading");
    expect(state.value).toBe(PROGRESS_START);
    expect(state.value).toBeGreaterThan(0);
    expect(state.value).toBeLessThan(PROGRESS_TRICKLE_CAP);
  });

  it("trickles monotonically and never overshoots the cap", () => {
    let state = startProgress();
    let last = state.value;
    for (let i = 0; i < 50; i += 1) {
      state = trickleProgress(state);
      expect(state.value).toBeGreaterThanOrEqual(last);
      expect(state.value).toBeLessThanOrEqual(PROGRESS_TRICKLE_CAP);
      last = state.value;
    }
    // It converges on the cap instead of sitting still well below it.
    expect(last).toBeGreaterThan(PROGRESS_TRICKLE_CAP - 1);
  });

  it("starts a trickle from idle and freezes while completing", () => {
    expect(trickleProgress(IDLE_PROGRESS).phase).toBe("loading");
    const completing: ProgressState = { phase: "completing", value: 100 };
    expect(trickleProgress(completing)).toEqual(completing);
  });

  it("snaps to full width when completing, and only from an active bar", () => {
    expect(completeProgress(startProgress())).toEqual({
      phase: "completing",
      value: 100,
    });
    expect(completeProgress(IDLE_PROGRESS)).toEqual(IDLE_PROGRESS);
  });

  it("settles back to idle", () => {
    expect(settleProgress()).toEqual(IDLE_PROGRESS);
    expect(IDLE_PROGRESS).toEqual({ phase: "idle", value: 0 });
  });
});

describe("RouteProgressBar", () => {
  it("renders a 2px accent bar at Z.sticky with the current width", () => {
    const html = render({ phase: "loading", value: 45 });
    expect(html).toContain('data-testid="route-progress"');
    expect(html).toContain('data-phase="loading"');
    expect(html).toContain('data-testid="route-progress-bar"');
    expect(html).toContain("transform:scaleX(0.45)");
    expect(html).toContain("bg-accent");
    expect(html).toContain("h-0.5");
    expect(html).toContain("pointer-events-none");
    expect(html).toContain("z-index:10");
  });

  it("hides when idle", () => {
    const html = render(IDLE_PROGRESS);
    expect(html).toContain('data-phase="idle"');
    expect(html).toContain("opacity:0");
  });

  it("is instant (no transition) under reduced motion", () => {
    const html = render({ phase: "loading", value: 20 }, true);
    expect(html).toContain("transition:none");
    expect(html).not.toContain("var(--dur-3)");
  });
});
