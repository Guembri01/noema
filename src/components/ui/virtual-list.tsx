"use client";

import type { CSSProperties, HTMLAttributes, Key, ReactNode, Ref } from "react";
import {
  offsetForIndex,
  totalHeight,
  visibleRange,
  type HeightOf,
} from "@/lib/virtual-list";
import { cn } from "@/lib/utils";

/**
 * VirtualList — the one windowed-render primitive.
 *
 * Long lists must mount only the slice in view. Before this primitive every
 * surface rolled its own scroll container + spacer + absolutely-positioned rows
 * (the windowed search results, the trash list, the sidebar tree, the select
 * popup). This is the shared implementation, extracted from the windowed
 * search-results list — the richest of them: variable row heights plus an
 * imperative `scrollToIndex` path — so the same markup now serves fixed-height
 * lists too.
 *
 * Geometry is owned by `@/lib/virtual-list` (`visibleRange` / `totalHeight` /
 * `offsetForIndex`); this component owns only the DOM shape:
 *
 *   <div ref className style={{ height: viewportHeight }} onScroll>   viewport
 *     <ul className style={{ height: totalHeight }}>                  spacer list
 *       <li className style={{ top, ...rowStyle }}>…</li>             rows at offset
 *     </ul>
 *   </div>
 *
 * It is **controlled**: the caller keeps `scrollTop` (it usually already does,
 * to feed the window maths) and receives every scroll through
 * `onScrollTopChange`. `scrollerRef` exposes the scroll node for imperative
 * scrolling (e.g. a keyboard `scrollToIndex`), and `scrollerProps` forwards the
 * accessibility attributes (`role`, `aria-label`, `tabIndex`, `onKeyDown`) so
 * the viewport keeps its real region semantics. Rows stay real `<li>` elements
 * at their true offset over a spacer carrying the full height, so the scrollbar
 * and the assistive-technology tree match a non-windowed list exactly.
 */
export type VirtualListProps<T> = {
  /** Every row, in render order. The window is computed over this array. */
  items: readonly T[];
  /** Current scroll offset of the viewport's top edge. */
  scrollTop: number;
  /** Height of the scroll viewport in px. */
  viewportHeight: number;
  /** Fixed row height, used when `heightOf` is absent. */
  itemHeight: number;
  /** Optional per-row height lookup for variable-height rows. */
  heightOf?: HeightOf;
  /** Extra rows rendered above and below the visible slice (default 0). */
  overscan?: number;
  /** Stable key per row. */
  getKey: (item: T, index: number) => Key;
  /** Render one row's content inside its positioned wrapper. */
  renderItem: (item: T, index: number) => ReactNode;
  /** Fired with the scroller's `scrollTop` on every scroll. */
  onScrollTopChange?: (scrollTop: number) => void;
  /** Ref to the scroll container, for imperative scrolling. */
  scrollerRef?: Ref<HTMLDivElement>;
  /**
   * Props for the scroll container — `role`, `aria-label`, `tabIndex`,
   * `onKeyDown`, `aria-busy`. `className`, `style` and `onScroll` stay owned by
   * this component so they cannot drift from the window maths.
   */
  scrollerProps?: Omit<
    HTMLAttributes<HTMLDivElement>,
    "className" | "style" | "onScroll"
  >;
  /** Classes for the scroll container. */
  className?: string;
  /** Classes for the inner spacer list. */
  listClassName?: string;
  /** Classes for every row wrapper, or a per-row class producer. */
  rowClassName?: string | ((item: T, index: number) => string);
  /** Inline style merged onto every row wrapper (e.g. a fixed row height). */
  rowStyle?: CSSProperties;
  /**
   * Extra `data-*` attributes for every row wrapper (or a per-row producer),
   * so a surface can keep its own row markers (e.g. `data-trash-row`).
   */
  rowAttributes?: (item: T, index: number) => Record<string, string>;
};

export function VirtualList<T>({
  items,
  scrollTop,
  viewportHeight,
  itemHeight,
  heightOf,
  overscan,
  getKey,
  renderItem,
  onScrollTopChange,
  scrollerRef,
  scrollerProps,
  className,
  listClassName,
  rowClassName,
  rowStyle,
  rowAttributes,
}: VirtualListProps<T>) {
  const range = visibleRange({
    scrollTop,
    viewportSize: viewportHeight,
    itemHeight,
    itemCount: items.length,
    overscan,
    heightOf,
  });
  const visible = items.slice(range.start, range.end);

  return (
    <div
      ref={scrollerRef}
      {...scrollerProps}
      onScroll={(event) => onScrollTopChange?.(event.currentTarget.scrollTop)}
      className={className}
      style={{ height: viewportHeight }}
    >
      <ul
        className={cn("relative", listClassName)}
        style={{ height: totalHeight(items.length, itemHeight, heightOf) }}
      >
        {visible.map((item, offsetInWindow) => {
          const index = range.start + offsetInWindow;
          const row = typeof rowClassName === "function" ? rowClassName(item, index) : rowClassName;
          return (
            <li
              key={getKey(item, index)}
              {...(rowAttributes?.(item, index) as HTMLAttributes<HTMLLIElement>)}
              className={row}
              style={{ top: offsetForIndex(index, itemHeight, heightOf), ...rowStyle }}
            >
              {renderItem(item, index)}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
