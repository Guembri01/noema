import { describe, expect, it } from "vitest";
import {
  blockersOf,
  buildDependencyGraph,
  criticalPath,
  dependentsOf,
  edgesFromRelations,
  findCycle,
  isBlocked,
  topoSort,
  transitiveBlockers,
  transitiveDependents,
  validateDependencies,
  wouldCreateCycle,
  type DependencyEdge,
} from "./dependencies";
import { isClosed, RELATION_TYPES } from "./tickets";

/** `{ from, to }` reads "`from` blocks `to`". */
const edge = (from: string, to: string): DependencyEdge => ({ from, to });

const graphOf = (...edges: DependencyEdge[]) => buildDependencyGraph(edges);

/** A cycle must be a real path: first id repeated last, every hop an edge. */
const expectRealCycle = (
  path: string[] | null,
  edges: DependencyEdge[],
  minEdges: number,
) => {
  expect(path).not.toBeNull();
  if (!path) return;
  expect(path.length).toBeGreaterThanOrEqual(minEdges + 1);
  expect(path[0]).toBe(path[path.length - 1]);
  for (let i = 0; i < path.length - 1; i += 1) {
    expect(edges.some((candidate) => candidate.from === path[i] && candidate.to === path[i + 1])).toBe(
      true,
    );
  }
};

const chain = graphOf(edge("a", "b"), edge("b", "c"), edge("c", "d"));
const diamond = graphOf(edge("a", "b"), edge("a", "c"), edge("b", "d"), edge("c", "d"));

describe("buildDependencyGraph", () => {
  it("indexes blockers and dependents for O(1) lookups", () => {
    expect(diamond.dependents.get("a")?.has("b")).toBe(true);
    expect(diamond.dependents.get("a")?.has("d")).toBe(false);
    expect(diamond.blockers.get("d")?.has("b")).toBe(true);
    // Endpoints of an edge are registered in both maps even for an empty direction.
    expect(diamond.blockers.get("a")).toEqual(new Set());
    expect(diamond.dependents.get("d")).toEqual(new Set());
  });

  it("returns direct adjacency sorted, regardless of insertion order", () => {
    const g = graphOf(edge("c", "a"), edge("b", "a"), edge("a", "b"), edge("a", "b"));
    expect(blockersOf(g, "a")).toEqual(["b", "c"]);
    expect(dependentsOf(g, "a")).toEqual(["b"]);
    // b is blocked by a (a → b) and itself blocks a (b → a).
    expect(blockersOf(g, "b")).toEqual(["a"]);
    expect(dependentsOf(g, "b")).toEqual(["a"]);
  });

  it("answers [] for rows with no edges at all", () => {
    expect(blockersOf(chain, "a")).toEqual([]);
    expect(dependentsOf(chain, "d")).toEqual([]);
    expect(blockersOf(chain, "missing")).toEqual([]);
    expect(dependentsOf(chain, "missing")).toEqual([]);
  });

  it("drops self-edges (they are rejected by validation)", () => {
    const g = graphOf(edge("a", "a"));
    expect(g.dependents.get("a")).toBeUndefined();
    expect(blockersOf(g, "a")).toEqual([]);
    expect(dependentsOf(g, "a")).toEqual([]);
  });
});

describe("blockers and dependents", () => {
  it("reports direct blockers and dependents", () => {
    expect(blockersOf(chain, "c")).toEqual(["b"]);
    expect(dependentsOf(chain, "b")).toEqual(["c"]);
    expect(blockersOf(diamond, "d")).toEqual(["b", "c"]);
    expect(dependentsOf(diamond, "a")).toEqual(["b", "c"]);
  });

  it("collects all transitive blockers, deduped", () => {
    expect(transitiveBlockers(chain, "d")).toEqual(["a", "b", "c"]);
    // "a" reaches "d" twice in a diamond but must be reported once.
    expect(transitiveBlockers(diamond, "d")).toEqual(["a", "b", "c"]);
    expect(transitiveBlockers(chain, "a")).toEqual([]);
  });

  it("collects all transitive dependents, deduped", () => {
    expect(transitiveDependents(chain, "a")).toEqual(["b", "c", "d"]);
    expect(transitiveDependents(diamond, "a")).toEqual(["b", "c", "d"]);
    expect(transitiveDependents(chain, "d")).toEqual([]);
  });

  it("never includes the starting row, even when a cycle passes through it", () => {
    const cyclic = graphOf(edge("a", "b"), edge("b", "a"));
    expect(transitiveBlockers(cyclic, "a")).toEqual(["b"]);
    expect(transitiveDependents(cyclic, "a")).toEqual(["b"]);
  });
});

describe("isBlocked", () => {
  const g = graphOf(edge("a", "b"), edge("c", "b"));

  it("is true while any direct blocker is not done", () => {
    expect(isBlocked(g, "b", () => false)).toBe(true);
    expect(isBlocked(g, "b", (id) => id === "a")).toBe(true);
    expect(isBlocked(g, "b", (id) => id === "c")).toBe(true);
  });

  it("is false once every blocker is done", () => {
    expect(isBlocked(g, "b", () => true)).toBe(false);
    expect(isBlocked(g, "b", (id) => id === "a" || id === "c")).toBe(false);
  });

  it("is false when the row has no blockers", () => {
    expect(isBlocked(g, "a", () => false)).toBe(false);
    expect(isBlocked(chain, "a", () => false)).toBe(false);
  });

  it("works with the ticket model's done statuses", () => {
    const status: Record<string, string> = { a: "done", c: "cancelled" };
    const isDone = (id: string) => isClosed(status[id] ?? "todo");
    expect(isBlocked(g, "b", isDone)).toBe(false);
    status.c = "in_progress";
    expect(isBlocked(g, "b", isDone)).toBe(true);
    status.c = "done";
    expect(isBlocked(g, "b", isDone)).toBe(false);
  });
});

describe("self-edges", () => {
  it("are rejected by wouldCreateCycle", () => {
    expect(wouldCreateCycle([], edge("a", "a"))).toBe(true);
    expect(wouldCreateCycle([edge("a", "b")], edge("a", "a"))).toBe(true);
  });

  it("are reported by validateDependencies", () => {
    expect(validateDependencies([edge("a", "a"), edge("a", "b")], ["a", "b"])).toEqual([
      { type: "self_edge", edge: edge("a", "a") },
    ]);
  });
});

describe("findCycle", () => {
  it("returns null for acyclic graphs", () => {
    expect(findCycle(chain)).toBeNull();
    expect(findCycle(diamond)).toBeNull();
    expect(findCycle(buildDependencyGraph([]))).toBeNull();
  });

  it("detects a 2-cycle with a concrete path", () => {
    const edges = [edge("a", "b"), edge("b", "a")];
    const cycle = findCycle(buildDependencyGraph(edges));
    expect(cycle).toEqual(["a", "b", "a"]);
    expectRealCycle(cycle, edges, 2);
  });

  it("detects a 3-cycle with a concrete path", () => {
    const edges = [edge("a", "b"), edge("b", "c"), edge("c", "a")];
    const cycle = findCycle(buildDependencyGraph(edges));
    expect(cycle).toEqual(["a", "b", "c", "a"]);
    expectRealCycle(cycle, edges, 3);
  });

  it("finds a cycle hidden inside a larger graph", () => {
    const edges = [edge("x", "a"), edge("a", "b"), edge("b", "a")];
    const cycle = findCycle(buildDependencyGraph(edges));
    expectRealCycle(cycle, edges, 2);
  });
});

describe("wouldCreateCycle", () => {
  it("rejects an edge that closes a loop", () => {
    expect(wouldCreateCycle([edge("a", "b")], edge("b", "a"))).toBe(true);
    expect(wouldCreateCycle([edge("a", "b"), edge("b", "c")], edge("c", "a"))).toBe(true);
    // Transitive shortcut back to the top also closes a loop.
    expect(wouldCreateCycle([edge("a", "b"), edge("b", "c")], edge("c", "b"))).toBe(true);
  });

  it("accepts edges that do not close a loop", () => {
    expect(wouldCreateCycle([], edge("a", "b"))).toBe(false);
    expect(wouldCreateCycle([edge("a", "b")], edge("b", "c"))).toBe(false);
    expect(wouldCreateCycle([edge("a", "b")], edge("c", "d"))).toBe(false);
    // Shortcuts along an existing chain are acyclic.
    expect(wouldCreateCycle([edge("a", "b"), edge("b", "c")], edge("a", "c"))).toBe(false);
    // Re-adding an edge already in the graph does not create a new cycle.
    expect(wouldCreateCycle([edge("a", "b")], edge("a", "b"))).toBe(false);
  });
});

describe("topoSort", () => {
  it("returns blockers before blocked rows with a stable id tiebreak", () => {
    expect(topoSort(diamond)).toEqual({ ok: true, order: ["a", "b", "c", "d"] });
    expect(topoSort(graphOf(edge("z", "a"), edge("m", "b"), edge("a", "b")))).toEqual({
      ok: true,
      order: ["m", "z", "a", "b"],
    });
  });

  it("orders every edge from blocker to blocked", () => {
    const edges = [edge("z", "a"), edge("m", "b"), edge("a", "b"), edge("b", "y")];
    const result = topoSort(graphOf(...edges));
    if (!result.ok) throw new Error("expected a topological order");
    expect(result.order.length).toBe(5);
    const position = new Map(result.order.map((id, index) => [id, index]));
    for (const candidate of edges) {
      expect(position.has(candidate.from)).toBe(true);
      expect(position.has(candidate.to)).toBe(true);
      expect((position.get(candidate.from) ?? -1) < (position.get(candidate.to) ?? -1)).toBe(true);
    }
  });

  it("is deterministic regardless of edge insertion order", () => {
    const forward = topoSort(graphOf(edge("a", "b"), edge("a", "c"), edge("b", "d"), edge("c", "d")));
    const backward = topoSort(graphOf(edge("c", "d"), edge("b", "d"), edge("a", "c"), edge("a", "b")));
    expect(forward).toEqual(backward);
  });

  it("fails with a concrete cycle when one exists", () => {
    expect(topoSort(graphOf(edge("a", "b"), edge("b", "a")))).toEqual({
      ok: false,
      cycle: ["a", "b", "a"],
    });
    expect(topoSort(graphOf(edge("a", "b"), edge("b", "c"), edge("c", "a")))).toEqual({
      ok: false,
      cycle: ["a", "b", "c", "a"],
    });
  });
});

describe("criticalPath", () => {
  it("finds the longest chain by hops in a linear graph", () => {
    expect(criticalPath(chain)).toEqual({ ok: true, path: ["a", "b", "c", "d"], weight: 3 });
  });

  it("breaks diamond ties toward the smaller id", () => {
    expect(criticalPath(diamond)).toEqual({ ok: true, path: ["a", "b", "d"], weight: 2 });
  });

  it("follows durations instead of hop counts when given a duration fn", () => {
    const g = graphOf(edge("a", "b"), edge("b", "c"), edge("a", "d"));
    // Unweighted: a → b → c wins on hops (2 vs 1).
    expect(criticalPath(g)).toEqual({ ok: true, path: ["a", "b", "c"], weight: 2 });
    const durations: Record<string, number> = { a: 1, b: 1, c: 1, d: 100 };
    // Weighted: the short a → d branch is 101 vs 3.
    expect(criticalPath(g, (id) => durations[id] ?? 0)).toEqual({
      ok: true,
      path: ["a", "d"],
      weight: 101,
    });
  });

  it("sums durations along the chain", () => {
    const g = graphOf(edge("a", "b"), edge("a", "c"), edge("b", "d"), edge("c", "d"));
    const durations: Record<string, number> = { a: 1, b: 5, c: 2, d: 1 };
    expect(criticalPath(g, (id) => durations[id] ?? 0)).toEqual({
      ok: true,
      path: ["a", "b", "d"],
      weight: 7,
    });
  });

  it("fails on cyclic graphs", () => {
    expect(criticalPath(graphOf(edge("a", "b"), edge("b", "a")))).toEqual({
      ok: false,
      cycle: ["a", "b", "a"],
    });
  });

  it("returns an empty path for an empty graph", () => {
    expect(criticalPath(buildDependencyGraph([]))).toEqual({ ok: true, path: [], weight: 0 });
  });
});

describe("validateDependencies", () => {
  it("accepts a clean batch", () => {
    expect(validateDependencies([edge("a", "b"), edge("b", "c")], ["a", "b", "c"])).toEqual([]);
    // Without known ids there is nothing to check dangling ends against.
    expect(validateDependencies([edge("a", "b")])).toEqual([]);
  });

  it("reports self-edges, dangling ids and cycles in one pass", () => {
    const edges = [edge("a", "a"), edge("ghost", "b"), edge("a", "b"), edge("b", "a")];
    const problems = validateDependencies(edges, ["a", "b"]);
    expect(problems.map((problem) => problem.type)).toEqual(["self_edge", "dangling", "cycle"]);
    expect(problems[0]).toEqual({ type: "self_edge", edge: edge("a", "a") });
    expect(problems[1]).toEqual({ type: "dangling", edge: edge("ghost", "b"), id: "ghost" });
    const cycleProblem = problems[2];
    expect(cycleProblem.type).toBe("cycle");
    if (cycleProblem.type === "cycle") expectRealCycle(cycleProblem.cycle, edges, 2);
  });

  it("reports both ends when both ids are dangling", () => {
    const problems = validateDependencies([edge("x", "y")], ["a"]);
    expect(problems.map((problem) => problem.type)).toEqual(["dangling", "dangling"]);
    expect(problems.map((problem) => (problem.type === "dangling" ? problem.id : ""))).toEqual([
      "x",
      "y",
    ]);
  });
});

describe("edgesFromRelations", () => {
  it("maps ticket relations onto blocking edges", () => {
    expect(
      edgesFromRelations([
        { fromId: "a", toId: "b", type: "blocks" },
        { fromId: "c", toId: "d", type: "blocked_by" },
        { fromId: "e", toId: "f", type: "relates" },
        { fromId: "g", toId: "h", type: "duplicates" },
      ]),
    ).toEqual([edge("a", "b"), edge("d", "c")]);
  });

  it("covers every relation type the ticket model defines", () => {
    for (const relation of RELATION_TYPES) {
      const edges = edgesFromRelations([{ fromId: "a", toId: "b", type: relation.id }]);
      if (relation.id === "blocks") expect(edges).toEqual([edge("a", "b")]);
      else if (relation.id === "blocked_by") expect(edges).toEqual([edge("b", "a")]);
      else expect(edges).toEqual([]);
    }
  });
});
