"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { DUR, Z } from "@/lib/design-tokens";

/**
 * A 2 px accent bar pinned to the very top of the viewport, driven by
 * `usePathname`/`useSearchParams`. It starts on the first navigation, trickles
 * to {@link PROGRESS_TRICKLE_CAP} then completes and fades — it deliberately
 * never blocks input (the whole bar is `pointer-events-none`) and is never a
 * full-page spinner.
 *
 * Reduced motion swaps the trickle for an instant show/hide (see
 * `RouteProgressBar`), matching the global `prefers-reduced-motion` contract.
 */

/** Fraction (%) the bar creeps to before the route is considered loaded. */
export const PROGRESS_TRICKLE_CAP = 80;

/** Value the bar snaps to the moment a navigation is observed. */
export const PROGRESS_START = 8;

export type ProgressPhase = "idle" | "loading" | "completing";

export interface ProgressState {
  phase: ProgressPhase;
  /** Bar width, 0–100. */
  value: number;
}

export const IDLE_PROGRESS: ProgressState = { phase: "idle", value: 0 };

/** Begin tracking a navigation: a small head appears, then {@link trickleProgress}. */
export function startProgress(): ProgressState {
  return { phase: "loading", value: PROGRESS_START };
}

/**
 * Ease the bar toward {@link PROGRESS_TRICKLE_CAP} without ever overshooting it.
 * Idempotent once completing, and a no-op from idle: a trickle only advances a
 * bar that is already showing. *Starting* one is the navigation effect's job
 * (`startProgress`), which is what keeps a late tick from resurrecting a bar
 * that has already settled back to idle.
 */
export function trickleProgress(
  state: ProgressState,
  cap: number = PROGRESS_TRICKLE_CAP,
): ProgressState {
  if (state.phase === "idle") return state;
  if (state.phase === "completing") return state;
  const ceiling = Math.min(PROGRESS_TRICKLE_CAP, Math.max(PROGRESS_START, cap));
  const next = state.value + (ceiling - state.value) * 0.4;
  const value = Math.round(Math.min(ceiling, next) * 10) / 10;
  return { phase: "loading", value };
}

/** Navigation finished: snap to full width and hold while the bar fades out. */
export function completeProgress(state: ProgressState): ProgressState {
  if (state.phase === "idle") return state;
  return { phase: "completing", value: 100 };
}

/** The fade finished: back to invisible. */
export function settleProgress(): ProgressState {
  return IDLE_PROGRESS;
}

/**
 * The bar itself. Presentational (no hooks), so it renders in a node test and
 * SSR unchanged; `reducedMotion` removes the width transition entirely.
 */
export function RouteProgressBar({
  state,
  reducedMotion = false,
}: {
  state: ProgressState;
  reducedMotion?: boolean;
}) {
  const visible = state.phase !== "idle";
  return (
    <div
      data-testid="route-progress"
      data-phase={state.phase}
      aria-hidden="true"
      className="pointer-events-none fixed inset-x-0 top-0 h-0.5 overflow-hidden"
      style={{
        zIndex: Z.sticky,
        opacity: visible ? 1 : 0,
        transition: reducedMotion
          ? "none"
          : "opacity var(--dur-2) var(--ease-smooth)",
      }}
    >
      <div
        data-testid="route-progress-bar"
        data-value={state.value}
        className="h-full w-full origin-left bg-accent"
        style={{
          // Composited (transform) rather than layout (width): the bar advances
          // on every navigation tick, and `width` forced a reflow each time.
          transform: `scaleX(${state.value / 100})`,
          transition: reducedMotion
            ? "none"
            : "transform var(--dur-3) var(--ease-smooth)",
        }}
      />
    </div>
  );
}

/** Tracks the current route and renders {@link RouteProgressBar}. */
export function RouteProgress() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const routeKey = `${pathname}?${searchParams.toString()}`;
  const [state, setState] = useState<ProgressState>(IDLE_PROGRESS);
  const [reducedMotion, setReducedMotion] = useState(false);
  // Read inside the navigation effect without making it a dependency: resolving
  // the media query right after mount must not look like a navigation.
  const reducedRef = useRef(false);
  // The route we last animated for. A ref (not state) so StrictMode's double
  // mount can't trigger a phantom bar.
  const lastRouteKey = useRef(routeKey);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => {
      reducedRef.current = query.matches;
      setReducedMotion(query.matches);
    };
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    if (lastRouteKey.current === routeKey) return;
    lastRouteKey.current = routeKey;

    if (reducedRef.current) {
      setState(completeProgress(startProgress()));
      const hide = window.setTimeout(() => setState(settleProgress()), DUR.fast);
      return () => window.clearTimeout(hide);
    }

    setState(startProgress());
    const tick = window.setInterval(
      () => setState((prev) => trickleProgress(prev)),
      DUR.fast,
    );
    // Stop trickling the moment the bar completes: there is nothing left to
    // ease, and an interval that outlived the bar would keep waking the
    // component for the whole life of the route.
    const finish = window.setTimeout(() => {
      window.clearInterval(tick);
      setState((prev) => completeProgress(prev));
    }, DUR.slow + DUR.base);
    const hide = window.setTimeout(
      () => setState(settleProgress()),
      DUR.slow + DUR.base + DUR.slow,
    );
    return () => {
      window.clearInterval(tick);
      window.clearTimeout(finish);
      window.clearTimeout(hide);
    };
  }, [routeKey]);

  return <RouteProgressBar state={state} reducedMotion={reducedMotion} />;
}
