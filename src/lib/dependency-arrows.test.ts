import { describe, expect, it } from "vitest";
import {
  computeArrowPath,
  computeEdgeRoutes,
  pickSides,
  routeBackwardEdge,
  type ArrowPath,
  type BarRect,
  type TimelineEdge,
} from "@/lib/dependency-arrows";

/* Pure geometry: bars are `{ id, x, y, width, height }` rectangles in an
   abstract pixel space (x/y is the top-left corner, width/height positive).
   Edges are `{ id, from, to }`, reading "`from` blocks `to`" like
   @/lib/dependencies — so a to-before-from edge is a *backward* arrow that
   must detour around both bars rather than cut through them. */

const bar = (
  id: string,
  x: number,
  y: number,
  width: number,
  height: number,
): BarRect => ({ id, x, y, width, height });

const edge = (id: string, from: string, to: string): TimelineEdge => ({ id, from, to });

/** The full vertex list `start → points… → end`. */
const vertices = (path: ArrowPath) => [path.start, ...path.points, path.end];

/** Every consecutive pair of vertices must share an axis (no diagonals). */
const expectOrthogonal = (path: ArrowPath) => {
  const pts = vertices(path);
  for (let i = 1; i < pts.length; i += 1) {
    const dx = Math.abs(pts[i].x - pts[i - 1].x);
    const dy = Math.abs(pts[i].y - pts[i - 1].y);
    expect(dx === 0 || dy === 0).toBe(true);
  }
};

/** Does any segment enter a bar's interior (boundary touch allowed)? */
const entersInterior = (path: ArrowPath, rect: BarRect): boolean => {
  const pts = vertices(path);
  for (let i = 1; i < pts.length; i += 1) {
    const a = pts[i - 1];
    const b = pts[i];
    if (a.y === b.y) {
      const lo = Math.min(a.x, b.x);
      const hi = Math.max(a.x, b.x);
      if (rect.y < a.y && a.y < rect.y + rect.height && lo < rect.x + rect.width && hi > rect.x) {
        return true;
      }
    } else {
      const lo = Math.min(a.y, b.y);
      const hi = Math.max(a.y, b.y);
      if (rect.x < a.x && a.x < rect.x + rect.width && lo < rect.y + rect.height && hi > rect.y) {
        return true;
      }
    }
  }
  return false;
};

const expectAvoids = (path: ArrowPath, ...rects: BarRect[]) => {
  for (const rect of rects) expect(entersInterior(path, rect)).toBe(false);
};

/** y of the middle (horizontal) run, or the shared y of a straight path. */
const channelY = (path: ArrowPath): number =>
  path.points.length > 0 ? path.points[0].y : path.start.y;

describe("pickSides", () => {
  it("points right → left when the target sits to the right", () => {
    expect(pickSides(bar("a", 0, 0, 50, 20), bar("b", 100, 0, 50, 20))).toEqual({
      source: "right",
      target: "left",
    });
  });

  it("points left → right when the target sits to the left", () => {
    expect(pickSides(bar("a", 100, 0, 50, 20), bar("b", 0, 0, 50, 20))).toEqual({
      source: "left",
      target: "right",
    });
  });

  it("points right → left when the target sits directly below", () => {
    expect(pickSides(bar("a", 0, 0, 50, 20), bar("b", 0, 80, 50, 20))).toEqual({
      source: "right",
      target: "left",
    });
  });

  it("points right → left when the target sits directly above", () => {
    expect(pickSides(bar("a", 0, 80, 50, 20), bar("b", 0, 0, 50, 20))).toEqual({
      source: "right",
      target: "left",
    });
  });

  it("tie-breaks same-row overlap toward the target's centre (right)", () => {
    expect(pickSides(bar("a", 0, 0, 100, 20), bar("b", 10, 0, 100, 20))).toEqual({
      source: "right",
      target: "left",
    });
  });

  it("tie-breaks same-row overlap toward the target's centre (left)", () => {
    expect(pickSides(bar("a", 10, 0, 100, 20), bar("b", 0, 0, 100, 20))).toEqual({
      source: "left",
      target: "right",
    });
  });
});

describe("computeArrowPath", () => {
  it("draws a straight line between same-row bars with no elbows", () => {
    const path = computeArrowPath(bar("a", 0, 0, 50, 20), bar("b", 100, 0, 50, 20));
    expect(path.start).toEqual({ x: 50, y: 10 });
    expect(path.end).toEqual({ x: 100, y: 10 });
    expect(path.points).toEqual([]);
    expect(path.direction).toBe("right");
  });

  it("elbows orthogonally through the gap when rows differ", () => {
    const a = bar("a", 0, 0, 50, 20);
    const b = bar("b", 100, 60, 50, 20);
    const path = computeArrowPath(a, b);
    expect(path.start).toEqual({ x: 50, y: 10 });
    expect(path.end).toEqual({ x: 100, y: 70 });
    expect(path.points).toHaveLength(2);
    expect(path.points[0]).toEqual({ x: 50, y: 40 });
    expect(path.points[1]).toEqual({ x: 100, y: 40 });
    expectOrthogonal(path);
    expectAvoids(path, a, b);
  });

  it("routes a directly-below target with an orthogonal Z", () => {
    const a = bar("a", 0, 0, 50, 20);
    const b = bar("b", 0, 80, 50, 20);
    const path = computeArrowPath(a, b);
    expect(path.start).toEqual({ x: 50, y: 10 });
    expect(path.end).toEqual({ x: 0, y: 90 });
    expect(path.direction).toBe("right");
    expectOrthogonal(path);
    expectAvoids(path, a, b);
  });

  it("routes a directly-above target with an orthogonal Z", () => {
    const a = bar("a", 0, 80, 50, 20);
    const b = bar("b", 0, 0, 50, 20);
    const path = computeArrowPath(a, b);
    expect(path.start).toEqual({ x: 50, y: 90 });
    expect(path.end).toEqual({ x: 0, y: 10 });
    expectOrthogonal(path);
    expectAvoids(path, a, b);
  });

  it("is deterministic for identical inputs", () => {
    const a = bar("a", 0, 0, 50, 20);
    const b = bar("b", 100, 60, 50, 20);
    expect(computeArrowPath(a, b)).toEqual(computeArrowPath(a, b));
  });

  it("shifts the elbow channel by the requested vertical offset", () => {
    const a = bar("a", 0, 0, 50, 20);
    const b = bar("b", 100, 60, 50, 20);
    const base = computeArrowPath(a, b);
    const shifted = computeArrowPath(a, b, { offset: 20 });
    expect(channelY(shifted) - channelY(base)).toBe(20);
    expectOrthogonal(shifted);
    expectAvoids(shifted, a, b);
  });
});

describe("routeBackwardEdge", () => {
  it("detours below both bars for a to-before-from edge", () => {
    const a = bar("a", 200, 0, 50, 20);
    const b = bar("b", 0, 0, 50, 20);
    const path = routeBackwardEdge(a, b);
    expect(path.start).toEqual({ x: 200, y: 10 });
    expect(path.end).toEqual({ x: 50, y: 10 });
    expect(path.direction).toBe("left");
    const lowest = Math.max(...vertices(path).map((p) => p.y));
    expect(lowest).toBeGreaterThan(a.y + a.height);
    expectOrthogonal(path);
    expectAvoids(path, a, b);
  });

  it("detours above both bars when asked", () => {
    const a = bar("a", 200, 100, 50, 20);
    const b = bar("b", 0, 100, 50, 20);
    const path = routeBackwardEdge(a, b, { detour: "above" });
    const highest = Math.min(...vertices(path).map((p) => p.y));
    expect(highest).toBeLessThan(a.y);
    expectOrthogonal(path);
    expectAvoids(path, a, b);
  });

  it("is used automatically for a backward computeArrowPath", () => {
    const a = bar("a", 200, 0, 50, 20);
    const b = bar("b", 0, 0, 50, 20);
    const path = computeArrowPath(a, b);
    const lowest = Math.max(...vertices(path).map((p) => p.y));
    expect(lowest).toBeGreaterThan(a.y + a.height);
    expectAvoids(path, a, b);
  });
});

describe("computeEdgeRoutes", () => {
  const bars = [bar("a", 0, 0, 50, 20), bar("b", 100, 60, 50, 20)];

  it("returns nothing for empty inputs", () => {
    expect(computeEdgeRoutes([], [])).toEqual([]);
  });

  it("skips edges whose endpoints have no bar", () => {
    expect(computeEdgeRoutes(bars, [edge("e1", "a", "missing")])).toEqual([]);
  });

  it("produces one labelled, orthogonal route per edge", () => {
    const routes = computeEdgeRoutes(bars, [edge("e1", "a", "b")]);
    expect(routes).toHaveLength(1);
    expect(routes[0].edgeId).toBe("e1");
    expect(Number.isFinite(routes[0].labelPos.x)).toBe(true);
    expect(Number.isFinite(routes[0].labelPos.y)).toBe(true);
    expectOrthogonal(routes[0].path);
  });

  it("offsets parallel edges so their channels do not overlap", () => {
    const routes = computeEdgeRoutes(bars, [edge("e1", "a", "b"), edge("e2", "a", "b")]);
    expect(routes).toHaveLength(2);
    expect(channelY(routes[0].path)).not.toBe(channelY(routes[1].path));
    expect(routes[0].labelPos).not.toEqual(routes[1].labelPos);
    expect(routes[0].path).not.toEqual(routes[1].path);
    expectAvoids(routes[0].path, ...bars);
    expectAvoids(routes[1].path, ...bars);
  });

  it("is deterministic across calls", () => {
    const edges = [edge("e1", "a", "b"), edge("e2", "a", "b")];
    expect(computeEdgeRoutes(bars, edges)).toEqual(computeEdgeRoutes(bars, edges));
  });
});
