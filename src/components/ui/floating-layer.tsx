"use client";

import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * Renders children into `document.body` in the browser, inline during SSR.
 *
 * Why this exists: a floating panel positioned with `position: fixed` is only
 * viewport-relative when *no ancestor* creates a containing block. Several pages
 * here have one — the page header uses `backdrop-blur`, and the editor animates
 * blocks with `transform` — and a `backdrop-filter` or `transform` ancestor makes
 * `position: fixed` resolve against **that ancestor** instead of the viewport.
 * The symptom is a menu that appears in the corner of its container rather than
 * under its button (exactly what happened to the page's `⋯` actions menu).
 *
 * Portalling is the fix, and `select.tsx` already did it locally. This is that
 * behaviour, shared, so every floating surface behaves the same way.
 *
 * SSR: static renders must still produce markup, so the children render inline
 * when there is no DOM (and React moves them on hydration in the browser).
 */
export function FloatingLayer({ children }: { children: ReactNode }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted || typeof document === "undefined") return <>{children}</>;
  return createPortal(children, document.body);
}
