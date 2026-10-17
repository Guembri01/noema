"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import {
  afterGoingBack,
  afterGoingForward,
  afterNavigating,
  canGoBack,
  canGoForward,
  NAV_HISTORY_INITIAL,
  type NavHistory,
} from "@/lib/nav-history";

/**
 * Back / forward buttons for the page chrome.
 *
 * The installed desktop app has **no browser chrome**, so without these there is
 * no way to retrace your steps. They are also useful on the web version next to
 * the breadcrumb.
 *
 * Availability is tracked by `@/lib/nav-history` (the browser's own history is
 * opaque), and the shortcuts follow the platform conventions:
 * `Alt+←/→` on every platform, plus `Cmd+[` / `Cmd+]` on macOS.
 */
export function useNavHistory() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [state, setState] = useState<NavHistory>(NAV_HISTORY_INITIAL);
  /** What we did ourselves, so the next path change is not counted as a push. */
  const pending = useRef<"back" | "forward" | null>(null);
  const firstRender = useRef(true);

  // A path or query change is either our own back/forward or a new navigation.
  // `replace` is not observable from here, so a same-path query change is treated
  // as a navigation — which is what a user perceives when a filter changes.
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    if (pending.current === "back") {
      pending.current = null;
      setState((current) => afterGoingBack(current));
      return;
    }
    if (pending.current === "forward") {
      pending.current = null;
      setState((current) => afterGoingForward(current));
      return;
    }
    setState((current) => afterNavigating(current, { replace: false }));
  }, [pathname, searchParams]);

  const goBack = useCallback(() => {
    pending.current = "back";
    window.history.back();
  }, []);

  const goForward = useCallback(() => {
    pending.current = "forward";
    window.history.forward();
  }, []);

  // Browser-initiated back/forward (a mouse button, a keyboard gesture) must also
  // move our counter, otherwise the buttons drift out of sync with reality.
  useEffect(() => {
    const onPopState = () => {
      if (pending.current) return; // we already accounted for it
      setState((current) =>
        canGoForward(current) ? afterGoingBack(current) : afterNavigating(current, { replace: false }),
      );
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const back = canGoBack(state);
  const forward = canGoForward(state);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      // Never hijack keys while typing.
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      const alt = event.altKey && !event.ctrlKey && !event.metaKey;
      const bracket = (event.metaKey || event.ctrlKey) && (event.key === "[" || event.key === "]");
      if (alt && event.key === "ArrowLeft") {
        event.preventDefault();
        goBack();
      } else if (alt && event.key === "ArrowRight") {
        event.preventDefault();
        goForward();
      } else if (bracket && event.key === "[") {
        event.preventDefault();
        goBack();
      } else if (bracket && event.key === "]") {
        event.preventDefault();
        goForward();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [goBack, goForward]);

  return { canGoBack: back, canGoForward: forward, goBack, goForward };
}

export function NavHistory({ locale, className }: { locale: string; className?: string }) {
  const { canGoBack, canGoForward, goBack, goForward } = useNavHistory();
  const button = "focus-ring u-interactive u-colors flex h-7 w-7 items-center justify-center rounded-sm text-muted hover:bg-surface-2 hover:text-fg disabled:cursor-not-allowed disabled:opacity-40";
  return (
    <div className={cn("flex shrink-0 items-center gap-0.5", className)} data-testid="nav-history">
      <button
        type="button"
        onClick={goBack}
        disabled={!canGoBack}
        aria-label={t(locale, "goBack")}
        title={t(locale, "goBack")}
        className={button}
      >
        <ArrowLeft className="h-4 w-4" aria-hidden />
      </button>
      <button
        type="button"
        onClick={goForward}
        disabled={!canGoForward}
        aria-label={t(locale, "goForward")}
        title={t(locale, "goForward")}
        className={button}
      >
        <ArrowRight className="h-4 w-4" aria-hidden />
      </button>
    </div>
  );
}
