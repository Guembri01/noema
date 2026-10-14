/**
 * Dependencies between rows: the blocking / blocked-by graph behind the
 * "Dependencies" database feature (docs/MISSING_FEATURES.md §3) and the
 * timeline (§20 planning). Pure functions only — no DB, no React.
 *
 * Edge direction: `DependencyEdge = { from, to }` reads **"`from` blocks `to`"**,
 * matching the schema's `TicketRelation` rows (`fromId`/`toId`/`type`) where
 * `type: "blocks"` already points from blocker to blocked, and `blocked_by` is
 * simply inverted on the way in (see `edgesFromRelations`).
 *
 * All traversal is O(V + E); adjacency lookups through the returned graph are
 * O(1). Cycles are invalid state: `findCycle` surfaces a concrete path,
 * `wouldCreateCycle` lets an edge be rejected before it is stored, and
 * `topoSort` / `criticalPath` return typed failures instead of looping.
 */

/** A single blocking relation: `from` blocks `to`. */
export type DependencyEdge = { from: string; to: string };

/**
 * Adjacency for both directions. Every row touched by an edge is registered
 * in *both* maps (possibly with an empty set), so lookups never miss a row
 * that is merely a blocker or merely a dependent.
 */
export type DependencyGraph = {
  /** id → ids that directly block it. */
  blockers: ReadonlyMap<string, ReadonlySet<string>>;
  /** id → ids it directly blocks. */
  dependents: ReadonlyMap<string, ReadonlySet<string>>;
};

export type TopoSortResult =
  | { ok: true; order: string[] }
  | { ok: false; cycle: string[] };

export type CriticalPathResult =
  | { ok: true; path: string[]; weight: number }
  | { ok: false; cycle: string[] };

export type DependencyProblem =
  | { type: "self_edge"; edge: DependencyEdge }
  | { type: "dangling"; edge: DependencyEdge; id: string }
  | { type: "cycle"; cycle: string[] };

const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Every row in the graph, ascending — the deterministic iteration order. */
function allNodes(graph: DependencyGraph): string[] {
  const ids = new Set(graph.blockers.keys());
  for (const id of graph.dependents.keys()) ids.add(id);
  return [...ids].sort(byId);
}

/**
 * Build both adjacency maps from a batch of edges. Duplicate edges collapse
 * into the sets; self-edges are skipped (they are invalid — report them with
 * `validateDependencies`).
 */
export function buildDependencyGraph(edges: Iterable<DependencyEdge>): DependencyGraph {
  const blockers = new Map<string, Set<string>>();
  const dependents = new Map<string, Set<string>>();
  const setFor = (map: Map<string, Set<string>>, id: string): Set<string> => {
    const existing = map.get(id);
    if (existing) return existing;
    const created = new Set<string>();
    map.set(id, created);
    return created;
  };
  for (const edge of edges) {
    if (edge.from === edge.to) continue;
    setFor(dependents, edge.from).add(edge.to);
    setFor(blockers, edge.to).add(edge.from);
    // Register both endpoints in both maps so lookups stay O(1) and complete.
    setFor(blockers, edge.from);
    setFor(dependents, edge.to);
  }
  return { blockers, dependents };
}

/** Ids that directly block `id`, ascending. */
export function blockersOf(graph: DependencyGraph, id: string): string[] {
  return [...(graph.blockers.get(id) ?? [])].sort(byId);
}

/** Ids that `id` directly blocks, ascending. */
export function dependentsOf(graph: DependencyGraph, id: string): string[] {
  return [...(graph.dependents.get(id) ?? [])].sort(byId);
}

/**
 * Is `id` waiting on work? True while **any direct blocker** is not done.
 * `isDone` is a predicate so callers can answer it from ticket statuses
 * (`isClosed` from `@/lib/tickets`), optimistic updates, or anything else.
 */
export function isBlocked(
  graph: DependencyGraph,
  id: string,
  isDone: (id: string) => boolean,
): boolean {
  return blockersOf(graph, id).some((blocker) => !isDone(blocker));
}

/** BFS in one direction, deduped, never including the starting row. */
function collect(
  graph: DependencyGraph,
  start: string,
  direction: "blockers" | "dependents",
): string[] {
  const direct = (node: string) =>
    direction === "blockers" ? blockersOf(graph, node) : dependentsOf(graph, node);
  const seen = new Set<string>([start]);
  const queue: string[] = [];
  for (const id of direct(start)) {
    seen.add(id);
    queue.push(id);
  }
  for (let head = 0; head < queue.length; head += 1) {
    for (const id of direct(queue[head])) {
      if (seen.has(id)) continue;
      seen.add(id);
      queue.push(id);
    }
  }
  return queue.sort(byId);
}

/** Every upstream blocker (direct and indirect), deduped, ascending. */
export function transitiveBlockers(graph: DependencyGraph, id: string): string[] {
  return collect(graph, id, "blockers");
}

/** Every downstream dependent (direct and indirect), deduped, ascending. */
export function transitiveDependents(graph: DependencyGraph, id: string): string[] {
  return collect(graph, id, "dependents");
}

/**
 * Depth-first cycle hunt following the "blocks" direction. Returns a concrete
 * path with the start id repeated last — `["a", "b", "c", "a"]` — or `null`
 * when the graph is acyclic. Rows and neighbours are visited in ascending id
 * order, so the reported cycle is deterministic.
 */
export function findCycle(graph: DependencyGraph): string[] | null {
  const state = new Map<string, "visiting" | "done">();
  const path: string[] = [];

  const visit = (node: string): string[] | null => {
    state.set(node, "visiting");
    path.push(node);
    for (const next of dependentsOf(graph, node)) {
      const seen = state.get(next);
      if (seen === "visiting") return [...path.slice(path.indexOf(next)), next];
      if (seen === "done") continue;
      const cycle = visit(next);
      if (cycle) return cycle;
    }
    path.pop();
    state.set(node, "done");
    return null;
  };

  for (const node of allNodes(graph)) {
    if (state.has(node)) continue;
    const cycle = visit(node);
    if (cycle) return cycle;
  }
  return null;
}

/** Would storing `newEdge` close a loop? Self-edges always would. */
export function wouldCreateCycle(
  edges: Iterable<DependencyEdge>,
  newEdge: DependencyEdge,
): boolean {
  if (newEdge.from === newEdge.to) return true;
  // `from → to` creates a cycle exactly when `to` can already reach `from`.
  const graph = buildDependencyGraph(edges);
  const seen = new Set<string>([newEdge.to]);
  const queue: string[] = [newEdge.to];
  for (let head = 0; head < queue.length; head += 1) {
    for (const next of dependentsOf(graph, queue[head])) {
      if (next === newEdge.from) return true;
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return false;
}

/**
 * Kahn's algorithm picking the smallest ready id at every step, so the order
 * is a stable, id-tiebroken topological sort. A cyclic graph fails with a
 * concrete cycle path instead of a partial order.
 */
export function topoSort(graph: DependencyGraph): TopoSortResult {
  const nodes = allNodes(graph);
  const indegree = new Map<string, number>();
  for (const node of nodes) indegree.set(node, graph.blockers.get(node)?.size ?? 0);

  // The unprocessed tail ready[head..] stays sorted ascending.
  const ready: string[] = nodes.filter((node) => (indegree.get(node) ?? 0) === 0);
  const order: string[] = [];
  let head = 0;
  while (head < ready.length) {
    const node = ready[head];
    head += 1;
    order.push(node);
    for (const dependent of dependentsOf(graph, node)) {
      const remaining = (indegree.get(dependent) ?? 0) - 1;
      indegree.set(dependent, remaining);
      if (remaining !== 0) continue;
      let at = ready.length;
      while (at > head && ready[at - 1] > dependent) at -= 1;
      ready.splice(at, 0, dependent);
    }
  }
  if (order.length !== nodes.length) return { ok: false, cycle: findCycle(graph) ?? [] };
  return { ok: true, order };
}

/**
 * The longest dependency chain, useful for laying a timeline out.
 *
 * - Without `durationOf`: weight = hops, i.e. `path.length - 1`.
 * - With `durationOf`: weight = Σ `durationOf(id)` over the rows on the path
 *   (should be ≥ 0), e.g. estimated days.
 *
 * Ties break toward the smaller id. Cyclic graphs fail with the cycle.
 */
export function criticalPath(
  graph: DependencyGraph,
  durationOf?: (id: string) => number,
): CriticalPathResult {
  const topo = topoSort(graph);
  if (!topo.ok) return { ok: false, cycle: topo.cycle };

  const distance = new Map<string, number>();
  const previous = new Map<string, string>();
  const gain = durationOf ? 0 : 1;
  for (const node of topo.order) {
    const duration = durationOf ? durationOf(node) : 0;
    const blockers = blockersOf(graph, node);
    if (blockers.length === 0) {
      distance.set(node, duration);
      continue;
    }
    // Blockers are ascending, so a strict `>` keeps the smaller id on ties.
    let best = Number.NEGATIVE_INFINITY;
    let bestBlocker: string | null = null;
    for (const blocker of blockers) {
      const score = (distance.get(blocker) ?? 0) + gain;
      if (score > best) {
        best = score;
        bestBlocker = blocker;
      }
    }
    distance.set(node, duration + best);
    if (bestBlocker !== null) previous.set(node, bestBlocker);
  }

  let end: string | null = null;
  let best = Number.NEGATIVE_INFINITY;
  for (const node of allNodes(graph)) {
    const score = distance.get(node) ?? 0;
    if (score > best) {
      best = score;
      end = node;
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

/**
 * Validate a whole batch at once: self-edges, ids that are not known rows
 * (checked only when `knownIds` is given), and cycles — reported once, as a
 * concrete path. Order is stable: per-edge problems in input order first,
 * then the cycle.
 */
export function validateDependencies(
  edges: Iterable<DependencyEdge>,
  knownIds?: Iterable<string>,
): DependencyProblem[] {
  const list = [...edges];
  const known = knownIds ? new Set(knownIds) : null;
  const problems: DependencyProblem[] = [];
  for (const edge of list) {
    if (edge.from === edge.to) {
      problems.push({ type: "self_edge", edge });
      continue; // already invalid; don't double-report it as dangling too
    }
    if (!known) continue;
    if (!known.has(edge.from)) problems.push({ type: "dangling", edge, id: edge.from });
    if (!known.has(edge.to)) problems.push({ type: "dangling", edge, id: edge.to });
  }
  const cycle = findCycle(buildDependencyGraph(list));
  if (cycle) problems.push({ type: "cycle", cycle });
  return problems;
}

/**
 * `TicketRelation` rows → dependency edges, mirroring the ticket drawer's
 * link types: `blocks` already points blocker → blocked, `blocked_by` is
 * inverted, and `relates` / `duplicates` carry no dependency.
 */
export function edgesFromRelations(
  relations: Iterable<{ fromId: string; toId: string; type: string }>,
): DependencyEdge[] {
  const edges: DependencyEdge[] = [];
  for (const relation of relations) {
    if (relation.type === "blocks") edges.push({ from: relation.fromId, to: relation.toId });
    else if (relation.type === "blocked_by") edges.push({ from: relation.toId, to: relation.fromId });
  }
  return edges;
}
