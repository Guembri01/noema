/**
 * AND/OR filter-tree BUILDER model.
 *
 * A richer, immutable builder on top of the flat filter vocabulary in
 * `@/lib/database-query` (docs/MISSING_FEATURES.md §3 rows "AND/OR filter
 * groups" and "Nested filter groups"). Leaves carry a stable `id` and a
 * `propertyId`; groups combine children with `"and"` / `"or"` to any depth.
 *
 * The companion `@/lib/filter-tree` evaluates and edits a persisted tree by
 * leaf id. This module is the *editor* model: it addresses nodes by index
 * path, supports drag-style moves with cycle prevention, validates a tree
 * against a property list, normalises redundant structure, and can lower the
 * tree to a Prisma-friendly nested `where` and to a human sentence.
 *
 * No DB, no React, no state — every operation returns a new tree and never
 * mutates its input, so React sees a fresh reference on each edit.
 */

import { isFilterOperator, operatorsFor } from "@/lib/database-query";
import type { FilterOperator, QueryProperty } from "@/lib/database-query";

/* --- Node model ---------------------------------------------------------- */

/** A leaf filter: a property, an operator, and an optional target value. */
export type FilterLeaf = {
  /** Stable identity used by `findNode`, `findPath` and moves. */
  id: string;
  propertyId: string;
  op: FilterOperator;
  value?: string;
};

/** A group of nodes combined with one conjunction, to any depth. */
export type FilterGroup = {
  id: string;
  op: "and" | "or";
  children: FilterNode[];
};

export type FilterNode = FilterLeaf | FilterGroup;

export function isGroup(node: FilterNode): node is FilterGroup {
  return "children" in node;
}

export function isLeaf(node: FilterNode): node is FilterLeaf {
  return !isGroup(node);
}

/* --- Construction -------------------------------------------------------- */

let idSeq = 0;

function nextId(prefix: string): string {
  idSeq += 1;
  return `${prefix}-${idSeq}`;
}

export type MakeLeafInput = {
  propertyId: string;
  op: FilterOperator;
  value?: string;
  /** Supply one for deterministic fixtures; otherwise a unique id is minted. */
  id?: string;
};

/** Build a leaf. If `value` is absent the key is omitted (not `undefined`). */
export function makeLeaf(input: MakeLeafInput): FilterLeaf {
  const node: FilterLeaf = {
    id: input.id ?? nextId("leaf"),
    propertyId: input.propertyId,
    op: input.op,
  };
  if (input.value !== undefined) node.value = input.value;
  return node;
}

/**
 * Build a group. The children array is copied so a caller cannot mutate the
 * group through the array it passed in.
 */
export function makeGroup(
  op: "and" | "or" = "and",
  children: FilterNode[] = [],
  id?: string,
): FilterGroup {
  return { id: id ?? nextId("group"), op, children: [...children] };
}

/* --- Lookup -------------------------------------------------------------- */

/** Depth-first search for the node with `id` (`null` when absent). */
export function findNode(tree: FilterNode, id: string): FilterNode | null {
  if (tree.id === id) return tree;
  if (!isGroup(tree)) return null;
  for (const child of tree.children) {
    const found = findNode(child, id);
    if (found) return found;
  }
  return null;
}

/** The index path to the node with `id`, or `null` when absent. */
export function findPath(
  tree: FilterNode,
  id: string,
  base: number[] = [],
): number[] | null {
  if (tree.id === id) return [...base];
  if (!isGroup(tree)) return null;
  for (let index = 0; index < tree.children.length; index += 1) {
    const found = findPath(tree.children[index], id, [...base, index]);
    if (found) return found;
  }
  return null;
}

/** Resolve the node at an index path (`[]` is the tree itself). */
function nodeAtPath(tree: FilterNode, path: number[]): FilterNode | null {
  let current: FilterNode = tree;
  for (const index of path) {
    if (!isGroup(current)) return null;
    const child = current.children[index];
    if (!child) return null;
    current = child;
  }
  return current;
}

/* --- Immutable edits ----------------------------------------------------- */

/**
 * Append `node` to the group at `path`. A path that names a leaf (or does not
 * exist) is a no-op and returns the original tree.
 */
export function addNode(
  tree: FilterGroup,
  path: number[],
  node: FilterNode,
): FilterGroup {
  const target = nodeAtPath(tree, path);
  if (!target || !isGroup(target)) return tree;
  return insertIntoGroupById(tree, target.id, node);
}

/**
 * Remove the node at `path` and prune any group left empty. Path `[]` clears
 * the root's children (the root group itself always survives). An invalid path
 * is a no-op.
 */
export function removeNode(tree: FilterGroup, path: number[]): FilterGroup {
  if (path.length === 0) return { ...tree, children: [] };
  return removeAt(tree, path, true).node;
}

export type FilterLeafPatch = Partial<
  Pick<FilterLeaf, "propertyId" | "op" | "value">
>;

/**
 * Merge `patch` into the leaf at `path`. Throws when the path names a group —
 * change a group's conjunction by rebuilding it through `makeGroup`. An
 * unknown path is a no-op.
 */
export function updateNode(
  tree: FilterGroup,
  path: number[],
  patch: FilterLeafPatch,
): FilterGroup {
  const target = nodeAtPath(tree, path);
  if (!target) return tree;
  if (!isGroup(target)) {
    return replaceNodeById(tree, target.id, { ...target, ...patch });
  }
  throw new Error("updateNode: target is a group, not a leaf");
}

/**
 * Move the node at `fromPath` to become the last child of the group at
 * `toPath`. Self-moves, moving the root, and moving a group inside its own
 * subtree (a cycle) are no-ops; the original reference is returned so React
 * can skip the re-render.
 */
export function moveNode(
  tree: FilterGroup,
  fromPath: number[],
  toPath: number[],
): FilterGroup {
  if (fromPath.length === 0) return tree;
  const fromNode = nodeAtPath(tree, fromPath);
  const destination = nodeAtPath(tree, toPath);
  if (!fromNode || !destination || !isGroup(destination)) return tree;
  if (isDescendantPath(fromPath, toPath)) return tree;
  // Detach without pruning so a destination that is an ancestor is not
  // removed before we can re-insert into it; prune once the node is back.
  const detached = removeAt(tree, fromPath, false);
  if (!detached.removed) return tree;
  return pruneEmpty(insertIntoGroupById(detached.node, destination.id, detached.removed));
}

function isDescendantPath(ancestor: number[], path: number[]): boolean {
  if (path.length < ancestor.length) return false;
  return ancestor.every((value, index) => path[index] === value);
}

function insertIntoGroupById(
  group: FilterGroup,
  id: string,
  node: FilterNode,
): FilterGroup {
  if (group.id === id) return { ...group, children: [...group.children, node] };
  let changed = false;
  const children = group.children.map((child) => {
    if (!isGroup(child)) return child;
    const next = insertIntoGroupById(child, id, node);
    if (next !== child) changed = true;
    return next;
  });
  return changed ? { ...group, children } : group;
}

function replaceNodeById(
  group: FilterGroup,
  id: string,
  next: FilterNode,
): FilterGroup {
  let changed = false;
  const children = group.children.map((child) => {
    if (child.id === id) {
      changed = true;
      return next;
    }
    if (!isGroup(child)) return child;
    const replaced = replaceNodeById(child, id, next);
    if (replaced !== child) changed = true;
    return replaced;
  });
  return changed ? { ...group, children } : group;
}

type RemoveResult = { node: FilterGroup; removed: FilterNode | null };

/** Detach the node at `path`; `prune` drops groups left empty on the way up. */
function removeAt(
  group: FilterGroup,
  path: number[],
  prune: boolean,
): RemoveResult {
  if (path.length === 0) return { node: group, removed: null };
  const index = path[0];
  if (index < 0 || index >= group.children.length) {
    return { node: group, removed: null };
  }
  const child = group.children[index];
  const rest = path.slice(1);
  if (rest.length === 0) {
    return {
      node: { ...group, children: group.children.filter((_, i) => i !== index) },
      removed: child,
    };
  }
  if (!isGroup(child)) return { node: group, removed: null };
  const inner = removeAt(child, rest, prune);
  if (!inner.removed) return { node: group, removed: null };
  const keep = !prune || inner.node.children.length > 0;
  const children = keep
    ? group.children.map((candidate, i) => (i === index ? inner.node : candidate))
    : group.children.filter((_, i) => i !== index);
  return { node: { ...group, children }, removed: inner.removed };
}

/** Drop empty non-root groups (the root group itself is preserved). */
function pruneEmpty(group: FilterGroup): FilterGroup {
  let changed = false;
  const children: FilterNode[] = [];
  for (const child of group.children) {
    if (!isGroup(child)) {
      children.push(child);
      continue;
    }
    const pruned = pruneEmpty(child);
    if (pruned !== child) changed = true;
    if (pruned.children.length === 0) {
      changed = true;
      continue;
    }
    children.push(pruned);
  }
  return changed ? { ...group, children } : group;
}

/* --- Shape queries ------------------------------------------------------- */

/** Nesting depth measured in groups; the root group counts as one. */
export function depth(tree: FilterGroup): number {
  let deepest = 0;
  for (const child of tree.children) {
    if (isGroup(child)) deepest = Math.max(deepest, depth(child));
  }
  return deepest + 1;
}

/** Total nodes in the subtree, groups and leaves alike. */
export function nodeCount(tree: FilterNode): number {
  if (!isGroup(tree)) return 1;
  return 1 + tree.children.reduce((sum, child) => sum + nodeCount(child), 0);
}

/** Number of leaf filters in the subtree. */
export function leafCount(tree: FilterNode): number {
  if (!isGroup(tree)) return 1;
  return tree.children.reduce((sum, child) => sum + leafCount(child), 0);
}

/* --- Validation ---------------------------------------------------------- */

export type TreeValidationCode =
  | "unknown_property"
  | "unknown_operator"
  | "empty_group"
  | "depth_exceeded"
  | "type_mismatch";

export type TreeValidationIssue = {
  path: number[];
  code: TreeValidationCode;
  message: string;
  nodeId?: string;
};

export type ValidateTreeOptions = {
  properties: QueryProperty[];
  /** Maximum group nesting; the root is level one. Defaults to 5. */
  maxDepth?: number;
};

/**
 * Check a tree against the properties it will run on. Reports unknown
 * properties, unknown operators, operators a property type cannot use, empty
 * groups, and groups nested past the depth cap — every issue, not just the
 * first.
 */
export function validateTree(
  tree: FilterGroup,
  options: ValidateTreeOptions,
): TreeValidationIssue[] {
  const byId = new Map(options.properties.map((property) => [property.id, property]));
  const maxDepth = options.maxDepth ?? 5;
  const issues: TreeValidationIssue[] = [];

  const walk = (node: FilterNode, path: number[], level: number): void => {
    if (isLeaf(node)) {
      const property = byId.get(node.propertyId);
      if (!property) {
        issues.push({
          path,
          code: "unknown_property",
          nodeId: node.id,
          message: `Unknown property "${node.propertyId}"`,
        });
        return;
      }
      if (!isFilterOperator(node.op)) {
        issues.push({
          path,
          code: "unknown_operator",
          nodeId: node.id,
          message: `Unknown operator "${String(node.op)}"`,
        });
        return;
      }
      if (!operatorsFor(property.type).some((spec) => spec.value === node.op)) {
        issues.push({
          path,
          code: "type_mismatch",
          nodeId: node.id,
          message: `Operator "${node.op}" is not valid for a ${property.type} property`,
        });
      }
      return;
    }

    if (level > maxDepth) {
      issues.push({
        path,
        code: "depth_exceeded",
        nodeId: node.id,
        message: `Nesting exceeds the depth cap of ${maxDepth}`,
      });
    }
    if (node.children.length === 0) {
      issues.push({
        path,
        code: "empty_group",
        nodeId: node.id,
        message: "Group has no conditions",
      });
    }
    node.children.forEach((child, index) => walk(child, [...path, index], level + 1));
  };

  walk(tree, [], 1);
  return issues;
}

/* --- Normalisation ------------------------------------------------------- */

function normalizeNode(node: FilterNode): FilterNode {
  if (isLeaf(node)) return node;
  const children = node.children.map(normalizeNode);
  // A group with exactly one child says nothing a bare child does not, so the
  // wrapper collapses (AND/OR of one operand is that operand).
  if (children.length === 1) return children[0];
  return { ...node, children };
}

/**
 * Flatten redundant single-child groups. The result is still a group: a root
 * that collapsed to a single leaf is re-wrapped under the original root op.
 */
export function normalizeTree(tree: FilterGroup): FilterGroup {
  const normalized = normalizeNode(tree);
  return isGroup(normalized) ? normalized : { ...tree, children: [normalized] };
}

/* --- Lowering to a nested query ------------------------------------------ */

/**
 * A Prisma-friendly nested `where`: groups become `{ AND: [...] }` /
 * `{ OR: [...] }`, leaves keep the builder's `propertyId` / `op` / `value`
 * fields for the caller to map onto real columns.
 */
export type QueryExpr =
  | { AND: QueryExpr[] }
  | { OR: QueryExpr[] }
  | { propertyId: string; op: FilterOperator; value?: string };

function toExpr(node: FilterNode): QueryExpr {
  if (isLeaf(node)) {
    return node.value !== undefined
      ? { propertyId: node.propertyId, op: node.op, value: node.value }
      : { propertyId: node.propertyId, op: node.op };
  }
  const children = node.children.map(toExpr);
  if (children.length === 1) return children[0];
  return node.op === "and" ? { AND: children } : { OR: children };
}

/** Lower a tree to a nested boolean expression (single-child groups collapse). */
export function toQueryExpr(tree: FilterGroup): QueryExpr {
  return toExpr(tree);
}

/* --- Human-readable description ------------------------------------------ */

const OPERATOR_LABELS: Record<FilterOperator, string> = {
  is: "is",
  is_not: "is not",
  contains: "contains",
  does_not_contain: "does not contain",
  starts_with: "starts with",
  ends_with: "ends with",
  is_empty: "is empty",
  is_not_empty: "is not empty",
  gt: ">",
  gte: ">=",
  lt: "<",
  lte: "<=",
  before: "is before",
  after: "is after",
  checked: "is checked",
  unchecked: "is unchecked",
};

const VALUELESS_OPERATORS: ReadonlySet<FilterOperator> = new Set([
  "is_empty",
  "is_not_empty",
  "checked",
  "unchecked",
]);

export type DescribeOptions = {
  /** Property-id → display name. Defaults to the id itself. */
  propertyName?: (propertyId: string) => string;
};

function describeLeaf(leaf: FilterLeaf, propertyName: (id: string) => string): string {
  const label = OPERATOR_LABELS[leaf.op] ?? leaf.op;
  const name = propertyName(leaf.propertyId);
  if (VALUELESS_OPERATORS.has(leaf.op) || leaf.value === undefined) {
    return `${name} ${label}`;
  }
  return `${name} ${label} ${leaf.value}`;
}

function describeNode(node: FilterNode, propertyName: (id: string) => string): string {
  if (isLeaf(node)) return describeLeaf(node, propertyName);
  const parts = node.children.map((child) => describeNode(child, propertyName));
  if (parts.length === 0) return "";
  if (parts.length === 1) return parts[0];
  return `(${parts.join(node.op === "and" ? " AND " : " OR ")})`;
}

/**
 * Render a tree as a sentence, e.g.
 * `Status is Done AND (Priority is High OR Due is before 2026-02-01)`.
 * Top-level conditions are joined by their group op; nested groups are
 * parenthesised.
 */
export function describeTree(tree: FilterGroup, options?: DescribeOptions): string {
  const propertyName = options?.propertyName ?? ((id: string) => id);
  const parts = tree.children.map((child) => describeNode(child, propertyName));
  if (parts.length === 0) return "";
  return parts.join(tree.op === "and" ? " AND " : " OR ");
}
