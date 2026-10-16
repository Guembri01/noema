"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties, HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

/**
 * ScrollArea — a styled scroll container.
 *
 * - `.scrollbar-thin` from the token layer (never a bespoke scrollbar).
 * - `overflow` stays `auto` so native/touch scrolling keeps working on mobile;
 *   the container is never `overflow: hidden`.
 * - `fade` masks the edge(s) that actually overflow. The bottom edge uses the
 *   shared `.edge-fade-b` utility; top/both build an equivalent mask from the
 *   `--space-6` / `--bg` tokens so the two agree.
 *
 * Scroll/resize detection runs in an effect only, so the server renders the
 * un-faded state and hydration never shifts layout.
 */

export type ScrollFade = "none" | "top" | "bottom" | "both";
export type ScrollOrientation = "vertical" | "horizontal" | "both";

export type ScrollEdges = {
  top: boolean;
  bottom: boolean;
};

/** The shared thin-scrollbar utility (defined in `tokens.css`). */
export const SCROLLBAR_CLASS = "scrollbar-thin";

export const SCROLL_ORIENTATION: Record<ScrollOrientation, string> = {
  vertical: "overflow-y-auto overflow-x-hidden",
  horizontal: "overflow-x-auto overflow-y-hidden",
  both: "overflow-auto",
};

const EDGE_SIZE = "var(--space-6)";
const MASK_TOP = `linear-gradient(to bottom, transparent 0, var(--bg) ${EDGE_SIZE})`;
const MASK_BOTTOM = `linear-gradient(to bottom, var(--bg) calc(100% - ${EDGE_SIZE}), transparent 100%)`;
const MASK_BOTH = `linear-gradient(to bottom, transparent 0, var(--bg) ${EDGE_SIZE}, var(--bg) calc(100% - ${EDGE_SIZE}), transparent 100%)`;

const mask = (image: string): { style: CSSProperties } => ({
  style: { maskImage: image, WebkitMaskImage: image },
});

/**
 * Pure resolver: given the requested `fade` and which edges actually overflow,
 * return the class/style pair to apply. Tested exhaustively in
 * `scroll-area.test.ts`.
 */
export function edgeFade(
  fade: ScrollFade,
  edges: ScrollEdges,
): { className?: string; style?: CSSProperties } {
  if (fade === "none") return {};
  if (fade === "bottom") return edges.bottom ? { className: "edge-fade-b" } : {};
  if (fade === "top") return edges.top ? mask(MASK_TOP) : {};
  // both
  if (edges.top && edges.bottom) return mask(MASK_BOTH);
  if (edges.top) return mask(MASK_TOP);
  if (edges.bottom) return { className: "edge-fade-b" };
  return {};
}

export type ScrollAreaProps = {
  fade?: ScrollFade;
  orientation?: ScrollOrientation;
  /** e.g. `280` (px) or `"40vh"`. */
  maxHeight?: number | string;
} & HTMLAttributes<HTMLDivElement>;

export function ScrollArea({
  fade = "bottom",
  orientation = "vertical",
  maxHeight,
  className,
  style,
  children,
  ...props
}: ScrollAreaProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [edges, setEdges] = useState<ScrollEdges>({ top: false, bottom: false });

  const sync = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const top = el.scrollTop > 1;
    const bottom = el.scrollTop + el.clientHeight < el.scrollHeight - 1;
    setEdges((prev) =>
      prev.top === top && prev.bottom === bottom ? prev : { top, bottom },
    );
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    sync();
    el.addEventListener("scroll", sync, { passive: true });
    let observer: ResizeObserver | undefined;
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(sync);
      observer.observe(el);
    }
    return () => {
      el.removeEventListener("scroll", sync);
      observer?.disconnect();
    };
  }, [sync]);

  const faded = edgeFade(fade, edges);

  return (
    <div
      ref={ref}
      className={cn(
        "relative",
        SCROLL_ORIENTATION[orientation],
        SCROLLBAR_CLASS,
        faded.className,
        className,
      )}
      style={{
        ...(maxHeight !== undefined
          ? { maxHeight: typeof maxHeight === "number" ? `${maxHeight}px` : maxHeight }
          : null),
        ...faded.style,
        ...style,
      }}
      {...props}
    >
      {children}
    </div>
  );
}
