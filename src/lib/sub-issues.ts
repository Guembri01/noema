/**
 * Sub-issue / dependency-tree engine (docs/specs/database-deep.md R89.30
 * sub-items & sub-tasks, R89.31 dependencies + timeline arrows).
 *
 * A single pure kernel behind three related product features:
 *
 * - **Sub-issues (R89.30)** — rows form a forest through an optional parent
 *   field (`parentId` by default) and are ordered among siblings by an optional
 *   numeric field (`order` by default). `buildSubIssueTree` nests them, reports
 *   orphan rows and parent cycles, and enforces a depth cap (default 1, the M3
 *   "one level deep" boundary). `flattenTree` renders the visible rows for a
 *   collapsed set; `rollupEstimates` / `childProgress` roll estimate + done
 *   state up a subtree.
 * - **Moves** — `moveSubIssue` reorders / reparents a row with a cycle guard
 *   and the same depth cap; rejected moves return the input reference unchanged.
 * - **Dependencies (R89.31)** — `dependencyTree` builds the blocked-by / blocks
 *   transitive closure from `{ blockerId, blockedId }` edges and reports
 *   cycles; `criticalPath` finds the longest weighted path deterministically.
 *
 * Everything is data in / data out — no DB, no routes, no React — and no
 * function mutates its input. Rows are read through configurable string keys
 * (`parentKey`, `orderKey`, `estimateKey`, `doneKey`) so the same kernel serves
 * any row shape; ids are assumed unique (the first row with an id wins).
 */

/** Minimum row shape: every row is keyed by a unique `id`. */
export type SubIssueRow = { id: string };

/** A node of the nested forest built by {@link buildSubIssueTree}. */
export type SubIssueNode<T extends SubIssueRow = SubIssueRow> = {
  row: T;
  id: string;
  /** Distance from the nearest root; roots are `0`. */
  depth: number;
  children: SubIssueNode<T>[];
};

export type BuildSubIssueTreeOptions = {
  /** Field holding the parent id. Default `"parentId"`. */
  parentKey?: string;
  /** Numeric sibling-order field. Default `"order"`. */
  orderKey?: string;
  /**
   * Maximum node depth that stays nested (roots are depth 0). Rows deeper than
   * this are reported as orphans. Default `1` (R89.30's M3 boundary).
   */
  maxDepth?: number;
};

export type SubIssueTree<T extends SubIssueRow = SubIssueRow> = {
  /** Root nodes, each carrying its nested subtree. */
  tree: SubIssueNode<T>[];
  /**
   * Rows that could not be placed: unknown/absent target parents, rows deeper
   * than `maxDepth`, and rows dangling below a cycle. Input order.
   */
  orphans: T[];
  /** One concrete closed walk per parent cycle, e.g. `[a, b, a]`. */
  cycles: string[][];
};

export type FlattenOptions = {
  /** Ids whose descendants are folded shut (the collapsed row stays visible). */
  collapsedIds?: Iterable<string>;
};

/** One visible row emitted by {@link flattenTree}. */
export type FlatSubIssueRow<T extends SubIssueRow = SubIssueRow> = {
  row: T;
  id: string;
  depth: number;
  parentId: string | null;
  hasChildren: boolean;
  collapsed: boolean;
};

export type RollupOptions = {
  /** Numeric estimate field. Default `"estimate"`. */
  estimateKey?: string;
  /** Boolean done field. Default `"done"`. */
  doneKey?: string;
};

/** Per-node estimate roll-up produced by {@link rollupEstimates}. */
export type NodeRollup = {
  id: string;
  /** This node's own estimate (missing/non-finite counts as 0). */
  own: number;
  /** Σ `total` over the direct children (their subtrees included). */
  childrenTotal: number;
  /** `own + childrenTotal`. */
  total: number;
  /** Number of done nodes in the subtree (self included). */
  done: number;
  /** Number of nodes in the subtree (self included). */
  count: number;
  /** `done / count` in `0..1`, rounded to 4 decimals; 0 when empty. */
  progress: number;
};

/** Done/total split over a node's descendants (self excluded). */
export type ChildProgress = { done: number; count: number; progress: number };

export type MoveSubIssueOptions = {
  /** Destination parent id; `null`/omitted promotes to the top level. */
  toParentId?: string | null;
  /** Position among the destination's other children; defaults to append. */
  index?: number;
  parentKey?: string;
  orderKey?: string;
  /** Depth cap applied to the moved row's whole subtree. Default `1`. */
  maxDepth?: number;
};

export type MoveCheck =
  | { ok: true }
  | { ok: false; reason: "unknown-id" | "unknown-parent" | "self-parent" | "cycle" | "depth" };

/** A blocking relation: `blockerId` blocks `blockedId` (R89.31 schema). */
export type DependencyEdge = { blockerId: string; blockedId: string };

/** One row's transitive position in the blocking graph (self excluded). */
export type DependencyNode = {
  id: string;
  /** Every direct + indirect blocker, ascending. */
  blockedBy: string[];
  /** Every direct + indirect dependent, ascending. */
  blocks: string[];
};

export type DependencyTree = {
  /** id → its transitive adjacency, keyed ascending. */
  nodes: Map<string, DependencyNode>;
  /** One concrete closed walk per cycle, e.g. `[a, b, a]`. */
  cycles: string[][];
};

/** A node for {@link criticalPath}; `weight` defaults to `1`. */
export type CriticalNode = { id: string; weight?: number };

export type CriticalPathResult =
  | { ok: true; path: string[]; weight: number }
  | { ok: false; cycle: string[] };

const DEFAULT_PARENT_KEY = "parentId";
const DEFAULT_ORDER_KEY = "order";
const DEFAULT_ESTIMATE_KEY = "estimate";
const DEFAULT_DONE_KEY = "done";
const DEFAULT_MAX_DEPTH = 1;
const ORDER_STEP = 1000;

const field = (row: SubIssueRow, key: string): unknown =>
  (row as Record<string, unknown>)[key];

const parentOf = (row: SubIssueRow, key: string): string | null => {
  const value = field(row, key);
  return typeof value === "string" && value.length > 0 ? value : null;
};

const orderOf = (row: SubIssueRow, key: string): number => {
  const value = field(row, key);
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
};

const numberField = (row: SubIssueRow, key: string): number => {
  const value = field(row, key);
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
};

const boolField = (row: SubIssueRow, key: string): boolean => field(row, key) === true;

const round2 = (value: number): number => Math.round(value * 100) / 100;
const round4 = (value: number): number => Math.round(value * 10000) / 10000;

const byString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Copy `row` with extra fields merged in, typed back to the caller's row. */
function withFields<T extends SubIssueRow>(row: T, fields: Record<string, unknown>): T {
  return { ...row, ...fields } as T;
}

function indexById<T extends SubIssueRow>(rows: readonly T[]): Map<string, T> {
  const map = new Map<string, T>();
  for (const row of rows) if (!map.has(row.id)) map.set(row.id, row);
  return map;
}

/** parent id → direct children, each bucket sorted by `order` (stable ties). */
function childrenIndex<T extends SubIssueRow>(
  rows: readonly T[],
  parentKey: string,
  orderKey: string,
): Map<string | null, T[]> {
  const groups = new Map<string | null, T[]>();
  for (const row of rows) {
    const key = parentOf(row, parentKey);
    const bucket = groups.get(key);
    if (bucket) bucket.push(row);
    else groups.set(key, [row]);
  }
  for (const bucket of groups.values()) {
    bucket.sort((a, b) => orderOf(a, orderKey) - orderOf(b, orderKey));
  }
  return groups;
}

/** Parent cycles over the parent field, with the concrete closed paths. */
function findParentCycles<T extends SubIssueRow>(
  rows: readonly T[],
  parentKey: string,
  byId: Map<string, T>,
): { cycles: string[][]; cycleNodes: Set<string> } {
  const cycles: string[][] = [];
  const cycleNodes = new Set<string>();
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
        const cycle = path.slice(at).concat(current);
        cycles.push(cycle);
        for (const id of cycle) cycleNodes.add(id);
        break;
      }
      const row = byId.get(current);
      if (!row) break; // unknown parent terminates the walk
      const parent = parentOf(row, parentKey);
      if (parent === current) {
        cycles.push([current, current]); // self-parent: a one-row cycle
        cycleNodes.add(current);
        break;
      }
      onPath.set(current, path.length);
      path.push(current);
      current = parent;
    }
    for (const id of path) settled.add(id);
  }
  return { cycles, cycleNodes };
}

/**
 * Nest `rows` into a rooted forest. Siblings keep `orderKey` ascending (ties
 * and missing orders keep input order). Rows whose parent chain is broken
 * (unknown parent), that sit deeper than `maxDepth`, or that dangle below a
 * cycle land in `orphans`; each distinct parent cycle — including self-parents
 * — is reported once with a concrete closed path. Never throws, never mutates.
 */
export function buildSubIssueTree<T extends SubIssueRow>(
  rows: readonly T[],
  options: BuildSubIssueTreeOptions = {},
): SubIssueTree<T> {
  const parentKey = options.parentKey ?? DEFAULT_PARENT_KEY;
  const orderKey = options.orderKey ?? DEFAULT_ORDER_KEY;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;

  const byId = indexById(rows);
  const groups = childrenIndex(rows, parentKey, orderKey);
  const { cycles, cycleNodes } = findParentCycles(rows, parentKey, byId);

  const visited = new Set<string>();
  const attach = (row: T, depth: number): SubIssueNode<T> => {
    visited.add(row.id);
    const children: SubIssueNode<T>[] = [];
    if (depth < maxDepth) {
      for (const child of groups.get(row.id) ?? []) {
        if (visited.has(child.id) || cycleNodes.has(child.id)) continue;
        children.push(attach(child, depth + 1));
      }
    }
    return { row, id: row.id, depth, children };
  };

  const roots: T[] = [];
  for (const row of rows) {
    if (visited.has(row.id) || cycleNodes.has(row.id)) continue;
    if (parentOf(row, parentKey) === null) roots.push(row);
  }
  roots.sort((a, b) => orderOf(a, orderKey) - orderOf(b, orderKey));
  const tree = roots.map((root) => attach(root, 0));

  const orphans: T[] = [];
  for (const row of rows) {
    if (visited.has(row.id) || cycleNodes.has(row.id)) continue;
    orphans.push(row);
  }
  return { tree, orphans, cycles };
}

/**
 * The rows a view renders for `tree`: depth-first pre-order, hiding the
 * descendants of every collapsed id (the collapsed row itself stays visible).
 * Each entry carries its `depth`, `parentId` and `hasChildren` flag.
 */
export function flattenTree<T extends SubIssueRow>(
  tree: readonly SubIssueNode<T>[],
  options: FlattenOptions = {},
): FlatSubIssueRow<T>[] {
  const collapsed = new Set<string>(options.collapsedIds ?? []);
  const out: FlatSubIssueRow<T>[] = [];

  const walk = (nodes: readonly SubIssueNode<T>[], parentId: string | null): void => {
    for (const node of nodes) {
      const hasChildren = node.children.length > 0;
      const isCollapsed = collapsed.has(node.id);
      out.push({
        row: node.row,
        id: node.id,
        depth: node.depth,
        parentId,
        hasChildren,
        collapsed: isCollapsed,
      });
      if (hasChildren && !isCollapsed) walk(node.children, node.id);
    }
  };

  walk(tree, null);
  return out;
}

/**
 * Roll estimates and done state up the tree. Returns a map keyed by row id
 * with, per node, its own estimate, the summed totals of its children, the
 * combined total, the done/total node counts and the `0..1` progress fraction.
 * Missing/non-finite estimates count as 0; sums are rounded to 2 decimals.
 */
export function rollupEstimates<T extends SubIssueRow>(
  tree: readonly SubIssueNode<T>[],
  options: RollupOptions = {},
): Map<string, NodeRollup> {
  const estimateKey = options.estimateKey ?? DEFAULT_ESTIMATE_KEY;
  const doneKey = options.doneKey ?? DEFAULT_DONE_KEY;
  const result = new Map<string, NodeRollup>();

  const visit = (node: SubIssueNode<T>): NodeRollup => {
    const own = numberField(node.row, estimateKey);
    let childrenTotal = 0;
    let done = boolField(node.row, doneKey) ? 1 : 0;
    let count = 1;
    for (const child of node.children) {
      const childRollup = visit(child);
      childrenTotal += childRollup.total;
      done += childRollup.done;
      count += childRollup.count;
    }
    const rollup: NodeRollup = {
      id: node.id,
      own: round2(own),
      childrenTotal: round2(childrenTotal),
      total: round2(own + childrenTotal),
      done,
      count,
      progress: count === 0 ? 0 : round4(done / count),
    };
    result.set(node.id, rollup);
    return rollup;
  };

  for (const root of tree) visit(root);
  return result;
}

/**
 * Progress of a node's descendants only (the node itself excluded), so a leaf
 * always reports `{ done: 0, count: 0, progress: 0 }` even when it is done.
 */
export function childProgress<T extends SubIssueRow>(
  node: SubIssueNode<T>,
  options: RollupOptions = {},
): ChildProgress {
  const doneKey = options.doneKey ?? DEFAULT_DONE_KEY;
  let done = 0;
  let count = 0;

  const walk = (nodes: readonly SubIssueNode<T>[]): void => {
    for (const child of nodes) {
      count += 1;
      if (boolField(child.row, doneKey)) done += 1;
      walk(child.children);
    }
  };

  walk(node.children);
  return { done, count, progress: count === 0 ? 0 : round4(done / count) };
}

/** Depth of `id` (roots = 0), or `-1` when the chain is broken or cyclic. */
function depthOf<T extends SubIssueRow>(
  id: string,
  parentKey: string,
  byId: Map<string, T>,
): number {
  const start = byId.get(id);
  if (!start) return -1;
  const seen = new Set<string>([id]);
  let depth = 0;
  let current = parentOf(start, parentKey);
  while (current !== null) {
    if (seen.has(current)) return -1;
    seen.add(current);
    const parent = byId.get(current);
    if (!parent) return -1;
    depth += 1;
    current = parentOf(parent, parentKey);
  }
  return depth;
}

/** Deepest descendant depth of `id` relative to it (a leaf is 0). */
function subtreeHeight(groups: ReadonlyMap<string | null, readonly SubIssueRow[]>, id: string): number {
  let max = 0;
  const seen = new Set<string>([id]);
  const stack: Array<{ id: string; depth: number }> = [{ id, depth: 0 }];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.depth > max) max = node.depth;
    for (const child of groups.get(node.id) ?? []) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      stack.push({ id: child.id, depth: node.depth + 1 });
    }
  }
  return max;
}

/**
 * Whether `moveSubIssue(rows, id, options)` would be accepted. Rejects unknown
 * ids, unknown target parents, self-parenting, moves that would close a cycle
 * (the target is inside the moved subtree) and moves whose subtree would bust
 * `maxDepth`. `toParentId: null` promotes to the top level.
 */
export function canMoveSubIssue<T extends SubIssueRow>(
  rows: readonly T[],
  id: string,
  options: MoveSubIssueOptions = {},
): MoveCheck {
  const parentKey = options.parentKey ?? DEFAULT_PARENT_KEY;
  const orderKey = options.orderKey ?? DEFAULT_ORDER_KEY;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const toParentId = options.toParentId ?? null;

  const byId = indexById(rows);
  if (!byId.has(id)) return { ok: false, reason: "unknown-id" };
  if (toParentId !== null) {
    if (!byId.has(toParentId)) return { ok: false, reason: "unknown-parent" };
    if (toParentId === id) return { ok: false, reason: "self-parent" };
  }

  const groups = childrenIndex(rows, parentKey, orderKey);

  // Cycle guard: the destination must not sit inside the moved subtree.
  if (toParentId !== null) {
    const seen = new Set<string>([id]);
    const stack: string[] = [id];
    while (stack.length > 0) {
      const node = stack.pop()!;
      for (const child of groups.get(node) ?? []) {
        if (child.id === toParentId) return { ok: false, reason: "cycle" };
        if (seen.has(child.id)) continue;
        seen.add(child.id);
        stack.push(child.id);
      }
    }
  }

  // Depth cap applies to the whole moved subtree, not just the row.
  let newDepth: number;
  if (toParentId === null) {
    newDepth = 0;
  } else {
    const destinationDepth = depthOf(toParentId, parentKey, byId);
    if (destinationDepth < 0) return { ok: false, reason: "cycle" };
    newDepth = destinationDepth + 1;
  }
  if (newDepth + subtreeHeight(groups, id) > maxDepth) return { ok: false, reason: "depth" };
  return { ok: true };
}

/**
 * Reparent / reorder `id` under `toParentId`, placing it at `index` among the
 * destination's other children (default: append). The affected sibling group
 * is renumbered to 1000/2000/3000… spacing so the position holds. A rejected
 * move (see {@link canMoveSubIssue}) returns the input reference unchanged;
 * accepted moves return a fresh array and never mutate the input.
 */
export function moveSubIssue<T extends SubIssueRow>(
  rows: readonly T[],
  id: string,
  options: MoveSubIssueOptions = {},
): T[] {
  if (!canMoveSubIssue(rows, id, options).ok) return rows as T[];

  const parentKey = options.parentKey ?? DEFAULT_PARENT_KEY;
  const orderKey = options.orderKey ?? DEFAULT_ORDER_KEY;
  const toParentId = options.toParentId ?? null;

  const byId = indexById(rows);
  const moved = byId.get(id)!;
  const groups = childrenIndex(rows, parentKey, orderKey);
  const destination = (groups.get(toParentId) ?? []).filter((row) => row.id !== id);
  const index = Math.max(0, Math.min(options.index ?? destination.length, destination.length));
  const sequence = [...destination.slice(0, index), moved, ...destination.slice(index)];
  const orderById = new Map(sequence.map((row, position) => [row.id, (position + 1) * ORDER_STEP]));

  return rows.map((row) => {
    if (row.id === id) {
      return withFields(row, { [parentKey]: toParentId, [orderKey]: orderById.get(id) });
    }
    const order = orderById.get(row.id);
    return order === undefined ? row : withFields(row, { [orderKey]: order });
  });
}

/**
 * Build the blocked-by / blocks transitive closure from `{ blockerId, blockedId }`
 * edges. Every id touched by an edge is registered (even with no counterpart)
 * and closures are deduped, self-excluded and id-ascending. Cycles — including
 * self-edges — are reported once each as concrete closed paths.
 */
export function dependencyTree(edges: Iterable<DependencyEdge>): DependencyTree {
  const blocks = new Map<string, Set<string>>();
  const blockedBy = new Map<string, Set<string>>();
  const ids = new Set<string>();
  const cycles: string[][] = [];
  const cycleKeys = new Set<string>();

  const setFor = (map: Map<string, Set<string>>, id: string): Set<string> => {
    const existing = map.get(id);
    if (existing) return existing;
    const created = new Set<string>();
    map.set(id, created);
    return created;
  };

  const recordCycle = (cycle: string[]): void => {
    const open = cycle.slice(0, -1);
    let key = "";
    for (let i = 0; i < open.length; i += 1) {
      const rotation = open.slice(i).concat(open.slice(0, i)).join("\u0000");
      if (i === 0 || rotation < key) key = rotation;
    }
    if (cycleKeys.has(key)) return;
    cycleKeys.add(key);
    cycles.push(cycle);
  };

  for (const edge of edges) {
    ids.add(edge.blockerId);
    ids.add(edge.blockedId);
    if (edge.blockerId === edge.blockedId) {
      recordCycle([edge.blockerId, edge.blockedId]);
      continue;
    }
    setFor(blocks, edge.blockerId).add(edge.blockedId);
    setFor(blockedBy, edge.blockedId).add(edge.blockerId);
    setFor(blocks, edge.blockedId);
    setFor(blockedBy, edge.blockerId);
  }

  const sortedIds = [...ids].sort(byString);
  const state = new Map<string, "visiting" | "done">();
  const path: string[] = [];
  const visit = (node: string): void => {
    state.set(node, "visiting");
    path.push(node);
    for (const next of [...(blocks.get(node) ?? [])].sort(byString)) {
      const seen = state.get(next);
      if (seen === "visiting") recordCycle(path.slice(path.indexOf(next)).concat(next));
      else if (seen === undefined) visit(next);
    }
    path.pop();
    state.set(node, "done");
  };
  for (const id of sortedIds) if (!state.has(id)) visit(id);

  const closure = (adjacency: Map<string, Set<string>>, start: string): string[] => {
    const seen = new Set<string>([start]);
    const queue: string[] = [];
    for (const next of adjacency.get(start) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
    for (let head = 0; head < queue.length; head += 1) {
      for (const next of adjacency.get(queue[head]) ?? []) {
        if (seen.has(next)) continue;
        seen.add(next);
        queue.push(next);
      }
    }
    return queue.sort(byString);
  };

  const nodes = new Map<string, DependencyNode>();
  for (const id of sortedIds) {
    nodes.set(id, { id, blockedBy: closure(blockedBy, id), blocks: closure(blocks, id) });
  }
  return { nodes, cycles };
}

/** Depth-first cycle hunt over a `blocks` adjacency, ids ascending. */
function findDirectedCycle(
  dependents: ReadonlyMap<string, ReadonlySet<string>>,
  ids: readonly string[],
): string[] | null {
  const state = new Map<string, "visiting" | "done">();
  const path: string[] = [];
  const visit = (node: string): string[] | null => {
    state.set(node, "visiting");
    path.push(node);
    for (const next of [...(dependents.get(node) ?? [])].sort(byString)) {
      const seen = state.get(next);
      if (seen === "visiting") return path.slice(path.indexOf(next)).concat(next);
      if (seen === "done") continue;
      const cycle = visit(next);
      if (cycle) return cycle;
    }
    path.pop();
    state.set(node, "done");
    return null;
  };
  for (const id of ids) {
    if (state.has(id)) continue;
    const cycle = visit(id);
    if (cycle) return cycle;
  }
  return null;
}

/**
 * The longest weighted path through a DAG, used to lay timelines out. Node
 * `weight` (default `1`) is summed along the path; without weights the result
 * is the longest dependency chain by row count. Ties break toward the smaller
 * id and cyclic graphs fail with a concrete cycle path, so results are stable.
 */
export function criticalPath(
  nodes: Iterable<CriticalNode>,
  edges: Iterable<DependencyEdge>,
): CriticalPathResult {
  const weightById = new Map<string, number>();
  const ids = new Set<string>();
  for (const node of nodes) {
    ids.add(node.id);
    const weight = node.weight;
    weightById.set(node.id, typeof weight === "number" && Number.isFinite(weight) ? weight : 1);
  }

  const dependents = new Map<string, Set<string>>();
  const blockers = new Map<string, Set<string>>();
  const setFor = (map: Map<string, Set<string>>, id: string): Set<string> => {
    const existing = map.get(id);
    if (existing) return existing;
    const created = new Set<string>();
    map.set(id, created);
    return created;
  };

  for (const edge of edges) {
    ids.add(edge.blockerId);
    ids.add(edge.blockedId);
    if (!weightById.has(edge.blockerId)) weightById.set(edge.blockerId, 1);
    if (!weightById.has(edge.blockedId)) weightById.set(edge.blockedId, 1);
    if (edge.blockerId === edge.blockedId) {
      return { ok: false, cycle: [edge.blockerId, edge.blockedId] };
    }
    setFor(dependents, edge.blockerId).add(edge.blockedId);
    setFor(blockers, edge.blockedId).add(edge.blockerId);
    setFor(blockers, edge.blockerId);
    setFor(dependents, edge.blockedId);
  }

  const sortedIds = [...ids].sort(byString);
  const indegree = new Map<string, number>();
  for (const id of sortedIds) indegree.set(id, blockers.get(id)?.size ?? 0);

  // Kahn's algorithm picking the smallest ready id, so the order is stable.
  const ready: string[] = sortedIds.filter((id) => (indegree.get(id) ?? 0) === 0);
  const order: string[] = [];
  let head = 0;
  while (head < ready.length) {
    const node = ready[head];
    head += 1;
    order.push(node);
    for (const dependent of [...(dependents.get(node) ?? [])].sort(byString)) {
      const remaining = (indegree.get(dependent) ?? 0) - 1;
      indegree.set(dependent, remaining);
      if (remaining !== 0) continue;
      let at = ready.length;
      while (at > head && ready[at - 1] > dependent) at -= 1;
      ready.splice(at, 0, dependent);
    }
  }
  if (order.length !== sortedIds.length) {
    return { ok: false, cycle: findDirectedCycle(dependents, sortedIds) ?? [] };
  }

  const distance = new Map<string, number>();
  const previous = new Map<string, string>();
  for (const node of order) {
    const weight = weightById.get(node) ?? 1;
    const nodeBlockers = [...(blockers.get(node) ?? [])].sort(byString);
    if (nodeBlockers.length === 0) {
      distance.set(node, weight);
      continue;
    }
    // Blockers are ascending, so a strict `>` keeps the smaller id on ties.
    let best = Number.NEGATIVE_INFINITY;
    let bestBlocker: string | null = null;
    for (const blocker of nodeBlockers) {
      const score = distance.get(blocker) ?? 0;
      if (score > best) {
        best = score;
        bestBlocker = blocker;
      }
    }
    distance.set(node, weight + best);
    if (bestBlocker !== null) previous.set(node, bestBlocker);
  }

  let end: string | null = null;
  let best = Number.NEGATIVE_INFINITY;
  for (const id of sortedIds) {
    const score = distance.get(id) ?? 0;
    if (score > best) {
      best = score;
      end = id;
    }
  }
  if (end === null) return { ok: true, path: [], weight: 0 };

  const path: string[] = [];
  for (let current: string | null = end; current !== null; current = previous.get(current) ?? null) {
    path.push(current);
  }
  path.reverse();
  return { ok: true, path, weight: best };
}

/** One-line summary of a roll-up, e.g. `"1/2 done (50%), 8 pts"`. */
export function describeRollup(rollup: NodeRollup): string {
  const percent = Math.round(rollup.progress * 100);
  return `${rollup.done}/${rollup.count} done (${percent}%), ${rollup.total} pts`;
}
