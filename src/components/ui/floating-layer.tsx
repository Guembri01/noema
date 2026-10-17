"use client";

import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { Z } from "@/lib/design-tokens";

/**
 * Renders children into the surface that owns them, in the browser, inline
 * during SSR.
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

/**
 * Where the popups opened inside a surface should render.
 *
 * The tier ladder is *flat* (`Z.popover 50` < `Z.modal 60`), which is right for
 * a popup opened from the page — a modal opened afterwards must cover it — and
 * wrong for a popup opened from **inside** a modal surface: the tier alone would
 * paint a dialog's own dropdown *behind* the dialog it belongs to. The ladder
 * cannot express "above its owner, below a newer owner" without trailing DOM
 * order anyway, so the owner is expressed structurally instead:
 *
 *  - a modal surface renders a {@link FloatingHostProvider}, which publishes a
 *    zero-size stacking context at `Z.modal` placed **after** its content;
 *  - every popup opened inside that subtree portals there instead of to
 *    `<body>`, so it inherits the surface's own level (60, tie) and wins by
 *    document order — the same way Radix and Notion layer their menus;
 *  - a popup opened from the page has no host and still portals to `<body>` at
 *    `Z.popover`, so a later modal covers it as before.
 *
 * The host is zero-sized on purpose: it must create a stacking context without
 * covering anything, so it needs no `pointer-events` opt-out and cannot clip
 * (fixed children of an `overflow: visible` box are not clipped).
 */
const FloatingHostContext = createContext<HTMLElement | null>(null);

/** The host offered by the nearest enclosing modal surface, if any. */
export function useFloatingHost(): HTMLElement | null {
  return useContext(FloatingHostContext);
}

/**
 * Publishes a floating host for the subtree, and renders it after `children`.
 *
 * Mount order matters only in that the host element must come after the surface
 * content it must beat; React renders `children` first, so that holds. The host
 * itself is client-only: it exists to receive portals (which need a document),
 * so rendering it on the server would only add an empty node to the markup a
 * closed surface is supposed to leave clean - `confirm-dialog.test.ts` pins
 * "closed renders nothing".
 */
export function FloatingHostProvider({
  children,
  zIndex = Z.modal,
}: {
  children: ReactNode;
  zIndex?: number;
}) {
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return (
    <FloatingHostContext.Provider value={host}>
      {children}
      {mounted ? (
        <div
          ref={setHost}
          data-floating-host=""
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            width: 0,
            height: 0,
            zIndex,
          }}
        />
      ) : null}
    </FloatingHostContext.Provider>
  );
}

export function FloatingLayer({ children }: { children: ReactNode }) {
  const host = useFloatingHost();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted || typeof document === "undefined") return <>{children}</>;
  return createPortal(children, host ?? document.body);
}
