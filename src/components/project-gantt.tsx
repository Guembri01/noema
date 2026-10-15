"use client";

import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";
import { buildIntervals, maxOverlap } from "@/lib/interval-tree";
import {
  computeEdgeRoutes,
  type BarRect,
  type EdgeRoute,
  type TimelineEdge,
} from "@/lib/dependency-arrows";

export type GanttMilestone = {
  id: string;
  name: string;
  status: string;
  dueDate: string | null;
};

const DAY = 24 * 60 * 60 * 1000;

/**
 * Vertical geometry of the chart, in pixels. Kept beside the Tailwind classes
 * it mirrors (`h-5` project bar, `h-3` milestone rows, `space-y-3` gaps) so the
 * optional SVG overlay can place dependency arrows over the exact same rows.
 */
const PROJECT_ROW_HEIGHT = 20;
const MILESTONE_ROW_HEIGHT = 12;
const ROW_GAP = 12;
/**
 * Vertical start of the first bar lane below the project row, and the pitch of
 * one lane (a bar row plus the gap after it). The derived milestone bars sit on
 * `LANE_TOP + index * LANE_PITCH`, and lane-packed overlay bars reuse the same
 * geometry so both feed the arrow overlay from one coordinate space.
 */
const LANE_TOP = PROJECT_ROW_HEIGHT + ROW_GAP;
const LANE_PITCH = MILESTONE_ROW_HEIGHT + ROW_GAP;
/** Width of a derived milestone bar, as a percentage of the track. */
const MILESTONE_BAR_WIDTH = 2;
/**
 * Horizontal offset of the track column: the `w-32` label (`8rem`) plus the
 * `gap-2` row gap (`0.5rem`). The SVG overlay is inset by this much so its
 * percentage x-axis lines up with the bars, which are laid out in the track.
 */
const TRACK_LEFT = "8.5rem";

function startOfDay(value: Date) {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate());
}

/** An `ArrowPath` rendered as an SVG polyline `d`. */
function routePath(route: EdgeRoute): string {
  const vertices = [route.path.start, ...route.path.points, route.path.end];
  return vertices
    .map((point, index) => `${index === 0 ? "M" : "L"}${point.x} ${point.y}`)
    .join(" ");
}

/**
 * Explicit arrowhead drawn from `ArrowPath.direction` (the side the route meets
 * the target). A marker would skew under the overlay's non-uniform viewBox, and
 * the library already hands us the direction, so we draw the head ourselves.
 */
function arrowHead(route: EdgeRoute): string {
  const { x, y } = route.path.end;
  const ax = 1.1; // horizontal reach, in percentage-of-track units
  const ay = 4; // vertical reach, in pixel units
  const tip = `${x},${y}`;
  switch (route.path.direction) {
    case "right":
      return `${tip} ${x - ax},${y - ay} ${x - ax},${y + ay}`;
    case "left":
      return `${tip} ${x + ax},${y - ay} ${x + ax},${y + ay}`;
    case "down":
      return `${tip} ${x - ax},${y - ay} ${x + ax},${y - ay}`;
    case "up":
      return `${tip} ${x - ax},${y + ay} ${x + ax},${y + ay}`;
    default:
      return tip;
  }
}

/**
 * Greedy interval-graph colouring over the bars' time extents: every bar takes
 * the lowest lane whose previous occupant has already ended, and lane `n` is
 * drawn at `LANE_TOP + n * LANE_PITCH`. Because the extents are half-open, two
 * bars that merely touch may share a lane. `buildIntervals` supplies the stable
 * `(start, end)`-ordered walk the greedy pass needs and `maxOverlap` the lane
 * count the busiest instant forces, so the overlay can size itself to the
 * packed stack. Inputs are never mutated and bars are returned in time order.
 */
export function packBars(bars: readonly BarRect[]): { bars: BarRect[]; laneCount: number } {
  const entries = buildIntervals(bars, {
    startOf: (bar) => bar.x,
    endOf: (bar) => bar.x + bar.width,
  });
  const laneEnds: number[] = [];
  const packed = entries.map((entry) => {
    let lane = laneEnds.findIndex((end) => end <= entry.start);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(entry.end);
    } else {
      laneEnds[lane] = entry.end;
    }
    return { ...entry.item, y: LANE_TOP + lane * LANE_PITCH };
  });
  return { bars: packed, laneCount: Math.max(maxOverlap(entries), laneEnds.length) };
}

/**
 * Lightweight Gantt: the project spans start → due, milestones are dated
 * markers on the same axis, and "today" is pinned so progress is obvious.
 * Layout is pure and cheap; when callers supply dependency `bars`/`edges` an
 * optional SVG overlay draws the arrows via @/lib/dependency-arrows.
 */
export function ProjectGantt({
  name,
  startDate,
  dueDate,
  milestones,
  locale,
  bars,
  edges,
}: {
  name: string;
  startDate: string | null;
  dueDate: string | null;
  milestones: GanttMilestone[];
  locale: string;
  /** Positioned bars for the arrow overlay; derived from milestones when omitted. */
  bars?: readonly BarRect[];
  /** Dependency edges (`from` blocks `to`); no overlay when omitted/empty. */
  edges?: readonly TimelineEdge[];
}) {
  const dated = milestones.filter((milestone) => milestone.dueDate);
  const today = startOfDay(new Date());

  const points: Date[] = [today];
  if (startDate) points.push(startOfDay(new Date(startDate)));
  if (dueDate) points.push(startOfDay(new Date(dueDate)));
  for (const milestone of dated) points.push(startOfDay(new Date(milestone.dueDate!)));

  const from = new Date(Math.min(...points.map((date) => date.getTime())));
  const to = new Date(Math.max(...points.map((date) => date.getTime())));
  if (to.getTime() === from.getTime()) to.setTime(to.getTime() + 7 * DAY);
  const span = Math.max(to.getTime() - from.getTime(), DAY);

  const pct = (value: string | Date) =>
    Math.min(100, Math.max(0, ((new Date(value).getTime() - from.getTime()) / span) * 100));

  const projectStart = startDate ? pct(startDate) : 0;
  const projectEnd = dueDate ? pct(dueDate) : 100;

  // One derived bar per dated milestone, on its exact row of the chart.
  const derivedBars: BarRect[] = [];
  milestones.forEach((milestone, index) => {
    if (!milestone.dueDate) return;
    const center = pct(milestone.dueDate);
    derivedBars.push({
      id: milestone.id,
      x: Math.max(0, Math.min(100 - MILESTONE_BAR_WIDTH, center - MILESTONE_BAR_WIDTH / 2)),
      y: LANE_TOP + index * LANE_PITCH,
      width: MILESTONE_BAR_WIDTH,
      height: MILESTONE_ROW_HEIGHT,
    });
  });
  const totalHeight = PROJECT_ROW_HEIGHT + milestones.length * LANE_PITCH;
  // Caller-supplied bars may overlap in time; lane-pack them so no two arrows
  // stack on the same row. The derived milestone bars already occupy one lane
  // each, so they are used as-is — packing them would collapse non-overlapping
  // milestones onto one row and detach the arrows from the milestone dots.
  const packed = bars && bars.length > 0 ? packBars(bars) : null;
  const routeBars = packed ? packed.bars : derivedBars;
  const routes = edges && edges.length > 0 ? computeEdgeRoutes(routeBars, edges) : [];
  const overlayHeight = packed
    ? PROJECT_ROW_HEIGHT + packed.laneCount * LANE_PITCH
    : totalHeight;

  return (
    <div className="rounded-xl border border-border p-4">
      <div className="mb-3 flex items-center justify-between">
        <p className="text-sm font-medium">{t(locale, "timelineLabel")}</p>
        <p className="text-[11px] text-muted">
          {from.toLocaleDateString()} → {to.toLocaleDateString()}
        </p>
      </div>

      <div className="relative">
        {/* today marker */}
        <div
          className="absolute -top-1 bottom-0 z-10 border-l border-dashed border-accent"
          style={{ left: `${pct(today)}%` }}
          aria-hidden
        />
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <span className="w-32 shrink-0 truncate text-xs text-muted">{name}</span>
            <div className="relative h-5 flex-1 rounded bg-surface-2">
              <div
                className="absolute inset-y-0 rounded bg-accent/70"
                style={{
                  left: `${Math.min(projectStart, projectEnd)}%`,
                  width: `${Math.max(Math.abs(projectEnd - projectStart), 2)}%`,
                }}
              />
            </div>
          </div>

          {milestones.map((milestone) => {
            const position = milestone.dueDate ? pct(milestone.dueDate) : null;
            return (
              <div key={milestone.id} className="flex items-center gap-2">
                <span
                  className={cn(
                    "w-32 shrink-0 truncate text-xs",
                    milestone.status === "done" ? "text-muted line-through" : "text-muted",
                  )}
                >
                  {milestone.name}
                </span>
                <div className="relative h-3 flex-1">
                  <div className="absolute inset-y-1/2 h-px w-full bg-border" />
                  {position !== null ? (
                    <span
                      title={new Date(milestone.dueDate!).toLocaleDateString()}
                      className={cn(
                        "absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-bg",
                        milestone.status === "done"
                          ? "bg-emerald-500"
                          : milestone.status === "in_progress"
                            ? "bg-accent"
                            : "bg-muted",
                      )}
                      style={{ left: `${position}%` }}
                    />
                  ) : (
                    <span className="absolute right-0 top-1/2 -translate-y-1/2 text-[10px] text-muted">
                      {t(locale, "noDate")}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {routes.length > 0 && (
          <svg
            className="pointer-events-none absolute inset-y-0 right-0 z-20 h-full overflow-visible text-accent"
            style={{ left: TRACK_LEFT }}
            viewBox={`0 0 100 ${overlayHeight}`}
            preserveAspectRatio="none"
            aria-hidden
          >
            {routes.map((route) => (
              <g key={route.edgeId}>
                <path
                  d={routePath(route)}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={1}
                  vectorEffect="non-scaling-stroke"
                />
                <polygon points={arrowHead(route)} fill="currentColor" />
              </g>
            ))}
          </svg>
        )}
      </div>

      <p className="mt-3 text-[11px] text-muted">
        {t(locale, "ganttLegend")}
      </p>
    </div>
  );
}
