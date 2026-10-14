/**
 * Timeline dependency-arrow routing (docs/MISSING_FEATURES.md §3 row
 * "Timeline dependencies"; spec R89.31). Pure geometry — no React, no DOM,
 * no DB — that turns positioned bars plus `DependencyEdge`-shaped edges into
 * orthogonal SVG-style paths a renderer can stroke.
 *
 * Coordinate space is deliberately abstract: a bar is a rectangle
 * `{ id, x, y, width, height }` with `x`/`y` the top-left corner (the shape
 * the timeline/calendar layer hands a renderer), and an edge is
 * `{ id, from, to }` reading "`from` blocks `to`" exactly like
 * @/lib/dependencies. Arrows leave the facing side of the source bar and
 * enter the facing side of the target bar, run **only** along axis-aligned
 * segments, and never cut through the interior of either bar — a backward
 * edge (`to` ends before `from` starts) takes a detour around both bars.
 * Everything is deterministic: the same bars and edges always yield the same
 * routes, and parallel edges are fanned out with stable vertical offsets.
 */

/** A positioned timeline bar: top-left corner plus extent. */
export type BarRect = {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
};

/** Which vertical edge of a bar an arrow attaches to. */
export type Side = "left" | "right";

/** The side pair an arrow uses: leaves `source`, enters `target`. */
export type SidePick = { source: Side; target: Side };

/** A point in the same abstract space as `BarRect`. */
export type Point = { x: number; y: number };

/** Direction the arrowhead points where the path meets the target. */
export type MarkerDirection = "left" | "right" | "up" | "down";

/**
 * An orthogonal arrow. `points` are the elbow vertices strictly between
 * `start` and `end`; consecutive vertices always share an axis, and
 * `points` is empty for a straight run.
 */
export type ArrowPath = {
  start: Point;
  points: Point[];
  end: Point;
  direction: MarkerDirection;
};

/** A dependency edge to draw: `from` blocks `to`. */
export type TimelineEdge = { id: string; from: string; to: string };

/** One routed edge plus the anchor a label should sit on. */
export type EdgeRoute = { edgeId: string; path: ArrowPath; labelPos: Point };

/** Knobs for routing; all optional, all deterministic. */
export type ArrowOptions = {
  /** Clearance held between a run and the bars it detours around. */
  gap?: number;
  /** Extra vertical shift applied to the elbow channel. */
  offset?: number;
  /** Spacing added per parallel edge sharing the same `from → to` pair. */
  offsetStep?: number;
  /** Which side a backward edge detours around. Defaults to `"below"`. */
  detour?: "above" | "below";
};

/** Default clearance between a detour run and the bars it skirts. */
export const DEFAULT_GAP = 12;
/** Default vertical spacing between parallel arrows on the same pair. */
export const DEFAULT_OFFSET_STEP = 16;

const midY = (bar: BarRect): number => bar.y + bar.height / 2;

function assertFinitePoint(point: Point, label: string): void {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    throw new RangeError(`${label} must have finite coordinates, got ${JSON.stringify(point)}`);
  }
}

/** The midpoint of a bar's chosen vertical edge — where an arrow attaches. */
function anchor(bar: BarRect, side: Side): Point {
  return side === "left"
    ? { x: bar.x, y: midY(bar) }
    : { x: bar.x + bar.width, y: midY(bar) };
}

/** `to` finishes before `from` starts: the "backward in time" relation. */
function isBackward(fromBar: BarRect, toBar: BarRect): boolean {
  return toBar.x + toBar.width <= fromBar.x;
}

/**
 * Pick the attachment sides. Arrows always leave and enter a vertical edge:
 * a target to the right uses `right → left`, a target to the left uses
 * `left → right`, and vertical / overlapping placements fall back to the
 * horizontal centres (ties favour `right → left`, so results are stable).
 */
export function pickSides(fromBar: BarRect, toBar: BarRect): SidePick {
  if (toBar.x >= fromBar.x + fromBar.width) return { source: "right", target: "left" };
  if (toBar.x + toBar.width <= fromBar.x) return { source: "left", target: "right" };
  const fromCenter = fromBar.x + fromBar.width / 2;
  const toCenter = toBar.x + toBar.width / 2;
  return toCenter >= fromCenter
    ? { source: "right", target: "left" }
    : { source: "left", target: "right" };
}

/** Marker points into the target: left face → rightward, right face → leftward. */
function markerDirection(target: Side): MarkerDirection {
  return target === "left" ? "right" : "left";
}

/**
 * Collapse coincident vertices and drop collinear midpoints so the result is
 * a minimal polyline. The first and last vertices are preserved.
 */
function simplify(points: Point[]): Point[] {
  const deduped: Point[] = [];
  for (const point of points) {
    const last = deduped[deduped.length - 1];
    if (last && last.x === point.x && last.y === point.y) continue;
    deduped.push(point);
  }
  const cleaned: Point[] = [];
  for (let i = 0; i < deduped.length; i += 1) {
    const prev = deduped[i - 1];
    const curr = deduped[i];
    const next = deduped[i + 1];
    if (prev && next) {
      const collinear =
        (prev.x === curr.x && curr.x === next.x) || (prev.y === curr.y && curr.y === next.y);
      if (collinear) continue;
    }
    cleaned.push(curr);
  }
  return cleaned;
}

/** Turn raw vertices into a tidy `ArrowPath`, validating each coordinate. */
function buildPath(vertices: Point[], direction: MarkerDirection): ArrowPath {
  const cleaned = simplify(vertices);
  const start = cleaned[0];
  const end = cleaned[cleaned.length - 1];
  assertFinitePoint(start, "start");
  assertFinitePoint(end, "end");
  return { start, points: cleaned.slice(1, -1), end, direction };
}

/** Does any axis-aligned segment pierce a bar's interior (boundary is ok)? */
function entersInterior(path: ArrowPath, bar: BarRect): boolean {
  const vertices = [path.start, ...path.points, path.end];
  for (let i = 1; i < vertices.length; i += 1) {
    const a = vertices[i - 1];
    const b = vertices[i];
    if (a.y === b.y) {
      const lo = Math.min(a.x, b.x);
      const hi = Math.max(a.x, b.x);
      if (bar.y < a.y && a.y < bar.y + bar.height && lo < bar.x + bar.width && hi > bar.x) {
        return true;
      }
    } else {
      const lo = Math.min(a.y, b.y);
      const hi = Math.max(a.y, b.y);
      if (bar.x < a.x && a.x < bar.x + bar.width && lo < bar.y + bar.height && hi > bar.y) {
        return true;
      }
    }
  }
  return false;
}

const crossesBars = (path: ArrowPath, bars: BarRect[]): boolean =>
  bars.some((bar) => entersInterior(path, bar));

/** The point halfway along a polyline, measured by arc length. */
function midpointOf(path: ArrowPath): Point {
  const vertices = [path.start, ...path.points, path.end];
  let total = 0;
  for (let i = 1; i < vertices.length; i += 1) {
    total += Math.abs(vertices[i].x - vertices[i - 1].x) + Math.abs(vertices[i].y - vertices[i - 1].y);
  }
  if (total === 0) return { ...path.start };
  let travelled = 0;
  const target = total / 2;
  for (let i = 1; i < vertices.length; i += 1) {
    const a = vertices[i - 1];
    const b = vertices[i];
    const length = Math.abs(b.x - a.x) + Math.abs(b.y - a.y);
    if (travelled + length >= target) {
      const ratio = length === 0 ? 0 : (target - travelled) / length;
      return { x: a.x + (b.x - a.x) * ratio, y: a.y + (b.y - a.y) * ratio };
    }
    travelled += length;
  }
  return { ...path.end };
}

/**
 * Route a to-before-from edge around both bars. The path leaves the source's
 * facing side, runs clear of the union of the two bars, and comes back up
 * into the target — so a backward dependency never overlaps the bars it
 * connects. Defaults to a detour **below**; pass `detour: "above"` to go over.
 */
export function routeBackwardEdge(
  fromBar: BarRect,
  toBar: BarRect,
  opts: ArrowOptions = {},
): ArrowPath {
  const gap = opts.gap ?? DEFAULT_GAP;
  const offset = opts.offset ?? 0;
  const below = (opts.detour ?? "below") === "below";
  const { source, target } = pickSides(fromBar, toBar);
  const start = anchor(fromBar, source);
  const end = anchor(toBar, target);
  const bottom = Math.max(fromBar.y + fromBar.height, toBar.y + toBar.height);
  const top = Math.min(fromBar.y, toBar.y);
  const channel = below ? bottom + gap + offset : top - gap - offset;
  return buildPath(
    [start, { x: start.x, y: channel }, { x: end.x, y: channel }, end],
    markerDirection(target),
  );
}

/**
 * Compute one orthogonal arrow. Forward arrows elbow through the vertical
 * gap between the bars (a straight run when they share a row); a backward
 * edge or any candidate that would pierce a bar falls back to
 * `routeBackwardEdge`. `opts.offset` shifts the elbow channel so parallel
 * arrows stack instead of overlapping.
 */
export function computeArrowPath(
  fromBar: BarRect,
  toBar: BarRect,
  opts: ArrowOptions = {},
): ArrowPath {
  const offset = opts.offset ?? 0;
  const { source, target } = pickSides(fromBar, toBar);
  const direction = markerDirection(target);

  if (isBackward(fromBar, toBar)) return routeBackwardEdge(fromBar, toBar, opts);

  const start = anchor(fromBar, source);
  const end = anchor(toBar, target);
  const channel = (start.y + end.y) / 2 + offset;
  const straight = start.y === end.y && offset === 0;
  const candidate = buildPath(
    straight ? [start, end] : [start, { x: start.x, y: channel }, { x: end.x, y: channel }, end],
    direction,
  );
  return crossesBars(candidate, [fromBar, toBar])
    ? routeBackwardEdge(fromBar, toBar, opts)
    : candidate;
}

/**
 * Route every edge against a set of bars. Edges whose endpoints are missing
 * from `bars` are skipped (there is nothing to attach to). Edges that share
 * the same `from → to` pair are treated as parallel and fanned out with
 * `offsetStep` vertical spacing, so their channels stay distinct. Output
 * order matches input order.
 */
export function computeEdgeRoutes(
  bars: readonly BarRect[],
  edges: readonly TimelineEdge[],
  opts: ArrowOptions = {},
): EdgeRoute[] {
  const byId = new Map(bars.map((bar) => [bar.id, bar]));
  const parallelCount = new Map<string, number>();
  const step = opts.offsetStep ?? DEFAULT_OFFSET_STEP;
  const routes: EdgeRoute[] = [];
  for (const edge of edges) {
    const fromBar = byId.get(edge.from);
    const toBar = byId.get(edge.to);
    if (!fromBar || !toBar) continue;
    const key = `${edge.from}\u0000${edge.to}`;
    const index = parallelCount.get(key) ?? 0;
    parallelCount.set(key, index + 1);
    const path = computeArrowPath(fromBar, toBar, { ...opts, offset: (opts.offset ?? 0) + index * step });
    routes.push({ edgeId: edge.id, path, labelPos: midpointOf(path) });
  }
  return routes;
}
