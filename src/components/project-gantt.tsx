"use client";

import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";
import { Z } from "@/lib/design-tokens";
import { Tooltip } from "@/components/ui/tooltip";
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
export const PROJECT_ROW_HEIGHT = 20;
export const MILESTONE_ROW_HEIGHT = 12;
export const ROW_GAP = 12;
/**
 * Vertical start of the first bar lane below the project row, and the pitch of
 * one lane (a bar row plus the gap after it). The derived milestone bars sit on
 * `LANE_TOP + index * LANE_PITCH`, and lane-packed overlay bars reuse the same
 * geometry so both feed the arrow overlay from one coordinate space.
 */
export const LANE_TOP = PROJECT_ROW_HEIGHT + ROW_GAP;
export const LANE_PITCH = MILESTONE_ROW_HEIGHT + ROW_GAP;
/** Width of a derived milestone bar, as a percentage of the track. */
export const MILESTONE_BAR_WIDTH = 2;
/**
 * Horizontal offset of the track column: the `w-32` label (`8rem`) plus the
 * `gap-2` row gap (`0.5rem`). The SVG overlay is inset by this much so its
 * percentage x-axis lines up with the bars, which are laid out in the track.
 */
const TRACK_LEFT = "8.5rem";

/**
 * Stagger between successively-mounted bars, in ms. This is a *delay*, not a
 * duration — each bar animates with the named `animate-rise` token, so no new
 * duration is invented. The step is capped by
 * {@link GANTT_MAX_STAGGER_STEPS} so a long chart never fades in late, and the
 * global `prefers-reduced-motion` rule zeroes every delay (see globals.css).
 */
export const GANTT_STAGGER_MS = 40;
export const GANTT_MAX_STAGGER_STEPS = 8;

/** Delay for the bar at `index` (`transform`/`opacity` animation only). */
export function ganttStagger(index: number): number {
  const step = Number.isFinite(index) ? Math.trunc(index) : 0;
  return Math.min(Math.max(0, step), GANTT_MAX_STAGGER_STEPS) * GANTT_STAGGER_MS;
}

/** Token fill per milestone status. */
export type GanttTone = "success" | "accent" | "muted";

/** Bar/marker fills — token-only, so light/dark/high-contrast all inherit. */
export const GANTT_TONE_CLASS: Record<GanttTone, string> = {
  success: "bg-success",
  accent: "bg-accent",
  muted: "bg-muted",
};

/** Map a milestone status onto its token tone. Unknown statuses read `muted`. */
export function ganttStatusTone(status: string): GanttTone {
  if (status === "done") return "success";
  if (status === "in_progress") return "accent";
  return "muted";
}

function startOfDay(value: Date) {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate());
}

/** Local-midnight epoch (ms) for a date-ish value, or `null` when unparseable. */
function dayMs(value: string | Date): number | null {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return startOfDay(date).getTime();
}

/** The time window a chart is drawn over, in local-midnight epoch ms. */
export type GanttAxis = { from: number; to: number; span: number };

/**
 * Build the chart axis from every date the chart must contain plus `today`.
 * A single-point range is widened to a week so a bar still has a track, and the
 * span is floored at one day so percentages never explode.
 */
export function buildGanttAxis(
  dates: readonly (string | null | undefined)[],
  now: Date = new Date(),
): GanttAxis {
  const points: number[] = [dayMs(now) ?? 0];
  for (const value of dates) {
    if (!value) continue;
    const ms = dayMs(value);
    if (ms !== null) points.push(ms);
  }
  const from = Math.min(...points);
  let to = Math.max(...points);
  if (to === from) to += 7 * DAY;
  return { from, to, span: Math.max(to - from, DAY) };
}

/** Position of a date along the axis, clamped to `0..100`. */
export function percentAlong(axis: GanttAxis, value: string | Date): number {
  const ms = dayMs(value);
  if (ms === null) return 0;
  return Math.min(100, Math.max(0, ((ms - axis.from) / axis.span) * 100));
}

/** A horizontal bar: `left`% along the track plus `width`%. */
export type GanttSpan = { left: number; width: number };

/**
 * Geometry for a `start → end` bar. A missing `start` pins the bar to the
 * track's left edge and a missing `end` to its right; a zero-length span is
 * widened to the {@link MILESTONE_BAR_WIDTH} minimum so it stays visible.
 */
export function ganttBarGeometry(
  axis: GanttAxis,
  start: string | null | undefined,
  end: string | null | undefined,
): GanttSpan {
  const startPct = start ? percentAlong(axis, start) : 0;
  const endPct = end ? percentAlong(axis, end) : 100;
  const left = Math.min(startPct, endPct);
  const width = Math.max(Math.abs(endPct - startPct), MILESTONE_BAR_WIDTH);
  return { left, width: Math.min(width, Math.max(0, 100 - left)) };
}

/** A milestone's marker: its id, position on the axis and status. */
export type GanttMarker = {
  id: string;
  left: number;
  status: string;
  dueDate: string;
};

/** Position every dated milestone on the axis; undated ones are omitted. */
export function milestoneMarkers(
  axis: GanttAxis,
  milestones: readonly GanttMilestone[],
): GanttMarker[] {
  const out: GanttMarker[] = [];
  for (const milestone of milestones) {
    if (!milestone.dueDate) continue;
    out.push({
      id: milestone.id,
      left: percentAlong(axis, milestone.dueDate),
      status: milestone.status,
      dueDate: milestone.dueDate,
    });
  }
  return out;
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

/** `Mon D` (locale-formatted) for a date-ish value, or `""` when unusable. */
function dayLabel(value: string | null | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString();
}

/**
 * Lightweight Gantt: the project spans start → due, every milestone is a
 * status-toned bar ending in a diamond on the same axis, and "today" is pinned
 * in `--danger` so progress is obvious. Bars mount with a ≤40 ms stagger
 * (`animate-rise`, transform/opacity only). Layout is pure and cheap; when
 * callers supply dependency `bars`/`edges` an optional SVG overlay draws the
 * arrows via @/lib/dependency-arrows.
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
  const now = new Date();
  const axis = buildGanttAxis(
    [startDate, dueDate, ...milestones.map((milestone) => milestone.dueDate)],
    now,
  );
  const todayPct = percentAlong(axis, now);
  const projectSpan = ganttBarGeometry(axis, startDate, dueDate);
  const markers = new Map(milestoneMarkers(axis, milestones).map((m) => [m.id, m]));
  const fromLabel = new Date(axis.from).toLocaleDateString();
  const toLabel = new Date(axis.to).toLocaleDateString();

  // One derived bar per dated milestone, on its exact row of the chart.
  const derivedBars: BarRect[] = [];
  milestones.forEach((milestone, index) => {
    if (!milestone.dueDate) return;
    const center = percentAlong(axis, milestone.dueDate);
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
          {fromLabel} → {toLabel}
        </p>
      </div>

      <div className="relative">
        {/* today marker — `--danger`, layered by `Z.sticky` */}
        <div
          data-testid="gantt-today"
          className="absolute -top-1 bottom-0 border-s border-dashed border-danger"
          style={{ insetInlineStart: `${todayPct}%`, zIndex: Z.sticky }}
          aria-hidden
        />
        <div className="space-y-3">
          <div
            className="flex animate-rise items-center gap-2"
            style={{ animationDelay: `${ganttStagger(0)}ms` }}
          >
            <span className="w-32 shrink-0 truncate text-xs text-muted">{name}</span>
            <Tooltip label={`${name}: ${fromLabel} → ${toLabel}`}>
              <div className="relative h-5 flex-1 rounded bg-surface-2">
                <div
                  data-testid="gantt-project-bar"
                  className="absolute inset-y-0 rounded bg-accent"
                  style={{ insetInlineStart: `${projectSpan.left}%`, width: `${projectSpan.width}%` }}
                />
              </div>
            </Tooltip>
          </div>

          {milestones.map((milestone, index) => {
            const marker = markers.get(milestone.id);
            const tone = ganttStatusTone(milestone.status);
            const span = ganttBarGeometry(axis, startDate, milestone.dueDate);
            const dateLabel = dayLabel(milestone.dueDate);
            return (
              <div
                key={milestone.id}
                className="flex animate-rise items-center gap-2"
                style={{ animationDelay: `${ganttStagger(index + 1)}ms` }}
              >
                <span
                  className={cn(
                    "w-32 shrink-0 truncate text-xs text-muted",
                    milestone.status === "done" && "line-through",
                  )}
                >
                  {milestone.name}
                </span>
                <div className="relative h-3 flex-1">
                  <div className="absolute inset-y-1/2 h-px w-full bg-border" />
                  {marker ? (
                    <>
                      <Tooltip label={`${milestone.name} · ${dateLabel}`}>
                        <span
                          className={cn("absolute inset-y-0 rounded-xs", GANTT_TONE_CLASS[tone])}
                          style={{ insetInlineStart: `${span.left}%`, width: `${span.width}%` }}
                        />
                      </Tooltip>
                      <span
                        data-testid="gantt-milestone"
                        data-status={milestone.status}
                        aria-hidden
                        className={cn(
                          "absolute top-1/2 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rotate-45 rounded-xs border-2 border-bg",
                          GANTT_TONE_CLASS[tone],
                        )}
                        style={{ insetInlineStart: `${marker.left}%` }}
                      />
                    </>
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
            className="pointer-events-none absolute inset-y-0 right-0 h-full overflow-visible text-accent"
            style={{ insetInlineStart: TRACK_LEFT, zIndex: Z.popover }}
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
