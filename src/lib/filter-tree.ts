/**
 * AND/OR nested filter groups for database views.
 *
 * Pure extension of the flat filter model in `@/lib/database-query`: leaves
 * are the existing `Filter` (same operator vocabulary, same evaluation) and
 * groups nest to arbitrary depth, so views can express AND-of-ORs,
 * OR-of-ANDs, and anything deeper (docs/MISSING_FEATURES.md §3 rows
 * "AND/OR filter groups" and "Nested filter groups").
 *
 * No DB, no state — a UI can build, evaluate and immutably edit a tree
 * entirely with these functions.
 */

import { applyFilters } from "@/lib/database-query";
import type { Filter, QueryProperty, QueryRow } from "@/lib/database-query";

/**
 * A leaf: the existing flat `Filter` plus an optional stable `id`. The id is
 * not needed to evaluate the tree; `removeFilterById`/`replaceFilter` use it
 * to locate a leaf, so filter-panel UIs that edit trees should assign one.
 */
export type FilterTreeLeaf = Filter & { id?: string };

/** A group of nodes combined with a single conjunction, to any depth. */
export type FilterGroup = {
  conjunction: "AND" | "OR";
  children: FilterTreeNode[];
};

export type FilterTreeNode = FilterTreeLeaf | FilterGroup;

export function isFilterGroup(node: FilterTreeNode): node is FilterGroup {
  return "conjunction" in node;
}

/**
 * Evaluate one leaf by delegating to the flat evaluator (`applyFilters` on a
 * one-row list), so tree behaviour always matches today's flat filters —
 * including the neutral (true) result for a property that no longer exists.
 */
function evaluateLeaf(
  leaf: FilterTreeLeaf,
  row: QueryRow,
  props: QueryProperty[],
): boolean {
  return applyFilters([row], props, [leaf], "and").length === 1;
}

/**
 * Evaluate the whole tree against one row.
 *
 * - A group combines its children with its conjunction (`every` / `some`).
 * - An EMPTY group is neutral and evaluates to `true` regardless of its
 *   conjunction: a group with no filters expresses no constraint, mirroring
 *   how a view with zero flat filters shows every row.
 * - A leaf on an unknown property is `true` (same neutral rule as
 *   `applyFilters`), so deleting a property never hides existing rows.
 */
export function evaluateFilterTree(
  tree: FilterTreeNode,
  row: QueryRow,
  props: QueryProperty[],
): boolean {
  if (isFilterGroup(tree)) {
    if (tree.children.length === 0) return true;
    return tree.conjunction === "AND"
      ? tree.children.every((child) => evaluateFilterTree(child, row, props))
      : tree.children.some((child) => evaluateFilterTree(child, row, props));
  }
  return evaluateLeaf(tree, row, props);
}

/** Total number of leaves in the tree (for a "N filters" badge). */
export function countActiveFilters(tree: FilterTreeNode): number {
  if (!isFilterGroup(tree)) return 1;
  return tree.children.reduce((sum, child) => sum + countActiveFilters(child), 0);
}

/** Whether the tree constrains anything (has at least one leaf). */
export function hasActiveFilters(tree: FilterTreeNode): boolean {
  if (!isFilterGroup(tree)) return true;
  return tree.children.some(hasActiveFilters);
}

/**
 * Immutable removal: returns a new tree with every leaf whose `id` matches
 * removed at any depth. Groups are preserved even when emptied (an emptied
 * group is neutral), so the surrounding UI structure survives a deletion.
 * Returns the original reference when nothing matched.
 */
export function removeFilterById(
  tree: FilterTreeNode,
  id: string,
): FilterTreeNode {
  if (!isFilterGroup(tree)) {
    return tree.id === id ? { conjunction: "AND", children: [] } : tree;
  }
  let changed = false;
  const children: FilterTreeNode[] = [];
  for (const child of tree.children) {
    if (!isFilterGroup(child) && child.id === id) {
      changed = true;
      continue;
    }
    const next = removeFilterById(child, id);
    if (next !== child) changed = true;
    children.push(next);
  }
  return changed ? { ...tree, children } : tree;
}

/**
 * Immutable replacement: returns a new tree with the leaf whose `id` matches
 * swapped for `next` (which may itself be a group — the natural way for a UI
 * to turn a leaf into a nested group). Returns the original reference when
 * nothing matched.
 */
export function replaceFilter(
  tree: FilterTreeNode,
  id: string,
  next: FilterTreeNode,
): FilterTreeNode {
  if (!isFilterGroup(tree)) {
    return tree.id === id ? next : tree;
  }
  let changed = false;
  const children = tree.children.map((child) => {
    const replaced = replaceFilter(child, id, next);
    if (replaced !== child) changed = true;
    return replaced;
  });
  return changed ? { ...tree, children } : tree;
}
