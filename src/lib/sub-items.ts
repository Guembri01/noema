/**
 * Sub-items / sub-tasks tree engine (docs/MISSING_FEATURES.md §3, "Sub-items /
 * sub-tasks" — parent-child rows inside a database).
 *
 * Rows form a forest through an optional `parentId` (`null`/absent = top
 * level) and are ordered among their siblings by an optional numeric `order`.
 * This module is the pure kernel behind indent/outdent, drag-to-reparent,
 * collapsed rendering, integrity checks and sibling renumbering: no DB, no
 * routes, no React, and never a mutation of the caller's rows — every
 * operation returns fresh arrays/rows.
 *
 * Ordering convention: siblings are sorted by `order` ascending, ties (and
 * missing `order`) keep the input order, so unordered data still renders
 * predictably. `ORDER_STEP` is the 1000 spacing `renumberSiblings` applies.
 */

export type SubItemRow = {
  id: string;
  parentId?: string | null;
  order?: number;
};

/** An integrity problem found by {@link validateSubItems}. */
export type SubItemIssue =
  | { kind: "self-parent"; id: string }
  | { kind: "unknown-parent"; id: string; parentId: string }
  /** A parent cycle; `path` is a concrete closed walk (`[a, b, c, a]`). */
  | { kind: "cycle"; path: string[] };

/** Spacing applied by {@link renumberSiblings}. */
const ORDER_STEP = 1000;

const parentOf = (row: SubItemRow): string | null => row.parentId ?? null;
const orderOf = (row: SubItemRow): number => row.order ?? 0;

function indexById<T extends SubItemRow>(rows: readonly T[]): Map<string, T> {
  return new Map(rows.map((row) => [row.id, row]));
}

/**
 * Direct children of `parentId`, sorted by `order` (ties keep input order).
 * Returns a new array; the input is never reordered.
 */
export function childrenOf<T extends SubItemRow>(
  rows: readonly T[],
  parentId: string | null,
): T[] {
  const target = parentId ?? null;
  return rows
    .filter((row) => parentOf(row) === target)
    .sort((a, b) => orderOf(a) - orderOf(b));
}

/**
 * Ancestors of `id` from root to immediate parent (the node itself excluded).
 * Stops safely on a parent cycle; unknown ids yield an empty list.
 */
export function ancestorsOf<T extends SubItemRow>(
  rows: readonly T[],
  id: string,
): T[] {
  const byId = indexById(rows);
  const start = byId.get(id);
  if (!start) return [];
  const chain: T[] = [];
  const seen = new Set<string>([id]);
  let current = parentOf(start);
  while (current !== null) {
    if (seen.has(current)) break; // parent cycle — stop, do not loop
    seen.add(current);
    const parent = byId.get(current);
    if (!parent) break; // ancestor missing from the list
    chain.push(parent);
    current = parentOf(parent);
  }
  return chain.reverse();
}

/** Depth of `id` (roots = 0), or `-1` when the id is not in the list. */
export function depthOf(rows: readonly SubItemRow[], id: string): number {
  if (!indexById(rows).has(id)) return -1;
  return ancestorsOf(rows, id).length;
}

/**
 * `id` plus every descendant, in depth-first pre-order (siblings by `order`).
 * Unknown ids yield an empty list; malformed descendant cycles are visited
 * once.
 */
export function subtreeOf<T extends SubItemRow>(
  rows: readonly T[],
  id: string,
): T[] {
  const seed = indexById(rows).get(id);
  if (!seed) return [];
  const groups = new Map<string | null, T[]>();
  for (const row of rows) {
    const key = parentOf(row);
    const bucket = groups.get(key);
    if (bucket) bucket.push(row);
    else groups.set(key, [row]);
  }
  for (const bucket of groups.values()) bucket.sort((a, b) => orderOf(a) - orderOf(b));

  const out: T[] = [];
  const visited = new Set<string>();
  const stack: T[] = [seed];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (visited.has(node.id)) continue; // cycle / already-collected guard
    visited.add(node.id);
    out.push(node);
    const kids = groups.get(node.id);
    if (kids) for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
  }
  return out;
}

/**
 * Structural problems in `rows`, in a stable order: self-parent and
 * unknown-parent issues in input order, then one entry per distinct parent
 * cycle. Never throws — malformed data produces issues, not errors.
 */
export function validateSubItems(rows: readonly SubItemRow[]): SubItemIssue[] {
  const byId = indexById(rows);
  const issues: SubItemIssue[] = [];

  for (const row of rows) {
    const parent = parentOf(row);
    if (parent === row.id) issues.push({ kind: "self-parent", id: row.id });
    else if (parent !== null && !byId.has(parent)) {
      issues.push({ kind: "unknown-parent", id: row.id, parentId: parent });
    }
  }

  // Walk parent links from every not-yet-settled row; the first repeat on the
  // current path is a cycle, reported with the concrete closed path.
  const settled = new Set<string>();
  for (const start of rows) {
    if (settled.has(start.id)) continue;
    const path: string[] = [];
    const onPath = new Map<string, number>();
    let current: string | null = start.id;
    while (current !== null) {
      if (settled.has(current)) break;
      const at = onPath.get(current);
      if (at !== undefined) {
        issues.push({ kind: "cycle", path: path.slice(at).concat(current) });
        break;
      }
      const row = byId.get(current);
      if (!row) break; // unknown parent terminates the walk
      if (parentOf(row) === row.id) break; // self-parent, reported above
      onPath.set(current, path.length);
      path.push(current);
      current = parentOf(row);
    }
    for (const id of path) settled.add(id);
  }
  return issues;
}

/**
 * Indent `id` one level: it becomes the last child of its previous sibling.
 * A safe no-op (same array reference) when `id` is unknown or has no previous
 * sibling. New order is the highest child order of the new parent + `ORDER_STEP`.
 */
export function indent<T extends SubItemRow>(rows: readonly T[], id: string): T[] {
  const row = indexById(rows).get(id);
  if (!row) return rows as T[];
  const siblings = childrenOf(rows, parentOf(row));
  const position = siblings.findIndex((sibling) => sibling.id === id);
  const previous = position > 0 ? siblings[position - 1] : undefined;
  if (!previous) return rows as T[]; // first sibling (or no siblings) — no-op
  const existing = childrenOf(rows, previous.id);
  const order = (existing.length ? Math.max(...existing.map(orderOf)) : 0) + ORDER_STEP;
  return rows.map((item) =>
    item.id === id ? ({ ...item, parentId: previous.id, order } as T) : item,
  );
}

/**
 * Outdent `id` one level: it is promoted to its grandparent and placed
 * immediately after its former parent, with the destination level renumbered
 * to `ORDER_STEP` spacing so the position holds regardless of prior values.
 * A safe no-op (same array reference) for roots, unknown ids and dangling
 * parents.
 */
export function outdent<T extends SubItemRow>(rows: readonly T[], id: string): T[] {
  const byId = indexById(rows);
  const row = byId.get(id);
  if (!row) return rows as T[];
  const parentId = parentOf(row);
  if (parentId === null) return rows as T[]; // already a root
  const parent = byId.get(parentId);
  if (!parent) return rows as T[]; // dangling parent — nothing to promote to
  const grandparentId = parentOf(parent);

  const destination = childrenOf(rows, grandparentId).filter((node) => node.id !== id);
  const parentIndex = destination.findIndex((node) => node.id === parentId);
  const insertAt = parentIndex >= 0 ? parentIndex + 1 : destination.length;
  const sequence = [
    ...destination.slice(0, insertAt),
    row,
    ...destination.slice(insertAt),
  ];
  const orderById = new Map(sequence.map((node, i) => [node.id, (i + 1) * ORDER_STEP]));

  return rows.map((item) => {
    if (item.id === id) {
      return { ...item, parentId: grandparentId, order: orderById.get(item.id)! } as T;
    }
    const order = orderById.get(item.id);
    return order === undefined ? item : ({ ...item, order } as T);
  });
}

/**
 * Whether `moveSubtree(rows, id, newParentId)` would be accepted. Rejects
 * unknown ids, unknown target parents, self-parenting and moves onto a
 * descendant of `id` (which would close a cycle). `newParentId === null`
 * (top level) is always allowed for a known id.
 */
export function canMoveSubtree(
  rows: readonly SubItemRow[],
  id: string,
  newParentId: string | null,
): boolean {
  const byId = indexById(rows);
  if (!byId.has(id)) return false;
  if (newParentId === id) return false;
  if (newParentId !== null && !byId.has(newParentId)) return false;
  if (newParentId === null) return true;
  return !subtreeOf(rows, id).some((node) => node.id === newParentId);
}

/**
 * Reparent `id` (with its whole subtree staying attached) under
 * `newParentId`, appended after the target's existing children. Rejected
 * moves (see {@link canMoveSubtree}) return the input reference unchanged.
 */
export function moveSubtree<T extends SubItemRow>(
  rows: readonly T[],
  id: string,
  newParentId: string | null,
): T[] {
  if (!canMoveSubtree(rows, id, newParentId)) return rows as T[];
  const existing = childrenOf(rows, newParentId).filter((node) => node.id !== id);
  const order = (existing.length ? Math.max(...existing.map(orderOf)) : 0) + ORDER_STEP;
  return rows.map((item) =>
    item.id === id ? ({ ...item, parentId: newParentId, order } as T) : item,
  );
}

/**
 * Rows a view renders with `collapsed` ids folded shut: the forest in
 * depth-first pre-order, omitting the descendants of any collapsed node (the
 * collapsed node itself stays visible). Rows unreachable from a root
 * (orphans, cycles) are omitted, matching {@link validateSubItems}.
 */
export function visibleRows<T extends SubItemRow>(
  rows: readonly T[],
  collapsed: ReadonlySet<string>,
): T[] {
  const groups = new Map<string | null, T[]>();
  for (const row of rows) {
    const key = parentOf(row);
    const bucket = groups.get(key);
    if (bucket) bucket.push(row);
    else groups.set(key, [row]);
  }
  for (const bucket of groups.values()) bucket.sort((a, b) => orderOf(a) - orderOf(b));

  const out: T[] = [];
  const visited = new Set<string>();
  const walk = (parentId: string | null): void => {
    for (const node of groups.get(parentId) ?? []) {
      if (visited.has(node.id)) continue; // cycle guard
      visited.add(node.id);
      out.push(node);
      if (!collapsed.has(node.id)) walk(node.id);
    }
  };
  walk(null);
  return out;
}

/**
 * Renumber one sibling group (`parentId === null` for roots) to
 * 1000/2000/3000… spacing, leaving every other row untouched. No-op (same
 * array reference) when the group is empty.
 */
export function renumberSiblings<T extends SubItemRow>(
  rows: readonly T[],
  parentId: string | null,
): T[] {
  const ordered = childrenOf(rows, parentId);
  if (ordered.length === 0) return rows as T[];
  const orderById = new Map(ordered.map((row, i) => [row.id, (i + 1) * ORDER_STEP]));
  return rows.map((row) => {
    const order = orderById.get(row.id);
    return order === undefined ? row : ({ ...row, order } as T);
  });
}
