import type { PageTreeNode } from "@/server/queries";

/**
 * Pure page-tree logic, extracted verbatim from
 * `src/components/sidebar/page-tree.tsx` (B66) so the sidebar's render-plan
 * decisions are provable without a DOM. The component calls the original
 * helpers below; nothing changed on extraction. The tree-operation helpers
 * added later for MISSING_FEATURES §9 (reparent guard, virtualization flatten,
 * subtree collection, breadcrumb ancestry) are pure as well — no DB, no DOM.
 */

/**
 * Group the flat tree rows by `parentId` (`null` key = roots). Input order is
 * preserved inside each group, which is what keeps `position` ordering intact.
 */
export function groupByParent(
  tree: readonly PageTreeNode[],
): Map<string | null, PageTreeNode[]> {
  const map = new Map<string | null, PageTreeNode[]>();
  for (const node of tree) {
    const key = node.parentId;
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(node);
  }
  return map;
}

/**
 * The rows shown at one level of the tree. The `rootFilter` (teamspace /
 * private section split) only ever applies to roots — children of a shown root
 * always render, matching the component's original expression.
 */
export function visibleChildren(
  byParent: Map<string | null, PageTreeNode[]>,
  parentId: string | null,
  rootFilter?: (node: PageTreeNode) => boolean,
): PageTreeNode[] {
  return (byParent.get(parentId) ?? []).filter(
    (node) => parentId !== null || !rootFilter || rootFilter(node),
  );
}

export type FlattenEntry = { node: PageTreeNode; depth: number };

/**
 * The component's render plan: every *visible* row in pre-order with its
 * indent depth. Collapsed subtrees are omitted even when their ids are still
 * in `expanded` (stale expanded ids are inert). Single-parent data cannot
 * form a reachable cycle, so the walk terminates on well-formed and malformed
 * input alike.
 */
export function flattenVisible(
  tree: PageTreeNode[],
  expanded: ReadonlySet<string>,
  rootFilter?: (node: PageTreeNode) => boolean,
): FlattenEntry[] {
  const byParent = groupByParent(tree);
  const plan: FlattenEntry[] = [];
  const walk = (parentId: string | null, depth: number, filter?: (node: PageTreeNode) => boolean) => {
    for (const node of visibleChildren(byParent, parentId, filter)) {
      plan.push({ node, depth });
      if (expanded.has(node.id)) walk(node.id, depth + 1);
    }
  };
  walk(null, 0, rootFilter);
  return plan;
}

/**
 * Expand/collapse update for the `expanded: Set<string>` sidebar state —
 * returns a NEW set (React state must never be mutated in place).
 */
export function toggleExpanded(
  expanded: ReadonlySet<string>,
  id: string,
): Set<string> {
  const next = new Set(expanded);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/**
 * Candidate parents for "Move to": every page except the moved page and its own
 * descendants (the server also guards cycles — this just hides impossible choices).
 *
 * The fix-point loop keeps re-scanning until no node is added, so descendants
 * are blocked even when they appear before their ancestor in the array.
 */
export function moveCandidates(
  tree: PageTreeNode[],
  node: PageTreeNode,
): PageTreeNode[] {
  const blocked = new Set<string>([node.id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const candidate of tree) {
      if (candidate.parentId && blocked.has(candidate.parentId) && !blocked.has(candidate.id)) {
        blocked.add(candidate.id);
        grew = true;
      }
    }
  }
  return tree.filter((candidate) => !blocked.has(candidate.id)).slice(0, 12);
}

// ---------------------------------------------------------------------------
// Tree operations (MISSING_FEATURES §9 — "Move page" + large-tree helpers).
// All pure: no DB, no DOM, no mutation of the caller's rows.
// ---------------------------------------------------------------------------

/** Minimal structural view of a row — callers may pass plain `{id, parentId}` pairs. */
export type TreeNodeRef = { id: string; parentId: string | null };

/** O(1) id lookup built once per operation. */
type NodeIndex = ReadonlyMap<string, PageTreeNode>;

function byIdIndex(tree: readonly PageTreeNode[]): Map<string, PageTreeNode> {
  return new Map(tree.map((n) => [n.id, n]));
}

/**
 * Root → `pageId` path in breadcrumb order, or `null` when the lineage cannot
 * be verified: the start id is unknown, an ancestor is missing from the list,
 * or a parent cycle loops before reaching a root. Fail-closed by design — a
 * caller never renders (or trusts) a chain it could not walk to the top.
 * Linear in path depth after the index build.
 */
function walkAncestry(index: NodeIndex, pageId: string): PageTreeNode[] | null {
  const path: PageTreeNode[] = [];
  const seen = new Set<string>();
  let currentId: string | null = pageId;
  while (currentId !== null) {
    if (seen.has(currentId)) return null; // parent cycle — stop, do not loop
    seen.add(currentId);
    const node = index.get(currentId);
    if (!node) return null; // start id or an ancestor missing from the list
    path.push(node);
    currentId = node.parentId;
  }
  return path.reverse();
}

/**
 * Cycle-safe reparent guard: true iff `pageId` exists and `newParentId`
 * (`null` = top level) exists and is neither the page itself nor one of its
 * descendants. Descendants are detected by walking the *target's* ancestry —
 * the move would close a cycle exactly when the page sits on that chain, no
 * full subtree scan needed. Targets whose own lineage never reaches a root
 * (orphan cycle, parent missing from a partial list) are rejected as well:
 * the guard fails closed instead of guessing.
 */
export function canReparent(
  tree: readonly PageTreeNode[],
  pageId: string,
  newParentId: string | null,
): boolean {
  const index = byIdIndex(tree);
  if (!index.has(pageId)) return false; // missing page
  if (newParentId === null) return true; // move to top level
  if (newParentId === pageId) return false; // self
  if (!index.has(newParentId)) return false; // missing target
  const targetPath = walkAncestry(index, newParentId);
  if (targetPath === null) return false; // unverifiable target lineage
  return !targetPath.some((n) => n.id === pageId); // pageId is an ancestor
}

/**
 * Apply `canReparent`: returns a NEW array with the page's `parentId` swapped,
 * or `null` when the guard rejects the move. The subtree travels with the page
 * (child links untouched); the input array and its rows are never mutated and
 * untouched rows keep their identity. Sibling ordering / `position` bookkeeping
 * is the server action's job — this stays pure.
 */
export function movePage(
  tree: readonly PageTreeNode[],
  pageId: string,
  newParentId: string | null,
): PageTreeNode[] | null {
  if (!canReparent(tree, pageId, newParentId)) return null;
  return tree.map((n) => (n.id === pageId ? { ...n, parentId: newParentId } : n));
}

/**
 * Breadcrumb path root → page (page last). Empty when the page is unknown or
 * its lineage cannot be walked to a root — same fail-closed rule as the guard.
 */
export function ancestryOf(
  tree: readonly PageTreeNode[],
  pageId: string,
): PageTreeNode[] {
  return walkAncestry(byIdIndex(tree), pageId) ?? [];
}

export type FlattenTreeOptions = {
  /** Ids of open nodes (default: none). Stale ids under a collapsed ancestor are inert. */
  expanded?: ReadonlySet<string>;
  /** Teamspace/section split — applied only to roots, like `flattenVisible`. */
  rootFilter?: (node: PageTreeNode) => boolean;
  /**
   * Also emit rows inside collapsed subtrees, marked `visible: false`, so a
   * virtualizer can lay out the whole tree while the renderer shows only the
   * open slice. Off = render-plan mode (hidden rows omitted, as flattenVisible).
   */
  includeCollapsed?: boolean;
};

export type FlattenTreeRow = FlattenEntry & {
  /** Shown given the expand state + root filter (every ancestor open). */
  visible: boolean;
  /** The node's own open state, mirroring `opts.expanded`. */
  expanded: boolean;
};

const NO_EXPANDED: ReadonlySet<string> = new Set();

/**
 * Stable pre-order flatten with depth + expand-state per row — the plan a
 * virtualized sidebar renders from. Siblings keep input order (the query's
 * `position` ordering), roots start at depth 0, children follow their parent
 * contiguously. Only rows reachable from a root are emitted: orphaned or
 * cyclic rows never appear, exactly like `flattenVisible`.
 */
export function flattenTree(
  tree: readonly PageTreeNode[],
  opts: FlattenTreeOptions = {},
): FlattenTreeRow[] {
  const expanded = opts.expanded ?? NO_EXPANDED;
  const { rootFilter, includeCollapsed = false } = opts;
  const byParent = groupByParent(tree);
  const rows: FlattenTreeRow[] = [];
  const walk = (
    parentId: string | null,
    depth: number,
    parentVisible: boolean,
  ): void => {
    for (const node of byParent.get(parentId) ?? []) {
      // section split: a filtered-out root takes its whole subtree with it
      if (parentId === null && rootFilter && !rootFilter(node)) continue;
      const visible =
        parentId === null ? true : parentVisible && expanded.has(parentId);
      rows.push({ node, depth, visible, expanded: expanded.has(node.id) });
      if (includeCollapsed || (visible && expanded.has(node.id))) {
        walk(node.id, depth + 1, visible);
      }
    }
  };
  walk(null, 0, true);
  return rows;
}

/**
 * `pageId` plus every descendant as an id set, in tree pre-order (seed first) —
 * the pure kernel under delete/bulk-move containment checks. Works on plain
 * `{id, parentId}` rows, gathers orphaned subtrees (parent missing from the
 * list) and terminates on malformed descendant cycles via the visited set.
 * Unknown page → empty set.
 */
export function collectSubtree(
  ids: Iterable<TreeNodeRef>,
  pageId: string,
): Set<string> {
  const children = new Map<string | null, string[]>();
  const known = new Set<string>();
  for (const row of ids) {
    known.add(row.id);
    const bucket = children.get(row.parentId) ?? [];
    bucket.push(row.id);
    children.set(row.parentId, bucket);
  }
  const result = new Set<string>();
  if (!known.has(pageId)) return result;
  const stack: string[] = [pageId];
  result.add(pageId);
  while (stack.length > 0) {
    const kids = children.get(stack.pop()!);
    if (!kids) continue;
    for (let i = kids.length - 1; i >= 0; i--) {
      const kid = kids[i];
      if (result.has(kid)) continue; // already collected — also breaks cycles
      result.add(kid);
      stack.push(kid);
    }
  }
  return result;
}
