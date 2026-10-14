"use client";

import Link from "next/link";
import {
  timelineData,
  type QueryProperty,
  type QueryRow,
} from "@/lib/database-query";
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
import { OPTION_COLORS, type DBProperty, type DBRow } from "@/components/database/database-types";
import { stableTime } from "@/lib/time";
import { t } from "@/lib/i18n";

/**
 * Timeline and chart views for a database.
 *
 * Extracted from `database-view.tsx` (docs/FIX_PLAN.md P3) so the file that owns
 * the table/board/list renderers keeps shrinking toward a testable size. The
 * chart body is now built by the pure `@/lib/charts` engine and the timeline can
 * stroke dependency arrows routed by `@/lib/dependency-arrows`.
 */

/** Vertical pitch of one timeline row, in px — shared by the bars and arrows. */
const ROW_PITCH = 44;
/** Height of one timeline bar, in px. */
const BAR_HEIGHT = 18;
/** Horizontal coordinate space the bars (and arrows) are laid out in. */
const TIMELINE_WIDTH = 1000;

/** Turn an orthogonal arrow into an SVG `d` attribute. */
function arrowPathD(path: ArrowPath): string {
  return [path.start, ...path.points, path.end]
    .map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`)
    .join(" ");
}

export function TimelineView({
  workspaceSlug,
  properties,
  rows,
  locale,
  edges,
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
}) {
  const dateProperty = properties.find((p) => p.type === "DATE");
  if (!dateProperty) {
    return (
      <p className="rounded-lg border border-dashed border-border px-4 py-10 text-center text-sm text-muted">
        {t(locale, "timelineNeedsDate")}
      </p>
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

  // Bars are laid out in the same abstract space the arrow router expects:
  // x spans 0…TIMELINE_WIDTH (mapped across the container) and y runs in px.
  const barRects: BarRect[] = bars.map((bar, index) => ({
    id: bar.rowId,
    x: (bar.offsetPct / 100) * TIMELINE_WIDTH,
    y: index * ROW_PITCH + (ROW_PITCH - BAR_HEIGHT) / 2,
    width: Math.max(1, (bar.widthPct / 100) * TIMELINE_WIDTH),
    height: BAR_HEIGHT,
  }));
  const barById = new Map(barRects.map((bar) => [bar.id, bar]));
  const routes =
    edges && edges.length > 0 ? computeEdgeRoutes(barRects, edges) : [];
  const routeById = new Map(routes.map((route) => [route.edgeId, route]));
  const height = Math.max(1, bars.length * ROW_PITCH);

  return (
    <div className="rounded-lg border border-border p-4">
      <div className="mb-3 flex items-center justify-between text-xs text-muted">
        <span>{stableTime(from, "date")}</span>
        <span className="font-medium text-fg">{dateProperty.name}</span>
        <span>{stableTime(to, "date")}</span>
      </div>
      {bars.length === 0 ? (
        <p className="text-sm text-muted">{t(locale, "noDatedRows")}</p>
      ) : (
        <div className="relative" style={{ height }}>
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
          {bars.map((bar, index) => (
            <div
              key={bar.rowId}
              className="absolute left-0 right-0"
              style={{ top: index * ROW_PITCH, height: BAR_HEIGHT }}
            >
              <Link
                href={`/w/${workspaceSlug}/${bar.rowId}`}
                className="flex h-full items-center truncate rounded bg-accent/70 px-2 text-xs text-accent-fg hover:bg-accent"
                style={{
                  marginLeft: `${bar.offsetPct}%`,
                  width: `${bar.widthPct}%`,
                }}
                title={`${bar.startISO.slice(0, 10)} → ${bar.endISO.slice(0, 10)}`}
              >
                {bar.title}
              </Link>
            </div>
          ))}
        </div>
      )}
    </div>
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
}) {
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
      <p className="rounded-lg border border-dashed border-border px-4 py-10 text-center text-sm text-muted">
        {t(locale, "chartNeedsSelect")}
      </p>
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

  /** Palette hex for a category/slice, resolved through the option names. */
  const colorFor = (label: string): string => {
    const color =
      groupProperty.config?.options?.find((option) => option.name === label)?.color ?? "gray";
    return OPTION_COLORS[color] ?? OPTION_COLORS.gray;
  };

  const empty = (
    <p className="text-sm text-muted">{t(locale, "noDataYet")}</p>
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
            colorFor={colorFor}
          />
        ) : (
          <BarChart
            categories={series.categories}
            values={series.series[0]?.values ?? []}
            colorFor={colorFor}
          />
        )
      ) : series.slices.length === 0 ? (
        empty
      ) : (
        <PieChart slices={series.slices} colorFor={colorFor} donut={chartType === "donut"} />
      )}
    </div>
  );
}

/** Horizontal bars: one row per category, width proportional to the value. */
function BarChart({
  categories,
  values,
  colorFor,
}: {
  categories: string[];
  values: (number | null)[];
  colorFor: (label: string) => string;
}) {
  const max = Math.max(1, ...values.map((value) => value ?? 0));
  return (
    <div className="space-y-3" data-testid="chart-bar">
      {categories.map((label, index) => {
        const value = values[index] ?? null;
        return (
          <div key={`${label}-${index}`} className="flex items-center gap-3 text-sm">
            <span className="w-32 shrink-0 truncate text-muted" title={label}>
              {label}
            </span>
            <div className="h-4 flex-1 rounded bg-surface">
              <div
                className="h-4 rounded"
                style={{
                  width: `${Math.max(0, ((value ?? 0) / max) * 100)}%`,
                  backgroundColor: colorFor(label),
                }}
              />
            </div>
            <span className="w-8 shrink-0 text-right text-muted">{value ?? "—"}</span>
          </div>
        );
      })}
    </div>
  );
}

/** A minimal polyline: x spreads the categories, y is the value normalised to max. */
function LineChart({
  categories,
  values,
  colorFor,
}: {
  categories: string[];
  values: (number | null)[];
  colorFor: (label: string) => string;
}) {
  const max = Math.max(1, ...values.map((value) => value ?? 0));
  const step = values.length > 1 ? 100 / (values.length - 1) : 0;
  const points = values
    .map((value, index) => `${index * step},${100 - ((value ?? 0) / max) * 100}`)
    .join(" ");
  return (
    <div data-testid="chart-line">
      <svg
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        className="h-40 w-full text-accent"
        aria-hidden="true"
      >
        <polyline
          points={points}
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <div className="mt-1 flex text-[10px] text-muted">
        {categories.map((label, index) => (
          <span key={`${label}-${index}`} className="min-w-0 flex-1 truncate text-center">
            {label}
          </span>
        ))}
      </div>
      <div className="mt-2 flex flex-wrap gap-2 text-xs text-muted">
        {categories.map((label, index) => (
          <span key={`${label}-${index}`} className="flex items-center gap-1">
            <span
              className="inline-block h-2 w-2 rounded-sm"
              style={{ backgroundColor: colorFor(label) }}
            />
            {label}: {values[index] ?? "—"}
          </span>
        ))}
      </div>
    </div>
  );
}

/** Pie/donut from SVG circle arcs (`stroke-dasharray`), no chart library. */
function PieChart({
  slices,
  colorFor,
  donut,
}: {
  slices: { label: string; value: number }[];
  colorFor: (label: string) => string;
  donut: boolean;
}) {
  const total = slices.reduce((sum, slice) => sum + slice.value, 0);
  const radius = donut ? 35 : 50;
  const circumference = 2 * Math.PI * radius;
  let consumed = 0;
  return (
    <div className="flex flex-wrap items-center gap-6" data-testid="chart-pie">
      <svg viewBox="0 0 100 100" className="h-40 w-40 -rotate-90">
        <circle cx="50" cy="50" r={radius} fill="none" stroke="currentColor" strokeWidth={donut ? 25 : 100} className="text-surface" />
        {slices.map((slice) => {
          const fraction = total > 0 ? slice.value / total : 0;
          const dash = fraction * circumference;
          const circle = (
            <circle
              key={slice.label}
              cx="50"
              cy="50"
              r={radius}
              fill="none"
              stroke={colorFor(slice.label)}
              strokeWidth={donut ? 25 : 100}
              strokeDasharray={`${dash} ${circumference - dash}`}
              strokeDashoffset={-consumed}
            />
          );
          consumed += dash;
          return circle;
        })}
      </svg>
      <ul className="space-y-1 text-xs text-muted">
        {slices.map((slice) => (
          <li key={slice.label} className="flex items-center gap-2">
            <span
              className="inline-block h-2.5 w-2.5 rounded-sm"
              style={{ backgroundColor: colorFor(slice.label) }}
            />
            <span className="truncate">{slice.label}</span>
            <span className="ml-auto font-medium text-fg">{slice.value}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
