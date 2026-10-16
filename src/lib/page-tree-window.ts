import type { PageTreeNode } from "@/server/queries";
import { flattenTree } from "@/lib/page-tree";

/**
 * W09 — Page-tree virtualization + perf model (MISSING_FEATURES §9:
 * "React DOM render at 1000 nodes still unmeasured").
 *
 * The sidebar's render plan is `flattenTree`'s visible pre-order rows
 * (`src/lib/page-tree.ts`, imported here — never modified) turned into a fixed
 * row-height window: only the rows crossing the viewport, plus `overscan`, are
 * materialised. Everything is pure and deterministic — no DOM, no React, no
 * prisma, no ambient clock (the perf clock is injected) — so the sidebar's
 * large-tree behaviour is provable without rendering 1000 nodes.
 *
 * Geometry mirrors `src/lib/virtual-list.ts` for the fixed-height case:
 * bounds degrade to an empty window rather than throwing, indices are floored,
 * and `endIndex` is exclusive so `endIndex - startIndex` is the render count.
 *
 * Consistency contracts:
 *  - `rows` only ever contains rows that are visible for `expandedIds`
 *    (`visibleIds` is the full visible order, `rows` the windowed slice).
 *  - `totalHeight === visibleIds.length * rowHeight` (clamped row height).
 *  - `visibleRange(plan)` equals `{ start: plan.startIndex, end: plan.endIndex }`.
 */

const NO_EXPANDED: ReadonlySet<string> = new Set();

/** `value` if finite, otherwise `fallback`. */
function finite(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

/** `value` when finite and positive, otherwise `0`. */
function positive(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/** Geometry + expand state for {@link buildRenderPlan}. */
export type PageTreeWindowOptions = {
  /** Ids of open nodes (default: none). Stale ids under a collapsed ancestor are inert. */
  expandedIds?: ReadonlySet<string>;
  /** Uniform row height in pixels; non-positive/-finite collapses the window. */
  rowHeight: number;
  /** Viewport height in pixels; non-positive/-finite yields an empty window. */
  viewportHeight: number;
  /** Current scroll offset; negative clamps to `0` (default `0`). */
  scrollTop?: number;
  /** Extra rows rendered above and below the visible slice (default `0`). */
  overscan?: number;
};

/** One row in the render window, positioned absolutely in the full list. */
export type PageTreeRenderRow = {
  id: string;
  depth: number;
  /** Absolute top offset in pixels (`index * rowHeight`). */
  top: number;
  /** Row height in pixels (uniform). */
  height: number;
  /** The node's own open state. */
  expanded: boolean;
  /** Whether the node has children in the raw tree (regardless of expand state). */
  hasChildren: boolean;
};

/** The windowed render plan the sidebar virtualizer draws from. */
export type PageTreeRenderPlan = {
  /** The rows inside `[startIndex, endIndex)` — the only rows to render. */
  rows: PageTreeRenderRow[];
  /** Height of every visible row, not just the window. */
  totalHeight: number;
  /** First rendered index (inclusive). */
  startIndex: number;
  /** One past the last rendered index (exclusive). */
  endIndex: number;
  /** The uniform row height used for this plan. */
  rowHeight: number;
  /** The viewport height the window was cut for. */
  viewportHeight: number;
  /**
   * Ordered ids of every visible row — the stable index used to re-pin a row
   * across expand/collapse ({@link anchorForScroll}). Ids only, so the window
   * stays the memory-bounded part of the plan.
   */
  visibleIds: readonly string[];
};

/** Half-open window over row indices. */
export type PageTreeWindowRange = { start: number; end: number };

/** Options for {@link measurePerf}. */
export type MeasurePerfOptions = {
  /** Passes over the rendered window (default `1`). */
  samples?: number;
  /** Injected clock; called once before and once after the work (default `Date.now`). */
  now?: () => number;
};

/** Result of {@link measurePerf}. */
export type PageTreePerfSample = {
  /** Rendered rows touched, `rows.length * samples`. */
  nodesVisited: number;
  /** Elapsed clock delta, never negative. */
  durationMs: number;
};

/** Options for {@link shouldVirtualize}. */
export type VirtualizeOptions = { threshold?: number };

/** Lists strictly longer than this default length should be virtualized. */
export const VIRTUALIZE_ROW_THRESHOLD = 50;

/** Ids that appear as a `parentId` anywhere in the tree. */
function collectParentIds(tree: readonly PageTreeNode[]): Set<string> {
  const parents = new Set<string>();
  for (const node of tree) {
    if (node.parentId !== null) parents.add(node.parentId);
  }
  return parents;
}

/**
 * The half-open index window intersecting `[scrollTop, scrollTop + viewportHeight)`,
 * widened by `overscan` and clamped to `[0, count]`. Mirrors the fixed-height
 * branch of `virtual-list.visibleRange`: an unusable height/viewport is empty.
 */
function fixedWindow(
  count: number,
  rowHeight: number,
  viewportHeight: number,
  scrollTop: number,
  overscan: number,
): PageTreeWindowRange {
  if (count === 0 || rowHeight === 0 || viewportHeight === 0) return { start: 0, end: 0 };
  const first = Math.min(count, Math.floor(scrollTop / rowHeight));
  const lastVisibleEnd = Math.ceil((scrollTop + viewportHeight) / rowHeight);
  const start = Math.max(0, first - overscan);
  const end = Math.max(start, Math.min(count, lastVisibleEnd + overscan));
  return { start, end };
}

/** Clamp a scroll offset into `[0, totalHeight - viewportHeight]` for a plan. */
function clampScrollTop(value: number, plan: PageTreeRenderPlan): number {
  const max = Math.max(0, plan.totalHeight - positive(plan.viewportHeight));
  return Math.min(max, Math.max(0, finite(value, 0)));
}

/**
 * Flatten the *visible* rows for `expandedIds` (via `flattenTree`) into a
 * fixed-height render plan windowed to the viewport. Only rows inside the
 * window are materialised in `rows`; `visibleIds` and `totalHeight` describe the
 * whole visible list.
 */
export function buildRenderPlan(
  tree: readonly PageTreeNode[],
  options: PageTreeWindowOptions,
): PageTreeRenderPlan {
  const rowHeight = positive(options.rowHeight);
  const viewportHeight = positive(options.viewportHeight);
  const scrollTop = Math.max(0, finite(options.scrollTop ?? 0, 0));
  const overscan = Math.max(0, Math.floor(finite(options.overscan ?? 0, 0)));
  const expandedIds = options.expandedIds ?? NO_EXPANDED;

  const flat = flattenTree(tree, { expanded: expandedIds });
  const visibleIds = flat.map((entry) => entry.node.id);
  const parents = collectParentIds(tree);
  const totalHeight = visibleIds.length * rowHeight;

  const { start, end } = fixedWindow(
    flat.length,
    rowHeight,
    viewportHeight,
    scrollTop,
    overscan,
  );

  const rows: PageTreeRenderRow[] = [];
  for (let index = start; index < end; index += 1) {
    const entry = flat[index];
    rows.push({
      id: entry.node.id,
      depth: entry.depth,
      top: index * rowHeight,
      height: rowHeight,
      expanded: entry.expanded,
      hasChildren: parents.has(entry.node.id),
    });
  }

  return { rows, totalHeight, startIndex: start, endIndex: end, rowHeight, viewportHeight, visibleIds };
}

/** The plan's half-open render window as `{ start, end }`. */
export function visibleRange(plan: PageTreeRenderPlan): PageTreeWindowRange {
  const start = Math.max(0, plan.startIndex);
  return { start, end: Math.max(start, plan.endIndex) };
}

/**
 * The `scrollTop` that centres row `index` in the viewport, clamped to the
 * scrollable range. Out-of-range indices clamp into the list; an empty plan
 * yields `0`.
 */
export function scrollToIndex(plan: PageTreeRenderPlan, index: number): number {
  const count = countRows(plan);
  if (count === 0) return 0;
  const target = Math.min(count - 1, Math.max(0, Math.floor(finite(index, 0))));
  const top = target * plan.rowHeight;
  const centred = top + plan.rowHeight / 2 - plan.viewportHeight / 2;
  return clampScrollTop(centred, plan);
}

/**
 * Whether a list of `rowCount` rows is long enough to virtualize. Strictly
 * greater than `threshold` (default {@link VIRTUALIZE_ROW_THRESHOLD}); a
 * non-finite or negative count is treated as `0`, and a non-positive threshold
 * means any non-empty list virtualizes.
 */
export function shouldVirtualize(rowCount: number, options: VirtualizeOptions = {}): boolean {
  const count = Math.max(0, Math.floor(finite(rowCount, 0)));
  const threshold = Math.max(
    0,
    Math.floor(finite(options.threshold ?? VIRTUALIZE_ROW_THRESHOLD, VIRTUALIZE_ROW_THRESHOLD)),
  );
  return count > threshold;
}

/** Number of rows a plan covers (its full visible list, not the window). */
function countRows(plan: PageTreeRenderPlan): number {
  return plan.rowHeight > 0
    ? Math.round(plan.totalHeight / plan.rowHeight)
    : plan.visibleIds.length;
}

/**
 * The `scrollTop` that keeps the row at `scrollTop` pinned across a plan change
 * (expand/collapse). The anchor row is the one whose top edge sits at
 * `scrollTop` in `prevPlan`; its index is looked up in `nextPlan.visibleIds` and
 * the offset into the row is preserved, so the same row stays at the same place
 * on screen. A row that no longer exists (collapsed away) or an out-of-range
 * scroll falls back to the clamped `scrollTop`.
 */
export function anchorForScroll(
  prevPlan: PageTreeRenderPlan,
  nextPlan: PageTreeRenderPlan,
  scrollTop: number,
): number {
  const prevHeight = positive(prevPlan.rowHeight);
  const scroll = Math.max(0, finite(scrollTop, 0));
  if (prevHeight === 0) return clampScrollTop(scroll, nextPlan);

  const prevIndex = Math.floor(scroll / prevHeight);
  const anchorId = prevPlan.visibleIds[prevIndex];
  if (anchorId === undefined) return clampScrollTop(scroll, nextPlan);

  const nextIndex = nextPlan.visibleIds.indexOf(anchorId);
  if (nextIndex < 0) return clampScrollTop(scroll, nextPlan);

  const intra = scroll - prevIndex * prevHeight;
  return clampScrollTop(nextIndex * positive(nextPlan.rowHeight) + intra, nextPlan);
}

/**
 * Deterministic perf model for a render window: `samples` passes over the
 * rendered rows, timed by an injected clock. `nodesVisited` is exactly
 * `rows.length * samples`, so a 1000-node tree stays well under a step budget
 * because only the window is visited — never the whole visible list.
 */
export function measurePerf(
  plan: PageTreeRenderPlan,
  options: MeasurePerfOptions = {},
): PageTreePerfSample {
  const samples = Math.max(0, Math.floor(finite(options.samples ?? 1, 1)));
  const now = options.now ?? (() => Date.now());

  const start = now();
  let nodesVisited = 0;
  for (let pass = 0; pass < samples; pass += 1) {
    nodesVisited += plan.rows.length;
  }
  const end = now();

  const elapsed = end - start;
  return { nodesVisited, durationMs: Number.isFinite(elapsed) && elapsed > 0 ? elapsed : 0 };
}

/** A stable one-line summary of a plan, for logs and test assertions. */
export function describeRenderPlan(plan: PageTreeRenderPlan): string {
  return `${plan.rows.length}/${countRows(plan)} rows · window [${plan.startIndex}, ${plan.endIndex}) · ${plan.totalHeight}px · ${plan.rowHeight}px/row`;
}
