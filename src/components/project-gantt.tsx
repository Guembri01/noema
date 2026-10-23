"use client";

import {
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";
import { Z } from "@/lib/design-tokens";
import { Tooltip } from "@/components/ui/tooltip";
import { buildIntervals, maxOverlap } from "@/lib/interval-tree";
import {
  GANTT_DRAG_THRESHOLD_PX,
  applyDrag,
  dayNumber,
  daysBetween,
  ganttDay,
  moveByDays,
  moveToBound,
  rangeToInstants,
  resizeEdgeByDays,
  resizeToBound,
  shiftDays,
  type GanttDayBounds,
  type GanttDayRange,
  type GanttDragEdge,
} from "@/lib/gantt-schedule";
import type { ProjectResult } from "@/server/actions/projects";
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
 * Width of a project bar's resize grab area, in pixels. Unlike the bar itself
 * (a percentage of the track) a grab area has to stay a physically grabbable
 * width, so it is the one pixel measure in the chart.
 */
export const GANTT_HANDLE_WIDTH = 8;
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
  const points: number[] = [ganttDay(now) ?? 0];
  for (const value of dates) {
    if (!value) continue;
    const ms = ganttDay(value);
    if (ms !== null) points.push(ms);
  }
  const from = Math.min(...points);
  let to = Math.max(...points);
  if (to === from) to += 7 * DAY;
  return { from, to, span: Math.max(to - from, DAY) };
}

/** Runway drawn before and after the data: at least a week, else a tenth of the span. */
export const GANTT_RUNWAY_MIN_DAYS = 7;

/**
 * Pad an axis with drag runway. The chart is fitted to its data, so without this
 * a bar drawn flush against either edge — which the project bar always is, since
 * its own dates build the axis — could never be dragged outward at all. The
 * runway is at least {@link GANTT_RUNWAY_MIN_DAYS} and grows with the span, so a
 * year-long project still has room to move.
 */
export function padGanttAxis(axis: GanttAxis, minDays: number = GANTT_RUNWAY_MIN_DAYS): GanttAxis {
  const days = Math.max(minDays, Math.round(daysBetween(axis.from, axis.to) * 0.1));
  const from = shiftDays(axis.from, -days);
  const to = shiftDays(axis.to, days);
  return { from, to, span: Math.max(to - from, DAY) };
}

/** Position of a date along the axis, clamped to `0..100`. */
export function percentAlong(axis: GanttAxis, value: string | number | Date): number {
  const ms = ganttDay(value);
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
  start: string | number | null | undefined,
  end: string | number | null | undefined,
): GanttSpan {
  const startPct = start !== null && start !== undefined ? percentAlong(axis, start) : 0;
  const endPct = end !== null && end !== undefined ? percentAlong(axis, end) : 100;
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
function dayLabel(value: string | number | Date | null | undefined): string {
  const ms = ganttDay(value);
  return ms === null ? "" : new Date(ms).toLocaleDateString();
}

/** The project row's destination, or a milestone's, while it is being dragged. */
type GanttDragTarget = { kind: "project" } | { kind: "milestone"; id: string };

/** One in-flight pointer drag. */
type GanttDragSession = {
  target: GanttDragTarget;
  edge: GanttDragEdge;
  startX: number;
  origin: GanttDayRange;
  latest: GanttDayRange;
  pxPerDay: number;
  moved: boolean;
};

/** The key an override (or a drag highlight) is stored under. */
function targetKey(target: GanttDragTarget): string {
  return target.kind === "project" ? "project" : target.id;
}

/**
 * Lightweight Gantt: the project spans start → due, every milestone is a
 * status-toned bar ending in a diamond on the same axis, and "today" is pinned
 * in `--danger` so progress is obvious. Bars mount with a ≤40 ms stagger
 * (`animate-rise`, transform/opacity only). Layout is pure and cheap; when
 * callers supply dependency `bars`/`edges` an optional SVG overlay draws the
 * arrows via @/lib/dependency-arrows.
 *
 * The bars are reschedulable, but only through the contract the project page
 * hands down: `projectId` + `canEdit` + the two write callbacks. Dragging the
 * project bar (or either of its edge handles) writes `Project.startDate`/
 * `dueDate` through `onProjectDates`; dragging a milestone's diamond writes that
 * milestone's `dueDate` through `onMilestoneDue`, because a milestone stores no
 * start date — its bar simply runs from the project's start to that date, so the
 * dot is the only honest handle. A refusal from the server reverts the bar and
 * reports why; nothing here can invent a mutation path of its own.
 *
 * A null project date is *drawn* at the axis edge (`ganttBarGeometry`), so a drag
 * materialises exactly the range the bar already shows rather than guessing a
 * date the user never saw. Pointer drags, Escape/pointercancel and the arrow-key
 * equivalent all route through the pure maths in @/lib/gantt-schedule.
 */
export function ProjectGantt({
  name,
  startDate,
  dueDate,
  milestones,
  locale,
  bars,
  edges,
  projectId,
  canEdit = false,
  onProjectDates,
  onMilestoneDue,
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
  /** The project being charted. Required for the project bar to be draggable. */
  projectId?: string;
  /** Whether this viewer may reschedule (`canEditContent`); read-only otherwise. */
  canEdit?: boolean;
  /** Persists the project's two dates; the bar reverts if this answers `error`. */
  onProjectDates?: (input: {
    projectId: string;
    startDate?: string | null;
    dueDate?: string | null;
  }) => Promise<ProjectResult>;
  /** Persists one milestone's due date. */
  onMilestoneDue?: (input: {
    milestoneId: string;
    dueDate?: string | null;
  }) => Promise<ProjectResult>;
}) {
  const router = useRouter();
  const trackRef = useRef<HTMLDivElement | null>(null);
  const sessionRef = useRef<GanttDragSession | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [overrides, setOverrides] = useState<Record<string, GanttDayRange>>({});

  const now = new Date();
  const axis = padGanttAxis(
    buildGanttAxis(
      [startDate, dueDate, ...milestones.map((milestone) => milestone.dueDate)],
      now,
    ),
  );
  const bounds: GanttDayBounds = { min: axis.from, max: axis.to };
  const todayPct = percentAlong(axis, now);
  const fromLabel = new Date(axis.from).toLocaleDateString();
  const toLabel = new Date(axis.to).toLocaleDateString();

  const canDragProject = Boolean(canEdit && projectId && onProjectDates);
  const canDragMilestones = Boolean(canEdit && onMilestoneDue);
  /** Whether this viewer can reschedule anything, so the legend can say so. */
  const reschedulable = canDragProject || canDragMilestones;

  /**
   * The project's current range. The axes are local days, so a drag's result is
   * exactly `rangeToInstants` — an ISO instant of the local midnight it was
   * dragged to, which `ganttDay` reads back unchanged.
   */
  const projectRange: GanttDayRange = overrides.project ?? {
    start: ganttDay(startDate) ?? bounds.min,
    end: ganttDay(dueDate) ?? bounds.max,
  };
  const projectSpan = ganttBarGeometry(axis, projectRange.start, projectRange.end);

  /** Milestone rows with any in-flight drag applied, so the dots track too. */
  const effectiveMilestones = milestones.map((milestone) => {
    const override = overrides[milestone.id];
    return override ? { ...milestone, dueDate: new Date(override.end).toISOString() } : milestone;
  });
  const markers = new Map(milestoneMarkers(axis, effectiveMilestones).map((m) => [m.id, m]));
  const rangeOf = (milestone: GanttMilestone): GanttDayRange | null => {
    const override = overrides[milestone.id];
    const due = override?.end ?? ganttDay(milestone.dueDate);
    if (due === null) return null;
    return { start: ganttDay(startDate) ?? bounds.min, end: due };
  };

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

  /**
   * Pixels per day. Every row's track is the same `flex-1` sibling of a `w-32`
   * label, so measuring the project row's track scales all of them; the axis is
   * measured in whole calendar days to match @/lib/gantt-schedule.
   */
  const pxPerDay = (): number => {
    const width = trackRef.current?.getBoundingClientRect().width ?? 0;
    const days = Math.max(1, daysBetween(bounds.min, bounds.max));
    return width > 0 ? width / days : 0;
  };

  /**
   * Persist a dragged range through the caller's write, keeping the bar at the
   * dragged position until the server answers. A refusal deletes the override,
   * so a bar never rests on a date the database does not have, and says why.
   */
  const commit = (target: GanttDragTarget, range: GanttDayRange) => {
    const key = targetKey(target);
    setOverrides((current) => ({ ...current, [key]: range }));
    const instants = rangeToInstants(range);
    void (async () => {
      try {
        const result =
          target.kind === "project"
            ? await onProjectDates?.({
                projectId: projectId ?? "",
                startDate: instants.start,
                dueDate: instants.due,
              })
            : await onMilestoneDue?.({ milestoneId: target.id, dueDate: instants.due });
        if (result && "error" in result) throw new Error(result.error);
        router.refresh();
      } catch (error) {
        setOverrides((current) => {
          const next = { ...current };
          delete next[key];
          return next;
        });
        toast.error(error instanceof Error && error.message ? error.message : t(locale, "saveFailed"));
      }
    })();
  };

  /**
   * Begin a pointer drag. The listeners live on `window` so the bar keeps
   * tracking when the pointer leaves it, and `data-dragging` on `document.body`
   * is the flag `@/lib/layout-shift` and the `u-no-transition` convention read.
   * Pointerup commits, pointercancel and Escape revert, and a press that never
   * passes {@link GANTT_DRAG_THRESHOLD_PX} commits nothing at all.
   */
  const beginDrag = (
    event: ReactPointerEvent<HTMLElement>,
    target: GanttDragTarget,
    edge: GanttDragEdge,
    origin: GanttDayRange,
  ) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    const scale = pxPerDay();
    if (scale <= 0) return;
    sessionRef.current = {
      target,
      edge,
      startX: event.clientX,
      origin,
      latest: origin,
      pxPerDay: scale,
      moved: false,
    };
    const key = targetKey(target);
    setDragging(key);
    document.body.dataset.dragging = "1";

    const onMove = (move: PointerEvent) => {
      const session = sessionRef.current;
      if (!session) return;
      const deltaPx = move.clientX - session.startX;
      if (Math.abs(deltaPx) > GANTT_DRAG_THRESHOLD_PX) session.moved = true;
      const next = applyDrag(session.origin, session.edge, deltaPx, session.pxPerDay, bounds);
      session.latest = next;
      setOverrides((current) => ({ ...current, [targetKey(session.target)]: next }));
    };
    const finish = (save: boolean) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("keydown", onEscape);
      delete document.body.dataset.dragging;
      setDragging(null);
      const session = sessionRef.current;
      sessionRef.current = null;
      if (!session) return;
      if (save && session.moved) {
        commit(session.target, session.latest);
        return;
      }
      setOverrides((current) => {
        if (!(key in current)) return current;
        const next = { ...current };
        delete next[key];
        return next;
      });
    };
    const onUp = () => finish(true);
    const onCancel = () => finish(false);
    const onEscape = (keyEvent: KeyboardEvent) => {
      if (keyEvent.key !== "Escape") return;
      keyEvent.preventDefault();
      finish(false);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("keydown", onEscape);
  };

  /** Arrow keys shift the project by a day; Home/End pin it against a bound. */
  const moveKeys = (
    event: ReactKeyboardEvent<HTMLElement>,
    target: GanttDragTarget,
    origin: GanttDayRange,
  ) => {
    let next: GanttDayRange | null = null;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      next = moveByDays(origin, 1, bounds);
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      next = moveByDays(origin, -1, bounds);
    } else if (event.key === "Home") {
      next = moveToBound(origin, "min", bounds);
    } else if (event.key === "End") {
      next = moveToBound(origin, "max", bounds);
    } else {
      return;
    }
    event.preventDefault();
    commit(target, next);
  };

  /** Arrow keys move one edge by a day; Home/End pin that edge to a bound. */
  const resizeKeys = (
    event: ReactKeyboardEvent<HTMLElement>,
    target: GanttDragTarget,
    origin: GanttDayRange,
    edge: Exclude<GanttDragEdge, "move">,
  ) => {
    let next: GanttDayRange | null = null;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      next = resizeEdgeByDays(origin, edge, 1, bounds);
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      next = resizeEdgeByDays(origin, edge, -1, bounds);
    } else if (event.key === "Home") {
      next = resizeToBound(origin, edge, "min", bounds);
    } else if (event.key === "End") {
      next = resizeToBound(origin, edge, "max", bounds);
    } else {
      return;
    }
    event.preventDefault();
    commit(target, next);
  };

  const projectTarget: GanttDragTarget = { kind: "project" };
  const projectRangeLabel = `${dayLabel(projectRange.start)} → ${dayLabel(projectRange.end)}`;
  /** Slider bounds, in whole days, so the value a screen reader hears is a date. */
  const slider = {
    min: dayNumber(bounds.min),
    max: dayNumber(bounds.max),
  };
  const handleOffset = GANTT_HANDLE_WIDTH / 2;

  return (
    <div className="rounded-lg border border-border p-4">
      <div className="mb-3 flex items-center justify-between">
        <p className="text-sm font-medium">{t(locale, "timelineLabel")}</p>
        <p className="text-2xs text-muted">
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
            <div ref={trackRef} className="relative h-5 flex-1 rounded bg-surface-2">
              <Tooltip label={`${name}: ${projectRangeLabel}`} side="top">
                <div
                  data-testid="gantt-project-bar"
                  role="slider"
                  tabIndex={canDragProject ? 0 : -1}
                  aria-disabled={!canDragProject}
                  aria-orientation="horizontal"
                  aria-label={`${t(locale, "timelineMoveItem")}: ${name}`}
                  aria-valuemin={slider.min}
                  aria-valuemax={slider.max}
                  aria-valuenow={dayNumber(projectRange.start)}
                  aria-valuetext={projectRangeLabel}
                  className={cn(
                    "absolute inset-y-0 rounded bg-accent",
                    canDragProject && "focus-ring cursor-grab touch-none select-none active:cursor-grabbing",
                    dragging === "project" && "u-no-transition",
                  )}
                  style={{
                    insetInlineStart: `${projectSpan.left}%`,
                    width: `${projectSpan.width}%`,
                  }}
                  onPointerDown={
                    canDragProject
                      ? (event) => beginDrag(event, projectTarget, "move", projectRange)
                      : undefined
                  }
                  onKeyDown={
                    canDragProject
                      ? (event) => moveKeys(event, projectTarget, projectRange)
                      : undefined
                  }
                />
              </Tooltip>
              {canDragProject && (
                <>
                  <Tooltip label={`${t(locale, "timelineResizeStart")}: ${name}`} side="top">
                    <button
                      type="button"
                      data-testid="gantt-project-resize-start"
                      role="slider"
                      aria-orientation="horizontal"
                      aria-label={`${t(locale, "timelineResizeStart")}: ${name}`}
                      aria-valuemin={slider.min}
                      aria-valuemax={dayNumber(projectRange.end)}
                      aria-valuenow={dayNumber(projectRange.start)}
                      aria-valuetext={projectRangeLabel}
                      className={cn(
                        "focus-ring absolute inset-y-0 cursor-ew-resize touch-none rounded-s-sm bg-transparent hover:bg-accent-fg/40",
                        dragging === "project" && "u-no-transition",
                      )}
                      style={{
                        insetInlineStart: `calc(${projectSpan.left}% - ${handleOffset}px)`,
                        width: GANTT_HANDLE_WIDTH,
                      }}
                      onPointerDown={(event) =>
                        beginDrag(event, projectTarget, "start", projectRange)
                      }
                      onKeyDown={(event) =>
                        resizeKeys(event, projectTarget, projectRange, "start")
                      }
                    />
                  </Tooltip>
                  <Tooltip label={`${t(locale, "timelineResizeEnd")}: ${name}`} side="top">
                    <button
                      type="button"
                      data-testid="gantt-project-resize-end"
                      role="slider"
                      aria-orientation="horizontal"
                      aria-label={`${t(locale, "timelineResizeEnd")}: ${name}`}
                      aria-valuemin={dayNumber(projectRange.start)}
                      aria-valuemax={slider.max}
                      aria-valuenow={dayNumber(projectRange.end)}
                      aria-valuetext={projectRangeLabel}
                      className={cn(
                        "focus-ring absolute inset-y-0 cursor-ew-resize touch-none rounded-e-sm bg-transparent hover:bg-accent-fg/40",
                        dragging === "project" && "u-no-transition",
                      )}
                      style={{
                        insetInlineStart: `calc(${projectSpan.left + projectSpan.width}% - ${handleOffset}px)`,
                        width: GANTT_HANDLE_WIDTH,
                      }}
                      onPointerDown={(event) => beginDrag(event, projectTarget, "end", projectRange)}
                      onKeyDown={(event) => resizeKeys(event, projectTarget, projectRange, "end")}
                    />
                  </Tooltip>
                </>
              )}
            </div>
          </div>

          {milestones.map((milestone, index) => {
            const marker = markers.get(milestone.id);
            const tone = ganttStatusTone(milestone.status);
            const range = rangeOf(milestone);
            const span = ganttBarGeometry(axis, projectRange.start, range?.end ?? null);
            const dateLabel = dayLabel(range?.end ?? milestone.dueDate);
            const target: GanttDragTarget = { kind: "milestone", id: milestone.id };
            const draggableDot = canDragMilestones && range !== null;
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
                      {/*
                        The dot is the milestone's one honest handle: the bar runs
                        from the project's start to this date, so dragging it
                        writes `dueDate` (an "end" drag) and leaves the run-up.
                      */}
                      <button
                        type="button"
                        data-testid="gantt-milestone"
                        data-status={milestone.status}
                        role="slider"
                        tabIndex={draggableDot ? 0 : -1}
                        aria-disabled={!draggableDot}
                        aria-orientation="horizontal"
                        aria-label={`${t(locale, "timelineMoveItem")}: ${milestone.name}`}
                        aria-valuemin={slider.min}
                        aria-valuemax={slider.max}
                        aria-valuenow={dayNumber(range?.end ?? 0)}
                        aria-valuetext={dateLabel}
                        className={cn(
                          "absolute top-1/2 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rotate-45 rounded-xs border-2 border-bg",
                          GANTT_TONE_CLASS[tone],
                          draggableDot &&
                            "focus-ring cursor-grab touch-none after:absolute after:-inset-1 after:content-['']",
                          dragging === milestone.id && "u-no-transition",
                        )}
                        style={{ insetInlineStart: `${marker.left}%` }}
                        onPointerDown={
                          draggableDot && range
                            ? (event) => beginDrag(event, target, "end", range)
                            : undefined
                        }
                        onKeyDown={
                          draggableDot && range
                            ? (event) => resizeKeys(event, target, range, "end")
                            : undefined
                        }
                      />
                    </>
                  ) : (
                    <span className="absolute right-0 top-1/2 -translate-y-1/2 text-3xs text-muted">
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

      <p className="mt-3 text-2xs text-muted">
        {t(locale, "ganttLegend")}
        {reschedulable ? ` ${t(locale, "ganttDragHint")}` : ""}
      </p>
    </div>
  );
}
