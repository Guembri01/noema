/**
 * F5 — pure page-breadcrumb shaping.
 *
 * The data layer already walks the ancestor trail (`getAncestorTrail` in
 * `src/server/queries.ts`) and the sidebar kernel exposes a tree-based walk
 * (`ancestryOf` in `src/lib/page-tree.ts`), but neither is usable from the
 * page header without a DB or a `PageTreeNode`: this module is the small,
 * view-facing layer over plain `{ id, parentId, title }` rows.
 *
 * It does four things, all pure and deterministic (no DB, no DOM, inputs are
 * never mutated):
 *  - {@link buildBreadcrumb} — the labelled root → page chain.
 *  - {@link truncateBreadcrumb} — budget a deep chain, collapsing the middle.
 *  - {@link breadcrumbLabel} — the title/`Untitled` fallback.
 *  - {@link isSameChain} — id-wise comparison for cheap render diffing.
 *
 * The ancestry walk deliberately fails closed, matching `ancestryOf`: a start
 * id that is unknown, an ancestor missing from the list, or a parent cycle all
 * produce `[]` rather than a partial (untrustworthy) chain.
 */

/** Minimal row shape the crumb builder needs; extra fields are ignored. */
export type BreadcrumbPage = {
  id: string;
  parentId: string | null;
  /** Page title; blank or absent renders as {@link UNTITLED_LABEL}. */
  title?: string | null;
};

/** Fallback label for pages with no (or blank) title. */
export const UNTITLED_LABEL = "Untitled";

/** One rendered crumb: the page id plus its display label. */
export type BreadcrumbItem = {
  id: string;
  label: string;
};

/**
 * Id stamped on the synthetic crumb {@link truncateBreadcrumb} inserts for the
 * collapsed middle of a chain. Prefixed so it cannot collide with a page id in
 * practice; callers may compare against it directly.
 */
export const BREADCRUMB_ELLIPSIS_ID = "__ellipsis__";

/** Default ellipsis crumb label (a single typographic ellipsis). */
export const DEFAULT_ELLIPSIS_LABEL = "…";

/**
 * Display label for a page: its trimmed title, or {@link UNTITLED_LABEL} when
 * the title is absent or only whitespace. Only reads from `page`.
 */
export function breadcrumbLabel(page: Pick<BreadcrumbPage, "title">): string {
  const title = page.title?.trim();
  return title ? title : UNTITLED_LABEL;
}

/**
 * Ancestor chain root → `pageId` (the page itself last), as labelled crumbs.
 *
 * Cycle-safe and fail-closed: an unknown start id, an ancestor missing from
 * `pages`, or a parent cycle (including a self-parented page) all yield `[]`
 * rather than a truncated trail. Row order in `pages` is irrelevant — an
 * index is built first, so the walk is O(depth) after an O(n) pass. The input
 * rows and their fields are never mutated.
 */
export function buildBreadcrumb(
  pages: readonly BreadcrumbPage[],
  pageId: string,
): BreadcrumbItem[] {
  const index = new Map<string, BreadcrumbPage>();
  for (const page of pages) index.set(page.id, page);

  const chain: BreadcrumbPage[] = [];
  const seen = new Set<string>();
  let currentId: string | null = pageId;
  while (currentId !== null) {
    if (seen.has(currentId)) return []; // parent cycle — stop, never loop
    seen.add(currentId);
    const page = index.get(currentId);
    if (!page) return []; // unknown start id / ancestor missing from list
    chain.push(page);
    currentId = page.parentId;
  }

  chain.reverse();
  return chain.map((page) => ({ id: page.id, label: breadcrumbLabel(page) }));
}

export type TruncateBreadcrumbOptions = {
  /** Maximum crumbs in the result, the ellipsis crumb included. */
  max: number;
  /** Label for the synthetic ellipsis crumb. Defaults to `…`. */
  ellipsisLabel?: string;
};

/**
 * Shrink a chain to at most `max` crumbs, always keeping the first (root) and
 * the deepest (current page) end, collapsing the middle into a single ellipsis
 * crumb. Returns a new array; the input crumb objects are reused and never
 * mutated.
 *
 * - `max <= 0` → `[]`.
 * - chain already within `max` → the same crumbs, in order.
 * - `max === 1` → the last crumb only (the current page is the most useful).
 * - `max === 2` → first + last, with no room for an ellipsis.
 * - otherwise → `[first, ellipsis, ...last (max - 2)]`, keeping the deepest
 *   crumbs so the closest context survives the cut.
 */
export function truncateBreadcrumb(
  items: readonly BreadcrumbItem[],
  { max, ellipsisLabel = DEFAULT_ELLIPSIS_LABEL }: TruncateBreadcrumbOptions,
): BreadcrumbItem[] {
  if (max <= 0) return [];
  if (items.length <= max) return items.slice();
  if (max === 1) return items.slice(-1);
  if (max === 2) return [items[0], items[items.length - 1]];
  const ellipsis: BreadcrumbItem = {
    id: BREADCRUMB_ELLIPSIS_ID,
    label: ellipsisLabel,
  };
  return [items[0], ellipsis, ...items.slice(items.length - (max - 2))];
}

/**
 * True when two chains reference the same pages in the same order, compared by
 * `id` only — a restyled or retitled crumb does not count as a different
 * chain, but a different length or a swapped/differing id does. Lets the
 * header skip work when navigation lands on the same trail.
 */
export function isSameChain(
  a: readonly Pick<BreadcrumbItem, "id">[],
  b: readonly Pick<BreadcrumbItem, "id">[],
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i].id !== b[i].id) return false;
  }
  return true;
}
