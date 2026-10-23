"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { BarChart3, CalendarDays, Columns3, GanttChartSquare } from "lucide-react";
import {
  timelineData,
  type QueryProperty,
  type QueryRow,
  type TimelineBar,
} from "@/lib/database-query";
import { setPropertyValueAction } from "@/server/actions/database";
import {
  moveByUnits,
  moveRange,
  moveToBounds,
  rangeToDateValue,
  rangeToPercent,
  resizeByUnits,
  resizeRange,
  resizeToBounds,
  unitMs,
  type DragBounds,
  type DragEdge,
  type DragRange,
  type TimelineDragUnit,
} from "@/lib/timeline-drag";
import {
  buildChartSeries,
  type ChartConfig,
  type ChartLimitOptions,
  type ChartProperty,
  type ChartType,
} from "@/lib/charts";
import type { AggregationFn } from "@/lib/aggregations";
import {
  computeEdgeRoutes,
  pickSides,
  type ArrowPath,
  type BarRect,
  type TimelineEdge,
} from "@/lib/dependency-arrows";
import type { DBProperty, DBRow } from "@/components/database/database-types";
import { stableTime } from "@/lib/time";
import { assignLanes } from "@/lib/timeline";
import {
  MS_PER_DAY,
  monthGrid,
  placeEvents,
  type CalendarDay,
  type CalendarEvent,
  type CalendarGrid,
} from "@/lib/calendar-multiday";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";
import { TAG_PALETTE, isTagHue, tagStyle, type TagHue } from "@/lib/design-tokens";
import { EmptyState } from "@/components/ui/empty-state";
import { Segmented } from "@/components/ui/segmented";
import { Skeleton } from "@/components/ui/skeleton";
import { Tag } from "@/components/ui/tag";
import { Tooltip } from "@/components/ui/tooltip";

/**
 * Timeline, chart and calendar views for a database.
 *
 * Extracted from `database-view.tsx` (P3) so the file that owns
 * the table/board/list renderers keeps shrinking toward a testable size. The
 * chart body is built by the pure `@/lib/charts` engine and the timeline can
 * stroke dependency arrows routed by `@/lib/dependency-arrows`.
 *
 * Design-system adoption (docs/DESIGN_SYSTEM.md):
 * - colour/duration/z-index/radius come from tokens (`var(--tag-*)`,
 *   `--dur-*`, `--ease-smooth`) — never a raw hex, a magic z or an ad-hoc ms;
 * - every list/panel has its loading (skeleton), empty (`EmptyState`) and
 *   content states, and the empty states stay actionable;
 * - chart items animate in on mount with `transform`/`opacity` only (no layout
 *   shift) and skip the animation entirely under `prefers-reduced-motion`;
 * - hover values are real `Tooltip`s, not `title` attributes.
 *
 * The pure geometry/animation maps (`timelineLaneY`, `chartItemMotion`,
 * `pieSliceArcs`, `calendarBarTop`, …) are exported so the node tests can pin
 * them without a DOM.
 */

/* --------------------------------------------------------------------------- */
/* Shared geometry                                                             */
/* --------------------------------------------------------------------------- */

/** Vertical pitch of one timeline row, in px — shared by the bars and arrows. */
const ROW_PITCH = 44;
/** Height of one timeline bar, in px. */
const BAR_HEIGHT = 18;
/** Horizontal coordinate space the bars (and arrows) are laid out in. */
const TIMELINE_WIDTH = 1000;
/** Zoom multipliers the timeline `Segmented` offers. */
export const TIMELINE_ZOOM_LEVELS = [1, 2, 4] as const;

/** Group name for the timeline zoom radiogroup (no catalogue key exists yet). */
const TIMELINE_ZOOM_LABEL = "Timeline zoom";
/** Group name for the calendar scale radiogroup (no catalogue key exists yet). */
const CALENDAR_SCALE_LABEL = "Calendar scale";

/* --------------------------------------------------------------------------- */
/* Timeline: drag/resize interaction model                                     */
/* --------------------------------------------------------------------------- */

/** Pointer travel (px) that turns a press into a drag rather than a click. */
const TIMELINE_DRAG_THRESHOLD_PX = 3;
/** Width (px) of each edge-resize handle. */
const TIMELINE_HANDLE_WIDTH = 8;

/** Which part of a bar a pointer grabbed. */
type TimelineDragEdge = "move" | DragEdge;

/** An in-flight bar drag, alive between pointerdown and pointerup/cancel. */
type TimelineDragSession = {
  rowId: string;
  /** Which handle grabbed the bar: its body moves, either edge resizes. */
  dragEdge: TimelineDragEdge;
  /** Client x where the drag started; every delta is measured from here. */
  startX: number;
  /** The bar's range when the drag began (snapped against on release). */
  origin: DragRange;
  /** The latest previewed range, committed verbatim on release. */
  latest: DragRange;
  /** Pixels per snap unit, resolved from the measured board width once. */
  pxPerUnit: number;
  /** Whether the pointer actually travelled far enough to count as a drag. */
  moved: boolean;
};

/**
 * Deterministic UTC month label for the timeline axis. Fixed locale + timezone
 * (like `stableTime`) so the server and the first client paint agree.
 */
function axisMonthLabel(date: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

/** Turn an orthogonal arrow into an SVG `d` attribute. */
function arrowPathD(path: ArrowPath): string {
  return [path.start, ...path.points, path.end]
    .map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`)
    .join(" ");
}

/* --------------------------------------------------------------------------- */
/* Timeline: pure geometry                                                     */
/* --------------------------------------------------------------------------- */

/** The x offset (in the shared coordinate space) for a bar's left edge. */
export function timelineBarOffset(offsetPct: number): number {
  return (offsetPct / 100) * TIMELINE_WIDTH;
}

/** The clamped width (in the shared coordinate space) for a bar. */
export function timelineBarWidth(widthPct: number): number {
  return Math.max(1, (widthPct / 100) * TIMELINE_WIDTH);
}

/** The top (px) of a bar packed into `lane`. */
export function timelineLaneY(lane: number): number {
  return lane * ROW_PITCH + (ROW_PITCH - BAR_HEIGHT) / 2;
}

/** Total height (px) of a timeline with `laneCount` lanes. */
export function timelineHeight(laneCount: number): number {
  return Math.max(1, Math.max(1, laneCount) * ROW_PITCH);
}

/** Horizontal-guide offsets (px) between `laneCount` lanes. */
export function timelineLaneGuides(laneCount: number): number[] {
  const lanes = Math.max(0, Math.trunc(laneCount));
  return Array.from({ length: lanes }, (_, lane) => lane * ROW_PITCH).filter(
    (offset) => offset > 0,
  );
}

/** Percent position of a tick on `[from, to]`. */
export function timelineTickPct(tickMs: number, fromMs: number, toMs: number): number {
  const span = Math.max(1, toMs - fromMs);
  return ((tickMs - fromMs) / span) * 100;
}

/** Rendered width of the timeline body at a zoom multiplier. */
export function timelineZoomWidthPct(zoom: number): number {
  return Math.max(1, zoom) * 100;
}

/** The hover text of a timeline bar: the exact inclusive date span. */
export function timelineTooltipLabel(startISO: string, endISO: string): string {
  return `${startISO.slice(0, 10)} → ${endISO.slice(0, 10)}`;
}

/* --------------------------------------------------------------------------- */
/* Chart: pure mapping                                                         */
/* --------------------------------------------------------------------------- */

/** The value a bar's width is measured against (never zero). */
export function chartBarMax(values: readonly (number | null)[]): number {
  return Math.max(1, ...values.map((value) => value ?? 0));
}

/** A bar's width as a percentage of the largest value. */
export function chartBarWidthPct(
  value: number | null | undefined,
  max: number,
): number {
  return Math.max(0, ((value ?? 0) / Math.max(1, max)) * 100);
}

/** One point on the 0..100 line box (`y` grows downwards). */
export function linePointCoords(
  values: readonly (number | null)[],
): { x: number; y: number }[] {
  const max = chartBarMax(values);
  const step = values.length > 1 ? 100 / (values.length - 1) : 0;
  return values.map((value, index) => ({
    x: index * step,
    y: 100 - ((value ?? 0) / max) * 100,
  }));
}

/** Circumference of the pie/donut arc radius. */
export function pieCircumference(radius: number): number {
  return 2 * Math.PI * radius;
}

/**
 * The `stroke-dasharray`/`stroke-dashoffset` geometry for every pie/donut slice,
 * plus the total the shares are computed against. Pure, so the node tests can
 * pin the angles.
 */
export function pieSliceArcs(
  slices: readonly { label: string; value: number }[],
  radius: number,
): {
  total: number;
  circumference: number;
  arcs: { label: string; value: number; fraction: number; dash: number; offset: number }[];
} {
  const circumference = pieCircumference(radius);
  const total = slices.reduce((sum, slice) => sum + slice.value, 0);
  let consumed = 0;
  const arcs = slices.map((slice) => {
    const fraction = total > 0 ? slice.value / total : 0;
    const dash = fraction * circumference;
    const arc = {
      label: slice.label,
      value: slice.value,
      fraction,
      dash,
      offset: -consumed,
    };
    consumed += dash;
    return arc;
  });
  return { total, circumference, arcs };
}

/** `value` rendered for a cell/tooltip; an absent value reads `—`. */
export function formatChartValue(value: number | null | undefined): string {
  return value === null || value === undefined ? "—" : String(value);
}

/** The exact `label: value` tooltip text for a bar/line point. */
export function chartTooltipLabel(
  label: string,
  value: number | null | undefined,
): string {
  return `${label}: ${formatChartValue(value)}`;
}

/** The exact `label: value (share%)` tooltip text for a pie/donut slice. */
export function chartSliceTooltipLabel(
  label: string,
  value: number,
  total: number,
): string {
  const percent = total > 0 ? Math.round((value / total) * 100) : 0;
  return `${label}: ${value} (${percent}%)`;
}

/** The tag ink a chart mark is painted with — a token, never a raw hex. */
export function chartInk(hue: TagHue): string {
  return `var(--tag-${hue}-fg)`;
}

/* --------------------------------------------------------------------------- */
/* Chart: mount motion                                                         */
/* --------------------------------------------------------------------------- */

/** Per-item stagger step. Keeps every mark within 40 ms of its neighbour. */
export const CHART_STAGGER_MS = 40;
/** Cap the stagger so a long series never queues a slow reveal. */
export const CHART_STAGGER_MAX_STEPS = 8;

/**
 * The mount delay for the item at `index`: `index * step`, capped. Total stagger
 * never exceeds {@link CHART_STAGGER_MAX_STEPS} * {@link CHART_STAGGER_MS}.
 */
export function chartStaggerDelay(index: number): number {
  if (!Number.isFinite(index)) return 0;
  const step = Math.max(0, Math.trunc(index));
  return Math.min(step, CHART_STAGGER_MAX_STEPS) * CHART_STAGGER_MS;
}

/**
 * The mount-motion bundle for one chart item.
 *
 * - `reduced` → nothing at all: the mark renders visible immediately and never
 *   plays the animation (skipped, not shortened).
 * - before mount → hidden (`opacity-0` + a 4px rise), no transition, so the
 *   first paint occupies its final box and nothing shifts.
 * - after mount → the visible state plus a `--dur-2`/`--ease-smooth`
 *   `transform`+`opacity` transition, delayed by {@link chartStaggerDelay}.
 *
 * `motion-reduce:` mirrors the reduced flag for the single frame before the
 * media query is read, so a reduced-motion user never sees the hidden state.
 */
export function chartItemMotion(
  index: number,
  mounted: boolean,
  reduced: boolean,
): { className: string; style: CSSProperties | undefined } {
  if (reduced) return { className: "", style: undefined };
  const delay = chartStaggerDelay(index);
  const style: CSSProperties | undefined = mounted
    ? {
        transitionProperty: "opacity, transform",
        transitionDuration: "var(--dur-2)",
        transitionTimingFunction: "var(--ease-smooth)",
        transitionDelay: `${delay}ms`,
      }
    : undefined;
  return {
    className: cn(
      "motion-reduce:opacity-100 motion-reduce:translate-y-0",
      mounted ? "opacity-100 translate-y-0" : "opacity-0 translate-y-1",
    ),
    style,
  };
}

/** True while the user prefers reduced motion; SSR-safe (`false` on the server). */
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const query = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!query) return;
    setReduced(query.matches);
    const onChange = () => setReduced(query.matches);
    query.addEventListener?.("change", onChange);
    return () => query.removeEventListener?.("change", onChange);
  }, []);
  return reduced;
}

/** The mount-animation state every chart sub-view shares. */
function useChartMount(): { mounted: boolean; reduced: boolean } {
  const reduced = usePrefersReducedMotion();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return { mounted, reduced };
}

/* --------------------------------------------------------------------------- */
/* Calendar: pure geometry                                                     */
/* --------------------------------------------------------------------------- */

/** Height of one multi-day bar lane on the calendar grid, in px. */
export const CALENDAR_LANE_HEIGHT = 20;
/** Space above the first lane in a week row (room for the day number), in px. */
export const CALENDAR_ROW_PAD = 24;
/** Lanes a week row may show before extra bars collapse into a "+N" badge. */
export const CALENDAR_MAX_LANES = 4;

const WEEKDAY_KEYS = [
  "wdSun",
  "wdMon",
  "wdTue",
  "wdWed",
  "wdThu",
  "wdFri",
  "wdSat",
] as const;

/** A database row projected onto the calendar: its DATE span plus a title. */
type CalendarRowEvent = CalendarEvent & { title: string };

/** Deterministic UTC "March 2026" month label (server and client agree). */
export function calendarMonthLabel(year: number, month: number): string {
  return new Intl.DateTimeFormat("en-GB", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, month, 1)));
}

/** Short, locale-aware month label for the scale switch ("Mar"). */
export function monthShortLabel(year: number, month: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, month, 1)));
}

/** Locale-aware compact label for a visible week ("9 Mar – 15 Mar"). */
export function weekRangeLabel(days: readonly CalendarDay[], locale: string): string {
  if (days.length === 0) return "";
  const format = new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
  const first = format.format(new Date(days[0].dayIndex * MS_PER_DAY));
  const last = format.format(new Date(days[days.length - 1].dayIndex * MS_PER_DAY));
  return `${first} – ${last}`;
}

/** The left edge (%) of a calendar bar starting at `startCol` (0..6). */
export function calendarBarLeftPct(startCol: number): number {
  return (startCol / 7) * 100;
}

/** The width (%) of a calendar bar spanning `span` columns. */
export function calendarBarWidthPct(span: number): number {
  return (span / 7) * 100;
}

/** The top (px) of a calendar bar packed into `lane`. */
export function calendarBarTop(lane: number): number {
  return CALENDAR_ROW_PAD + lane * CALENDAR_LANE_HEIGHT;
}

/** The minimum height (px) of a week row with `laneCount` bars. */
export function calendarWeekRowHeight(laneCount: number): number {
  return CALENDAR_ROW_PAD + Math.max(1, laneCount) * CALENDAR_LANE_HEIGHT + 6;
}

/** A stable tag hue for a calendar event, derived from its row id. */
export function calendarEventHue(id: string): TagHue {
  let hash = 0;
  for (let index = 0; index < id.length; index += 1) {
    hash = (hash * 31 + id.charCodeAt(index)) >>> 0;
  }
  return TAG_PALETTE[hash % TAG_PALETTE.length];
}

/**
 * A one-week `CalendarGrid` starting on the `weekStartsOn` column that contains
 * `anchorDayIndex`. `inMonth` is measured against the anchor's own month so
 * spill days render muted, exactly like the month grid.
 */
export function weekGrid(anchorDayIndex: number, weekStartsOn = 0): CalendarGrid {
  const safeStart = ((weekStartsOn % 7) + 7) % 7;
  const anchor = Number.isFinite(anchorDayIndex) ? Math.trunc(anchorDayIndex) : 0;
  const anchorDate = new Date(anchor * MS_PER_DAY);
  const year = anchorDate.getUTCFullYear();
  const month = anchorDate.getUTCMonth();
  const start = anchor - ((anchorDate.getUTCDay() - safeStart + 7) % 7);
  const days: CalendarDay[] = [];
  for (let index = 0; index < 7; index += 1) {
    const dayIndex = start + index;
    const date = new Date(dayIndex * MS_PER_DAY);
    const cellYear = date.getUTCFullYear();
    const cellMonth = date.getUTCMonth();
    days.push({
      key: `${cellYear}-${String(cellMonth + 1).padStart(2, "0")}-${String(
        date.getUTCDate(),
      ).padStart(2, "0")}`,
      dayIndex,
      date: date.getUTCDate(),
      month: cellMonth,
      year: cellYear,
      weekday: date.getUTCDay(),
      inMonth: cellYear === year && cellMonth === month,
    });
  }
  return { year, month, weekStartsOn: safeStart, weeks: [days], days };
}

/* --------------------------------------------------------------------------- */
/* Loading skeletons                                                           */
/* --------------------------------------------------------------------------- */

/** A month-grid shaped placeholder while a calendar loads. */
export function CalendarSkeleton() {
  return (
    <div
      data-testid="calendar-skeleton"
      aria-busy="true"
      className="overflow-hidden rounded-lg border border-border"
    >
      <div className="grid grid-cols-7 bg-surface">
        {Array.from({ length: 7 }).map((_, index) => (
          <div key={index} className="px-2 py-1">
            <Skeleton variant="block" className="h-3 w-8" />
          </div>
        ))}
      </div>
      {Array.from({ length: 5 }).map((_, row) => (
        <div
          key={row}
          className="grid grid-cols-7 border-t border-border"
          style={{ minHeight: CALENDAR_ROW_PAD + CALENDAR_LANE_HEIGHT + 6 }}
        >
          {Array.from({ length: 7 }).map((_, col) => (
            <div key={col} className="border-r border-border p-1.5 last:border-r-0">
              <Skeleton variant="block" className="h-3 w-5" />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

/** A gantt shaped placeholder while a timeline loads. */
export function TimelineSkeleton() {
  return (
    <div
      data-testid="timeline-skeleton"
      aria-busy="true"
      className="rounded-lg border border-border p-4"
    >
      <Skeleton variant="block" className="mb-3 h-3 w-40" />
      <div className="space-y-3">
        {Array.from({ length: 5 }).map((_, row) => (
          <div key={row} className="flex items-center">
            <Skeleton
              variant="block"
              className="h-4 w-1/3"
              style={{ marginInlineStart: `${row * 12}%` }}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

/** A bars/chart shaped placeholder while a chart loads. */
export function ChartSkeleton() {
  return (
    <div
      data-testid="chart-skeleton"
      aria-busy="true"
      className="rounded-lg border border-border p-5"
    >
      <Skeleton variant="block" className="mb-4 h-3 w-1/3" />
      <div className="space-y-3">
        {Array.from({ length: 4 }).map((_, row) => (
          <div key={row} className="flex items-center gap-3">
            <Skeleton variant="block" className="h-3 w-32" />
            <Skeleton variant="block" className="h-4 flex-1" />
            <Skeleton variant="block" className="h-3 w-8" />
          </div>
        ))}
      </div>
    </div>
  );
}

/* --------------------------------------------------------------------------- */
/* Timeline view                                                               */
/* --------------------------------------------------------------------------- */

export function TimelineView({
  locale,
  workspaceSlug,
  properties,
  rows,
  edges,
  loading = false,
  editable = true,
}: {
  workspaceSlug: string;
  properties: DBProperty[];
  rows: DBRow[];
  locale: string;
  /**
   * Dependency edges to draw (`from` blocks `to`). The database row shape has
   * no reliable ordered blocking value (a RELATION cell is undirected), so the
   * view draws arrows only when a caller supplies `edges`; otherwise the
   * timeline renders bars with no arrows.
   */
  edges?: TimelineEdge[];
  /** Render the loading skeleton (matching the final layout). */
  loading?: boolean;
  /**
   * Whether this view may be changed. Read-only databases still *render* the bars
   * (and keep the handles visible for layout stability) but nothing is draggable,
   * nothing is focusable and nothing calls the mutation — previously a drag was
   * attempted and then reverted by the permission error, which looked like a bug.
   */
  editable?: boolean;
}) {
  const [zoom, setZoom] = useState<number>(TIMELINE_ZOOM_LEVELS[0]);
  const [overrides, setOverrides] = useState<Record<string, DragRange>>({});
  const [draggingRow, setDraggingRow] = useState<string | null>(null);
  const boardRef = useRef<HTMLDivElement | null>(null);
  const dragSession = useRef<TimelineDragSession | null>(null);
  const suppressClick = useRef(false);
  const router = useRouter();

  // A drag ends with a click the browser synthesises on release; swallow it so
  // the row's delegated side-peek never opens on the tail of a drag.
  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      if (!suppressClick.current) return;
      suppressClick.current = false;
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener("click", onClick, true);
    return () => window.removeEventListener("click", onClick, true);
  }, []);

  // Never leave the global "a drag is in progress" flag set if the view unmounts
  // mid-gesture (navigation, a filter change): a stale flag would suppress every
  // FLIP animation on the next page.
  useEffect(() => () => {
    delete document.body.dataset.dragging;
  }, []);

  // Reconcile the optimistic range with server truth: once the refreshed row
  // carries the range that was committed, drop the local override so the server
  // is the single source again. A failed write is reverted by `commitRange`.
  useEffect(() => {
    const dateId = properties.find((property) => property.type === "DATE")?.id;
    if (!dateId) return;
    setOverrides((current) => {
      if (Object.keys(current).length === 0) return current;
      let changed = false;
      const next = { ...current };
      for (const row of rows) {
        const override = next[row.id];
        if (!override) continue;
        const value = row.propertyValues.find(
          (entry) => entry.propertyId === dateId,
        )?.value as { start?: string; end?: string } | null | undefined;
        if (!value?.start) continue;
        const start = Date.parse(value.start);
        const end = value.end ? Date.parse(value.end) : start + MS_PER_DAY;
        if (start === override.start && end === override.end) {
          delete next[row.id];
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [rows, properties]);

  if (loading) return <TimelineSkeleton />;

  const dateProperty = properties.find((p) => p.type === "DATE");
  if (!dateProperty) {
    return (
      <div className="rounded-lg border border-dashed border-border">
        <EmptyState
          variant="compact"
          icon={<GanttChartSquare className="size-4" />}
          title={t(locale, "timelineNeedsDate")}
          description={t(locale, "dbNoRowsHint")}
        />
      </div>
    );
  }
  const now = new Date();
  const from = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const to = new Date(now.getFullYear(), now.getMonth() + 4, 0);
  const bars = timelineData(
    rows as unknown as QueryRow[],
    properties as unknown as QueryProperty[],
    dateProperty.id,
    from,
    to,
  );

  // Pack the bars into non-overlapping lanes: rows that do not overlap in time
  // share a track, so the chart reads as a gantt instead of one row per bar.
  // `assignLanes` is the pure positioning engine; results are keyed back to
  // each bar by row id.
  const laneInput = bars.map((bar) => ({
    id: bar.rowId,
    start: Date.parse(bar.startISO),
    end: Date.parse(bar.endISO),
  }));
  const { assignments, laneCount } = assignLanes(laneInput);
  const laneByRow = new Map(
    assignments.map((assignment) => [assignment.event.id, assignment.lane]),
  );
  const yFor = (rowId: string): number => timelineLaneY(laneByRow.get(rowId) ?? 0);

  // Bars are laid out in the same abstract space the arrow router expects:
  // x spans 0…TIMELINE_WIDTH (mapped across the container) and y runs in px.
  const barRects: BarRect[] = bars.map((bar) => ({
    id: bar.rowId,
    x: timelineBarOffset(bar.offsetPct),
    y: yFor(bar.rowId),
    width: timelineBarWidth(bar.widthPct),
    height: BAR_HEIGHT,
  }));
  const barById = new Map(barRects.map((bar) => [bar.id, bar]));
  const routes =
    edges && edges.length > 0 ? computeEdgeRoutes(barRects, edges) : [];
  const routeById = new Map(routes.map((route) => [route.edgeId, route]));
  const height = timelineHeight(laneCount);
  const laneGuides = timelineLaneGuides(laneCount);

  // Month gridlines + labels over the same [from, to] window, plus a "today"
  // marker: the time axis the lanes are read against.
  const spanMs = Math.max(1, to.getTime() - from.getTime());
  const ticks: { pct: number; label: string }[] = [];
  for (
    let tick = new Date(from.getFullYear(), from.getMonth(), 1);
    tick.getTime() <= to.getTime();
    tick = new Date(tick.getFullYear(), tick.getMonth() + 1, 1)
  ) {
    ticks.push({
      pct: timelineTickPct(tick.getTime(), from.getTime(), to.getTime()),
      label: axisMonthLabel(tick),
    });
  }
  const todayPct = timelineTickPct(now.getTime(), from.getTime(), to.getTime());

  const zoomOptions = TIMELINE_ZOOM_LEVELS.map((level) => ({
    value: String(level),
    label: `${level}×`,
    ariaLabel: `${level}× ${t(locale, "timelineLabel")}`,
  }));

  const header = (
    <div className="mb-3 flex items-center justify-between text-xs text-muted">
      <span>{stableTime(from, "date")}</span>
      <span className="font-medium text-fg">{dateProperty.name}</span>
      <span>{stableTime(to, "date")}</span>
    </div>
  );

  if (bars.length === 0) {
    return (
      <div className="rounded-lg border border-border p-4">
        {header}
        <EmptyState
          variant="compact"
          icon={<GanttChartSquare className="size-4" />}
          title={t(locale, "noDatedRows")}
          description={t(locale, "dbNoRowsHint")}
        />
      </div>
    );
  }

  /* ------------------------------------------------------------------------- */
  /* Drag / resize wiring                                                      */
  /* ------------------------------------------------------------------------- */

  // Bars are laid out as percentages of the board, so a session measures the
  // board once for its pixels-per-unit scale; every subsequent move is pure
  // maths in `@/lib/timeline-drag` (day snapping + bounds clamping).
  const dragUnit: TimelineDragUnit = "day";
  const dragBounds: DragBounds = { min: from.getTime(), max: to.getTime() };

  const serverRange = (bar: TimelineBar): DragRange => ({
    start: Date.parse(bar.startISO),
    end: Date.parse(bar.endISO),
  });
  const currentRange = (bar: TimelineBar): DragRange =>
    overrides[bar.rowId] ?? serverRange(bar);

  /** Preserve the row's other DATE fields (`allDay`, `timeZone`) on a write. */
  const rowDateValue = (rowId: string): Record<string, unknown> => {
    const row = rows.find((candidate) => candidate.id === rowId);
    const value = row?.propertyValues.find(
      (entry) => entry.propertyId === dateProperty.id,
    )?.value;
    return value && typeof value === "object"
      ? { ...(value as Record<string, unknown>) }
      : {};
  };

  /**
   * Persist a range through the *existing* mutation path — the same
   * `setPropertyValueAction` + `router.refresh()` the table/board cells use.
   * The optimistic override is dropped if the write fails, so a server rejection
   * can never leave the bar at a date the database does not have.
   */
  const commitRange = (rowId: string, range: DragRange) => {
    setOverrides((current) => ({ ...current, [rowId]: range }));
    const value = { ...rowDateValue(rowId), ...rangeToDateValue(range) };
    void (async () => {
      try {
        const result = await setPropertyValueAction(rowId, dateProperty.id, value);
        if (result && "error" in result) throw new Error(result.error);
        router.refresh();
      } catch {
        setOverrides((current) => {
          const next = { ...current };
          delete next[rowId];
          return next;
        });
      }
    })();
  };

  /**
   * Begin a bar drag with Pointer Events (mouse/pen/touch). The listeners live
   * on `window` so the bar keeps tracking when the pointer leaves it; the drag
   * flag and `.u-no-transition` are cleared on pointerup *and* on
   * pointercancel/Escape, where the preview reverts instead of committing.
   */
  const beginDrag = (
    event: ReactPointerEvent<HTMLElement>,
    bar: TimelineBar,
    edge: TimelineDragEdge,
  ) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    const width = boardRef.current?.getBoundingClientRect().width ?? 0;
    if (width <= 0) return;
    const origin = currentRange(bar);
    dragSession.current = {
      rowId: bar.rowId,
      dragEdge: edge,
      startX: event.clientX,
      origin,
      latest: origin,
      pxPerUnit: (width / spanMs) * unitMs(dragUnit),
      moved: false,
    };
    setDraggingRow(bar.rowId);
    document.body.dataset.dragging = "1";

    const onMove = (move: PointerEvent) => {
      const session = dragSession.current;
      if (!session) return;
      const deltaPx = move.clientX - session.startX;
      if (Math.abs(deltaPx) > TIMELINE_DRAG_THRESHOLD_PX) session.moved = true;
      const next =
        session.dragEdge === "move"
          ? moveRange(session.origin, deltaPx, session.pxPerUnit, dragBounds, dragUnit)
          : resizeRange(
              session.origin,
              session.dragEdge,
              deltaPx,
              session.pxPerUnit,
              dragBounds,
              dragUnit,
            );
      session.latest = next;
      setOverrides((current) => ({ ...current, [session.rowId]: next }));
    };
    const finish = (commit: boolean) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("keydown", onEscape);
      delete document.body.dataset.dragging;
      setDraggingRow(null);
      const session = dragSession.current;
      dragSession.current = null;
      if (!session) return;
      const wasMoved = session.moved;
      if (commit && wasMoved) {
        commitRange(session.rowId, session.latest);
      } else {
        setOverrides((current) => {
          if (!(session.rowId in current)) return current;
          const next = { ...current };
          delete next[session.rowId];
          return next;
        });
      }
      // Whatever the outcome, a moved pointer still fired a click on release;
      // swallow it so a drag (or a cancelled drag) never opens the row's
      // side-peek. The flag is cleared on that click, and by the timer if the
      // browser does not deliver one.
      if (wasMoved) {
        suppressClick.current = true;
        window.setTimeout(() => {
          suppressClick.current = false;
        }, 0);
      }
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

  /** Arrow keys move the whole bar one unit; Home/End pin it to a bound. */
  const moveBarKeys = (event: ReactKeyboardEvent<HTMLElement>, bar: TimelineBar) => {
    if (!editable) return;
    const range = currentRange(bar);
    let next: DragRange | null = null;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      next = moveByUnits(range, 1, dragUnit, dragBounds);
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      next = moveByUnits(range, -1, dragUnit, dragBounds);
    } else if (event.key === "Home") {
      next = moveToBounds(range, "start", dragBounds);
    } else if (event.key === "End") {
      next = moveToBounds(range, "end", dragBounds);
    } else {
      return;
    }
    event.preventDefault();
    commitRange(bar.rowId, next);
  };

  /** Arrow keys resize one edge; Home/End pin that edge to a bound. */
  const resizeBarKeys = (
    event: ReactKeyboardEvent<HTMLElement>,
    bar: TimelineBar,
    edge: DragEdge,
  ) => {
    const range = currentRange(bar);
    let next: DragRange | null = null;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      next = resizeByUnits(range, edge, 1, dragUnit, dragBounds);
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      next = resizeByUnits(range, edge, -1, dragUnit, dragBounds);
    } else if (event.key === "Home") {
      next = resizeToBounds(range, edge, "min", dragBounds);
    } else if (event.key === "End") {
      next = resizeToBounds(range, edge, "max", dragBounds);
    } else {
      return;
    }
    event.preventDefault();
    commitRange(bar.rowId, next);
  };

  const board = (
    <div className="relative" style={{ width: `${timelineZoomWidthPct(zoom)}%` }}>
      <div
        className="relative h-5 border-b border-border-strong text-3xs text-muted"
        data-testid="timeline-axis"
        aria-hidden="true"
      >
        {ticks.map((tick) => (
          <span
            key={tick.label}
            className="absolute -translate-x-1/2 whitespace-nowrap"
            style={{ left: `${tick.pct}%` }}
          >
            {tick.label}
          </span>
        ))}
      </div>
      <div ref={boardRef} className="relative" style={{ height }}>
        <div className="pointer-events-none absolute inset-0" aria-hidden="true">
          {ticks.map((tick) => (
            <div
              key={tick.label}
              className="absolute top-0 bottom-0 border-l border-border"
              style={{ left: `${tick.pct}%` }}
            />
          ))}
          {laneGuides.map((offset) => (
            <div
              key={offset}
              className="absolute left-0 right-0 border-t border-border-strong"
              style={{ top: offset }}
            />
          ))}
          <div
            className="absolute top-0 bottom-0 w-px bg-danger"
            style={{ left: `${todayPct}%` }}
            data-testid="timeline-today"
          />
        </div>
        {edges && edges.length > 0 && (
          <svg
            className="pointer-events-none absolute inset-0 h-full w-full overflow-visible text-muted"
            viewBox={`0 0 ${TIMELINE_WIDTH} ${height}`}
            preserveAspectRatio="none"
            aria-hidden="true"
            data-testid="timeline-arrows"
          >
            {edges.map((edge) => {
              const route = routeById.get(edge.id);
              const fromBar = barById.get(edge.from);
              const toBar = barById.get(edge.to);
              if (!route || !fromBar || !toBar) return null;
              // The entered target face orients the arrowhead even when the
              // router had to detour the path around both bars.
              const { target } = pickSides(fromBar, toBar);
              const tip = route.path.end;
              const head =
                target === "left"
                  ? `${tip.x},${tip.y} ${tip.x - 8},${tip.y - 4} ${tip.x - 8},${tip.y + 4}`
                  : `${tip.x},${tip.y} ${tip.x + 8},${tip.y - 4} ${tip.x + 8},${tip.y + 4}`;
              return (
                <g key={edge.id} data-testid={`timeline-edge-${edge.id}`}>
                  <path
                    d={arrowPathD(route.path)}
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={1.5}
                    vectorEffect="non-scaling-stroke"
                  />
                  <polygon points={head} fill="currentColor" />
                </g>
              );
            })}
          </svg>
        )}
        {bars.map((bar) => {
          const range = currentRange(bar);
          const layout = rangeToPercent(range, dragBounds.min, dragBounds.max);
          const rangeLabel = timelineTooltipLabel(
            new Date(range.start).toISOString(),
            new Date(range.end).toISOString(),
          );
          const boundMinDay = Math.floor(dragBounds.min / MS_PER_DAY);
          const boundMaxDay = Math.floor(dragBounds.max / MS_PER_DAY);
          const startDay = Math.floor(range.start / MS_PER_DAY);
          const endDay = Math.floor(range.end / MS_PER_DAY);
          const dragging = draggingRow === bar.rowId;
          const handleOffset = TIMELINE_HANDLE_WIDTH / 2;
          return (
            <div
              key={bar.rowId}
              className="absolute left-0 right-0"
              style={{ top: yFor(bar.rowId), height: BAR_HEIGHT }}
            >
              <Tooltip label={rangeLabel} side="top">
                <Link
                  href={`/w/${workspaceSlug}/${bar.rowId}`}
                  draggable={false}
                  role="slider"
                  tabIndex={editable ? 0 : -1}
                  aria-disabled={!editable}
                  aria-orientation="horizontal"
                  aria-label={`${t(locale, "timelineMoveItem")}: ${bar.title}`}
                  aria-valuemin={boundMinDay}
                  aria-valuemax={boundMaxDay}
                  aria-valuenow={startDay}
                  aria-valuetext={rangeLabel}
                  data-testid={`timeline-bar-${bar.rowId}`}
                  onPointerDown={editable ? (event) => beginDrag(event, bar, "move") : undefined}
                  onKeyDown={editable ? (event) => moveBarKeys(event, bar) : undefined}
                  className={cn(
                    "focus-ring u-interactive flex h-full cursor-grab touch-none select-none items-center truncate rounded-sm bg-action/70 px-2 text-xs text-action-fg hover:-translate-y-0.5 hover:bg-action active:cursor-grabbing",
                    dragging && "u-no-transition",
                  )}
                  style={{
                    marginLeft: `${layout.offsetPct}%`,
                    width: `${layout.widthPct}%`,
                  }}
                >
                  {bar.title}
                </Link>
              </Tooltip>
              <Tooltip
                label={`${t(locale, "timelineResizeStart")}: ${bar.title}`}
                side="top"
              >
                <button
                  type="button"
                  role="slider"
                  aria-disabled={!editable}
                  aria-orientation="horizontal"
                  aria-label={`${t(locale, "timelineResizeStart")}: ${bar.title}`}
                  aria-valuemin={boundMinDay}
                  aria-valuemax={endDay}
                  aria-valuenow={startDay}
                  aria-valuetext={rangeLabel}
                  data-testid={`timeline-resize-start-${bar.rowId}`}
                  onPointerDown={editable ? (event) => beginDrag(event, bar, "start") : undefined}
                  onKeyDown={editable ? (event) => resizeBarKeys(event, bar, "start") : undefined}
                  className={cn(
                    "focus-ring absolute inset-y-0 cursor-ew-resize touch-none rounded-s-sm bg-transparent hover:bg-accent-fg/40",
                    dragging && "u-no-transition",
                  )}
                  style={{
                    left: `calc(${layout.offsetPct}% - ${handleOffset}px)`,
                    width: TIMELINE_HANDLE_WIDTH,
                  }}
                />
              </Tooltip>
              <Tooltip
                label={`${t(locale, "timelineResizeEnd")}: ${bar.title}`}
                side="top"
              >
                <button
                  type="button"
                  role="slider"
                  aria-disabled={!editable}
                  aria-orientation="horizontal"
                  aria-label={`${t(locale, "timelineResizeEnd")}: ${bar.title}`}
                  aria-valuemin={startDay}
                  aria-valuemax={boundMaxDay}
                  aria-valuenow={endDay}
                  aria-valuetext={rangeLabel}
                  data-testid={`timeline-resize-end-${bar.rowId}`}
                  onPointerDown={editable ? (event) => beginDrag(event, bar, "end") : undefined}
                  onKeyDown={editable ? (event) => resizeBarKeys(event, bar, "end") : undefined}
                  className={cn(
                    "focus-ring absolute inset-y-0 cursor-ew-resize touch-none rounded-e-sm bg-transparent hover:bg-accent-fg/40",
                    dragging && "u-no-transition",
                  )}
                  style={{
                    left: `calc(${layout.offsetPct + layout.widthPct}% - ${handleOffset}px)`,
                    width: TIMELINE_HANDLE_WIDTH,
                  }}
                />
              </Tooltip>
            </div>
          );
        })}
      </div>
    </div>
  );

  return (
    <div className="rounded-lg border border-border p-4">
      {header}
      <div className="mb-3 flex justify-end">
        <Segmented
          size="sm"
          options={zoomOptions}
          value={String(zoom)}
          onValueChange={(value) => {
            const next = Number(value);
            if ((TIMELINE_ZOOM_LEVELS as readonly number[]).includes(next)) {
              setZoom(next);
            }
          }}
          ariaLabel={TIMELINE_ZOOM_LABEL}
        />
      </div>
      <div className="overflow-x-auto scrollbar-thin">{board}</div>
    </div>
  );
}

/* --------------------------------------------------------------------------- */
/* Chart view                                                                  */
/* --------------------------------------------------------------------------- */

/** Resolve a category label back to its stored tag hue. */
function chartHueFor(
  groupProperty: DBProperty,
  label: string,
): TagHue {
  const color = groupProperty.config?.options?.find(
    (option) => option.name === label,
  )?.color;
  return isTagHue(color) ? color : "gray";
}

/** Tag chips: the chart legend, in the shared palette. */
function ChartLegend({
  labels,
  values,
  hueFor,
}: {
  labels: string[];
  values?: (number | null)[];
  hueFor: (label: string) => TagHue;
}) {
  return (
    <ul
      className="mt-3 flex flex-wrap items-center gap-2"
      data-testid="chart-legend"
    >
      {labels.map((label, index) => (
        <li key={`${label}-${index}`}>
          <Tag hue={hueFor(label)} dot size="sm">
            {values ? chartTooltipLabel(label, values[index] ?? null) : label}
          </Tag>
        </li>
      ))}
    </ul>
  );
}

export function ChartView({
  properties,
  rows,
  locale,
  groupByPropertyId,
  chartType = "bar",
  aggregateFn = "count",
  valuePropertyId,
  sortCategories,
  showEmpty,
  limitSlices,
  loading = false,
}: {
  properties: DBProperty[];
  rows: DBRow[];
  locale: string;
  /** Group-by property (defaults to the first status/select/multi-select). */
  groupByPropertyId?: string | null;
  /** Chart shape; bar/line read `{ categories, series }`, pie/donut `{ slices }`. */
  chartType?: ChartType;
  /** Aggregation applied per group (defaults to a row count). */
  aggregateFn?: AggregationFn;
  /** Cell the aggregation reads (e.g. a NUMBER property for sums). */
  valuePropertyId?: string | null;
  /** Order categories/slices by aggregated value. */
  sortCategories?: "asc" | "desc";
  /** Include the "Empty" bucket of rows missing the group-by value. */
  showEmpty?: boolean;
  /** Keep the N largest slices and bucket the rest into "Other". */
  limitSlices?: ChartLimitOptions;
  /** Render the loading skeleton (matching the final layout). */
  loading?: boolean;
}) {
  if (loading) return <ChartSkeleton />;

  const preferred = groupByPropertyId
    ? properties.find((p) => p.id === groupByPropertyId)
    : undefined;
  const groupProperty =
    preferred ??
    properties.find(
      (p) => p.type === "STATUS" || p.type === "SELECT" || p.type === "MULTI_SELECT",
    );
  if (!groupProperty) {
    return (
      <div className="rounded-lg border border-dashed border-border">
        <EmptyState
          variant="compact"
          icon={<BarChart3 className="size-4" />}
          title={t(locale, "chartNeedsSelect")}
          description={t(locale, "dbNoRowsHint")}
        />
      </div>
    );
  }

  const config: ChartConfig = {
    type: chartType,
    groupByPropertyId: groupProperty.id,
    aggregateFn,
    ...(valuePropertyId ? { valuePropertyId } : {}),
    ...(sortCategories ? { sortCategories } : {}),
    ...(showEmpty === undefined ? {} : { showEmpty }),
    ...(limitSlices ? { limitSlices } : {}),
  };
  const series = buildChartSeries(
    rows as unknown as QueryRow[],
    config,
    properties as unknown as ChartProperty[],
  );

  /** Tag hue for a category/slice, resolved through the option names. */
  const hueFor = (label: string): TagHue => chartHueFor(groupProperty, label);

  const empty = (
    <EmptyState
      variant="compact"
      icon={<BarChart3 className="size-4" />}
      title={t(locale, "noDataYet")}
      description={t(locale, "dbNoRowsHint")}
    />
  );

  return (
    <div className="rounded-lg border border-border p-5">
      <p className="mb-4 text-sm font-medium">
        {t(locale, "rowsBy")} {groupProperty.name}
      </p>
      {"categories" in series ? (
        series.categories.length === 0 ? (
          empty
        ) : chartType === "line" ? (
          <LineChart
            categories={series.categories}
            values={series.series[0]?.values ?? []}
            hueFor={hueFor}
          />
        ) : (
          <BarChart
            categories={series.categories}
            values={series.series[0]?.values ?? []}
            hueFor={hueFor}
          />
        )
      ) : series.slices.length === 0 ? (
        empty
      ) : (
        <PieChart
          slices={series.slices}
          hueFor={hueFor}
          donut={chartType === "donut"}
        />
      )}
    </div>
  );
}

/** Horizontal bars: one row per category, width proportional to the value. */
function BarChart({
  categories,
  values,
  hueFor,
}: {
  categories: string[];
  values: (number | null)[];
  hueFor: (label: string) => TagHue;
}) {
  const { mounted, reduced } = useChartMount();
  const max = chartBarMax(values);
  return (
    <div className="space-y-3" data-testid="chart-bar">
      {categories.map((label, index) => {
        const value = values[index] ?? null;
        const motion = chartItemMotion(index, mounted, reduced);
        return (
          <Tooltip key={`${label}-${index}`} label={chartTooltipLabel(label, value)}>
            <div
              className={cn("flex items-center gap-3 text-sm", motion.className)}
              style={motion.style}
            >
              <span className="w-32 shrink-0 truncate text-muted">{label}</span>
              <div className="h-4 flex-1 rounded-sm bg-surface">
                <div
                  className="h-4 rounded-sm"
                  style={{
                    width: `${chartBarWidthPct(value, max)}%`,
                    backgroundColor: chartInk(hueFor(label)),
                  }}
                />
              </div>
              <span className="w-8 shrink-0 text-right tabular-nums text-muted">
                {formatChartValue(value)}
              </span>
            </div>
          </Tooltip>
        );
      })}
    </div>
  );
}

/** A point marker overlaid on the line, with the exact value on hover. */
function LineChart({
  categories,
  values,
  hueFor,
}: {
  categories: string[];
  values: (number | null)[];
  hueFor: (label: string) => TagHue;
}) {
  const { mounted, reduced } = useChartMount();
  const points = linePointCoords(values);
  const polyline = points.map((point) => `${point.x},${point.y}`).join(" ");
  return (
    <div data-testid="chart-line">
      <div className="relative h-40">
        <svg
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          className="absolute inset-0 h-full w-full text-accent"
          aria-hidden="true"
        >
          <polyline
            points={polyline}
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            vectorEffect="non-scaling-stroke"
          />
        </svg>
        {points.map((point, index) => {
          const motion = chartItemMotion(index, mounted, reduced);
          return (
            <Tooltip
              key={`${categories[index]}-${index}`}
              label={chartTooltipLabel(categories[index], values[index] ?? null)}
              side="top"
            >
              <button
                type="button"
                aria-label={chartTooltipLabel(categories[index], values[index] ?? null)}
                className={cn(
                  "focus-ring absolute h-2 w-2 rounded-full before:absolute before:-inset-1.5 before:content-['']",
                  motion.className,
                )}
                style={{
                  left: `calc(${point.x}% - 4px)`,
                  top: `calc(${point.y}% - 4px)`,
                  backgroundColor: chartInk(hueFor(categories[index])),
                  ...motion.style,
                }}
              />
            </Tooltip>
          );
        })}
      </div>
      <div className="mt-1 flex text-3xs text-muted">
        {categories.map((label, index) => (
          <span
            key={`${label}-${index}`}
            className="min-w-0 flex-1 truncate text-center"
          >
            {label}
          </span>
        ))}
      </div>
      <ChartLegend labels={categories} values={values} hueFor={hueFor} />
    </div>
  );
}

/** Pie/donut from SVG circle arcs (`stroke-dasharray`), no chart library. */
function PieChart({
  slices,
  hueFor,
  donut,
}: {
  slices: { label: string; value: number }[];
  hueFor: (label: string) => TagHue;
  donut: boolean;
}) {
  const { mounted, reduced } = useChartMount();
  const radius = donut ? 35 : 50;
  const { total, circumference, arcs } = pieSliceArcs(slices, radius);
  return (
    <div className="flex flex-wrap items-center gap-6" data-testid="chart-pie">
      <svg viewBox="0 0 100 100" className="h-40 w-40 -rotate-90">
        <circle
          cx="50"
          cy="50"
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth={donut ? 25 : 100}
          className="text-surface"
        />
        {arcs.map((arc, index) => {
          const motion = chartItemMotion(index, mounted, reduced);
          return (
            <Tooltip
              key={arc.label}
              label={chartSliceTooltipLabel(arc.label, arc.value, total)}
              side="top"
            >
              <circle
                cx="50"
                cy="50"
                r={radius}
                fill="none"
                stroke={chartInk(hueFor(arc.label))}
                strokeWidth={donut ? 25 : 100}
                strokeDasharray={`${arc.dash} ${circumference - arc.dash}`}
                strokeDashoffset={arc.offset}
                className={motion.className}
                style={motion.style}
              />
            </Tooltip>
          );
        })}
      </svg>
      <ChartLegend labels={slices.map((slice) => slice.label)} hueFor={hueFor} />
    </div>
  );
}

/* --------------------------------------------------------------------------- */
/* Calendar view                                                               */
/* --------------------------------------------------------------------------- */

/**
 * Month/week calendar with multi-day span lanes.
 *
 * A row whose DATE value covers `[start, end)` draws one bar across every day it
 * touches, packed into non-overlapping lanes per week by the pure
 * `@/lib/calendar-multiday` engine (`monthGrid`/`weekGrid` + `placeEvents`).
 * Week rows include spill days from the neighbouring months, today is
 * emphasised from `--accent`, and a bar crossing a week edge keeps a square end
 * (`continuesBefore` / `continuesAfter`) while its inner end stays rounded.
 * Bars past `CALENDAR_MAX_LANES` collapse into a `+N` badge. The scale switch
 * (month/week) and the actionable "needs a date" empty state are new.
 */
export function CalendarView({
  locale,
  workspaceSlug,
  properties,
  rows,
  valueFor,
  loading = false,
}: {
  locale: string;
  workspaceSlug: string;
  properties: DBProperty[];
  rows: DBRow[];
  valueFor: (row: DBRow, propertyId: string) => unknown;
  /** Render the loading skeleton (matching the final layout). */
  loading?: boolean;
}) {
  const today = new Date();
  const todayDayIndex = Math.floor(
    Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()) / MS_PER_DAY,
  );
  const [anchor, setAnchor] = useState(todayDayIndex);
  const [scale, setScale] = useState<"month" | "week">("month");

  if (loading) return <CalendarSkeleton />;

  const dateProperty = properties.find((p) => p.type === "DATE");
  const anchorDate = new Date(anchor * MS_PER_DAY);
  const year = anchorDate.getUTCFullYear();
  const month = anchorDate.getUTCMonth();
  const monthView = monthGrid(year, month, { weekStartsOn: 0 });
  const weekView = weekGrid(anchor, 0);
  const grid = scale === "month" ? monthView : weekView;

  const goToday = () => setAnchor(todayDayIndex);
  const shift = (delta: number) => {
    if (scale === "week") {
      setAnchor((current) => current + delta * 7);
      return;
    }
    const next = new Date(Date.UTC(year, month + delta, 1));
    setAnchor(Math.floor(next.getTime() / MS_PER_DAY));
  };

  const isToday = (day: CalendarDay): boolean =>
    day.year === today.getFullYear() &&
    day.month === today.getMonth() &&
    day.date === today.getDate();

  const weekdayKeys = [
    ...WEEKDAY_KEYS.slice(grid.weekStartsOn),
    ...WEEKDAY_KEYS.slice(0, grid.weekStartsOn),
  ];

  const scaleOptions = [
    {
      value: "month" as const,
      label: monthShortLabel(year, month, locale),
      icon: <CalendarDays className="size-3.5" />,
    },
    {
      value: "week" as const,
      label: weekRangeLabel(weekView.days, locale),
      icon: <Columns3 className="size-3.5" />,
    },
  ];

  const header = (
    <div className="mb-3 flex items-center justify-between gap-2">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => shift(-1)}
          aria-label={t(locale, "previousMonth")}
          className="focus-ring u-colors rounded-control px-2 py-0.5 text-muted hover:bg-surface-2 hover:text-fg"
        >
          ‹
        </button>
        <span className="text-sm font-medium">
          {calendarMonthLabel(grid.year, grid.month)}
        </span>
        <button
          type="button"
          onClick={() => shift(1)}
          aria-label={t(locale, "nextMonth")}
          className="focus-ring u-colors rounded-control px-2 py-0.5 text-muted hover:bg-surface-2 hover:text-fg"
        >
          ›
        </button>
      </div>
      <div className="flex items-center gap-2">
        <Segmented
          size="sm"
          options={scaleOptions}
          value={scale}
          onValueChange={setScale}
          ariaLabel={CALENDAR_SCALE_LABEL}
        />
        <button
          type="button"
          onClick={goToday}
          aria-label={t(locale, "todayWord")}
          className="focus-ring u-colors text-xs text-muted hover:text-fg"
        >
          {t(locale, "todayWord")}
        </button>
      </div>
    </div>
  );

  if (!dateProperty) {
    return (
      <div>
        {header}
        <div className="rounded-lg border border-dashed border-border">
          <EmptyState
            variant="full"
            icon={<CalendarDays className="size-5" />}
            title={t(locale, "calendarNeedsDate")}
            description={t(locale, "dbNoRowsHint")}
            primaryAction={
              <button
                type="button"
                onClick={goToday}
                aria-label={t(locale, "todayWord")}
                className="focus-ring u-interactive rounded-control bg-action px-3 py-1 text-xs font-medium text-action-fg hover:opacity-90"
              >
                {t(locale, "todayWord")}
              </button>
            }
          />
        </div>
      </div>
    );
  }

  // Project every dated row onto a half-open `[start, end)` ms span. A missing
  // or non-positive `end` becomes a single-day event, matching `timelineData`.
  const events: CalendarRowEvent[] = [];
  for (const row of rows) {
    const value = valueFor(row, dateProperty.id) as
      | { start?: string; end?: string }
      | undefined;
    if (!value?.start) continue;
    const start = Date.parse(value.start);
    if (Number.isNaN(start)) continue;
    const parsedEnd = value.end ? Date.parse(value.end) : Number.NaN;
    const end =
      Number.isNaN(parsedEnd) || parsedEnd <= start
        ? start + MS_PER_DAY
        : parsedEnd;
    events.push({
      id: row.id,
      start,
      end,
      title: row.title || t(locale, "untitled"),
    });
  }

  const layout = placeEvents(grid, events, { maxLanes: CALENDAR_MAX_LANES });

  return (
    <div>
      {header}

      <div
        className="overflow-hidden rounded-lg border border-border"
        data-testid="calendar-grid"
      >
        <div className="grid grid-cols-7 bg-surface text-xs font-medium text-muted">
          {weekdayKeys.map((key) => (
            <div key={key} className="px-2 py-1">
              {t(locale, key)}
            </div>
          ))}
        </div>
        {layout.weeks.map((week) => (
          <div
            key={week.days[0].key}
            className="relative grid grid-cols-7 border-t border-border"
            style={{ minHeight: calendarWeekRowHeight(week.laneCount) }}
          >
            {week.days.map((day) => (
              <div
                key={day.key}
                tabIndex={-1}
                data-today={isToday(day) ? "true" : undefined}
                className={cn(
                  "focus-ring u-colors border-r border-border p-1.5 text-xs last:border-r-0",
                  day.inMonth
                    ? "bg-bg hover:bg-surface-2"
                    : "bg-surface/40 text-muted hover:bg-surface-2",
                )}
              >
                <div
                  className={cn(
                    "grid h-5 w-5 place-items-center rounded-full tabular-nums",
                    isToday(day)
                      ? "bg-action font-semibold text-action-fg"
                      : "text-muted",
                  )}
                >
                  {day.date}
                </div>
              </div>
            ))}
            {week.placements.map((placement) => (
              <Tooltip
                key={`${placement.event.id}-${placement.startCol}`}
                label={placement.event.title}
                side="top"
              >
                <Link
                  href={`/w/${workspaceSlug}/${placement.event.id}`}
                  className={cn(
                    "focus-ring u-colors absolute flex h-4 items-center truncate border px-1.5 text-2xs hover:opacity-90",
                    placement.continuesBefore ? "rounded-l-none" : "rounded-l-sm",
                    placement.continuesAfter ? "rounded-r-none" : "rounded-r-sm",
                  )}
                  style={{
                    ...tagStyle(calendarEventHue(placement.event.id)),
                    top: calendarBarTop(placement.lane),
                    left: `${calendarBarLeftPct(placement.startCol)}%`,
                    width: `calc(${calendarBarWidthPct(placement.span)}% - 2px)`,
                  }}
                >
                  {placement.event.title}
                </Link>
              </Tooltip>
            ))}
            {week.hiddenCount > 0 && (
              <span className="absolute bottom-0.5 right-1 text-3xs text-muted">
                +{week.hiddenCount}
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
