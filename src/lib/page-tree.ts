import type { PageTreeNode } from "@/server/queries";

/**
 * Pure page-tree logic, extracted verbatim from
 * `src/components/sidebar/page-tree.tsx` (B66) so the sidebar's render-plan
 * decisions are provable without a DOM. The component calls every function
 * below; nothing here changed behaviour on extraction.
 */

/**
 * Group the flat tree rows by `parentId` (`null` key = roots). Input order is
 * preserved inside each group, which is what keeps `position` ordering intact.
 */
export function groupByParent(
  tree: PageTreeNode[],
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
