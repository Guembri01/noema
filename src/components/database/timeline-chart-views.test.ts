import { describe, expect, it } from "vitest";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { MS_PER_DAY } from "@/lib/calendar-multiday";
import { TAG_HUES } from "@/lib/design-tokens";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  CALENDAR_LANE_HEIGHT,
  CALENDAR_ROW_PAD,
  CHART_STAGGER_MAX_STEPS,
  CHART_STAGGER_MS,
  TIMELINE_ZOOM_LEVELS,
  CalendarView,
  ChartView,
  TimelineView,
  calendarBarLeftPct,
  calendarBarTop,
  calendarBarWidthPct,
  calendarEventHue,
  calendarWeekRowHeight,
  chartBarMax,
  chartBarWidthPct,
  chartInk,
  chartItemMotion,
  chartSliceTooltipLabel,
  chartStaggerDelay,
  chartTooltipLabel,
  formatChartValue,
  linePointCoords,
  monthShortLabel,
  pieCircumference,
  pieSliceArcs,
  timelineBarOffset,
  timelineBarWidth,
  timelineHeight,
  timelineLaneGuides,
  timelineLaneY,
  timelineTickPct,
  timelineTooltipLabel,
  timelineZoomWidthPct,
  weekGrid,
  weekRangeLabel,
} from "./timeline-chart-views";
import type { DBProperty, DBRow } from "./database-types";

/**
 * dz03 — the pure geometry/animation maps behind Timeline, Chart and Calendar,
 * plus a `renderToStaticMarkup` pass over each view's empty state and one
 * rendered series. No DOM, no clock: the render assertions only read structure
 * and token values.
 */

/* -------------------------------------------------------------------------- */
/* Pure maps                                                                   */
/* -------------------------------------------------------------------------- */

describe("timeline geometry", () => {
  it("maps a bar onto the shared coordinate space", () => {
    expect(timelineBarOffset(0)).toBe(0);
    expect(timelineBarOffset(50)).toBe(500);
    expect(timelineBarOffset(100)).toBe(1000);
    expect(timelineBarWidth(10)).toBe(100);
    expect(timelineBarWidth(100)).toBe(1000);
    // A sliver never collapses to zero pixels.
    expect(timelineBarWidth(0)).toBe(1);
  });

  it("packs lanes on the row pitch", () => {
    expect(timelineLaneY(0)).toBe(13);
    expect(timelineLaneY(1)).toBe(57);
    expect(timelineHeight(0)).toBe(44);
    expect(timelineHeight(3)).toBe(132);
    expect(timelineLaneGuides(3)).toEqual([44, 88]);
    expect(timelineLaneGuides(1)).toEqual([]);
    expect(timelineLaneGuides(0)).toEqual([]);
  });

  it("positions ticks and the zoom width by percent", () => {
    expect(timelineTickPct(250, 0, 1000)).toBe(25);
    expect(timelineTickPct(0, 0, 0)).toBe(0);
    expect(timelineZoomWidthPct(1)).toBe(100);
    expect(timelineZoomWidthPct(2)).toBe(200);
    expect(timelineZoomWidthPct(4)).toBe(400);
    expect(timelineZoomWidthPct(0)).toBe(100);
    expect([...TIMELINE_ZOOM_LEVELS]).toEqual([1, 2, 4]);
  });

  it("formats the exact bar span for the tooltip", () => {
    expect(
      timelineTooltipLabel(
        "2026-03-09T00:00:00.000Z",
        "2026-03-11T00:00:00.000Z",
      ),
    ).toBe("2026-03-09 → 2026-03-11");
  });
});

describe("chart geometry", () => {
  it("scales a bar against the largest value", () => {
    expect(chartBarMax([3, 5, null])).toBe(5);
    expect(chartBarMax([])).toBe(1);
    expect(chartBarMax([null, -2])).toBe(1);
    expect(chartBarWidthPct(5, 10)).toBe(50);
    expect(chartBarWidthPct(0, 10)).toBe(0);
    expect(chartBarWidthPct(null, 10)).toBe(0);
  });

  it("lays the line points out in a 0..100 box", () => {
    expect(linePointCoords([0, 10, 5])).toEqual([
      { x: 0, y: 100 },
      { x: 50, y: 0 },
      { x: 100, y: 50 },
    ]);
    expect(linePointCoords([5])).toEqual([{ x: 0, y: 0 }]);
  });

  it("splits a pie into cumulative arcs", () => {
    const radius = 100 / (2 * Math.PI); // circumference 100, easy to read.
    expect(pieCircumference(radius)).toBeCloseTo(100, 6);
    const { total, arcs } = pieSliceArcs(
      [
        { label: "A", value: 1 },
        { label: "B", value: 3 },
      ],
      radius,
    );
    expect(total).toBe(4);
    expect(arcs[0].fraction).toBeCloseTo(0.25, 6);
    expect(arcs[0].dash).toBeCloseTo(25, 6);
    expect(arcs[0].offset).toBeCloseTo(0, 6);
    expect(arcs[1].fraction).toBeCloseTo(0.75, 6);
    expect(arcs[1].dash).toBeCloseTo(75, 6);
    expect(arcs[1].offset).toBeCloseTo(-25, 6);
  });

  it("formats exact values and labels for tooltips", () => {
    expect(formatChartValue(null)).toBe("—");
    expect(formatChartValue(0)).toBe("0");
    expect(formatChartValue(3)).toBe("3");
    expect(chartTooltipLabel("To do", 3)).toBe("To do: 3");
    expect(chartTooltipLabel("Done", null)).toBe("Done: —");
    expect(chartSliceTooltipLabel("A", 1, 4)).toBe("A: 1 (25%)");
    expect(chartSliceTooltipLabel("A", 1, 0)).toBe("A: 1 (0%)");
  });

  it("paints marks from tag tokens, never a hex", () => {
    expect(chartInk("blue")).toBe("var(--tag-blue-fg)");
    expect(chartInk("gray")).toBe("var(--tag-gray-fg)");
  });
});

describe("chart mount animation", () => {
  it("stagger-delays each item by at most 40 ms", () => {
    expect(CHART_STAGGER_MS).toBe(40);
    expect(chartStaggerDelay(0)).toBe(0);
    expect(chartStaggerDelay(1)).toBe(40);
    expect(chartStaggerDelay(3)).toBe(120);
    expect(chartStaggerDelay(2.9)).toBe(80);
    expect(chartStaggerDelay(CHART_STAGGER_MAX_STEPS)).toBe(
      CHART_STAGGER_MAX_STEPS * CHART_STAGGER_MS,
    );
    // Capped, so a long series never queues a slow reveal.
    expect(chartStaggerDelay(99)).toBe(CHART_STAGGER_MAX_STEPS * CHART_STAGGER_MS);
    expect(chartStaggerDelay(-1)).toBe(0);
    expect(chartStaggerDelay(Number.NaN)).toBe(0);
  });

  it("hides before mount, then transitions on transform/opacity tokens", () => {
    const before = chartItemMotion(0, false, false);
    expect(before.style).toBeUndefined();
    expect(before.className).toContain("opacity-0");
    expect(before.className).toContain("translate-y-1");
    expect(before.className).toContain("motion-reduce:opacity-100");

    const after = chartItemMotion(2, true, false);
    expect(after.className).toContain("opacity-100");
    expect(after.style?.transitionProperty).toBe("opacity, transform");
    expect(after.style?.transitionDuration).toBe("var(--dur-2)");
    expect(after.style?.transitionTimingFunction).toBe("var(--ease-smooth)");
    expect(after.style?.transitionDelay).toBe("80ms");
  });

  it("skips the animation entirely under reduced motion", () => {
    expect(chartItemMotion(0, false, true)).toEqual({
      className: "",
      style: undefined,
    });
    expect(chartItemMotion(4, true, true)).toEqual({
      className: "",
      style: undefined,
    });
  });
});

describe("calendar geometry", () => {
  it("positions a multi-day bar across its columns", () => {
    expect(calendarBarLeftPct(0)).toBe(0);
    expect(calendarBarLeftPct(3)).toBeCloseTo(100 * (3 / 7), 6);
    expect(calendarBarWidthPct(1)).toBeCloseTo(100 / 7, 6);
    expect(calendarBarWidthPct(7)).toBe(100);
    expect(calendarBarTop(0)).toBe(CALENDAR_ROW_PAD);
    expect(calendarBarTop(2)).toBe(CALENDAR_ROW_PAD + 2 * CALENDAR_LANE_HEIGHT);
    expect(calendarWeekRowHeight(0)).toBe(CALENDAR_ROW_PAD + CALENDAR_LANE_HEIGHT + 6);
    expect(calendarWeekRowHeight(2)).toBe(
      CALENDAR_ROW_PAD + 2 * CALENDAR_LANE_HEIGHT + 6,
    );
  });

  it("derives a stable tag hue per event", () => {
    const hue = calendarEventHue("row-1");
    expect(calendarEventHue("row-1")).toBe(hue);
    expect(TAG_HUES).toContain(hue);
    expect(TAG_HUES).toContain(calendarEventHue(""));
  });

  it("builds a single aligned week", () => {
    // 2026-03-09 is a Monday; the Sunday-start week is the 8th…14th.
    const anchor = Date.UTC(2026, 2, 9) / MS_PER_DAY;
    const grid = weekGrid(anchor, 0);
    expect(grid.weeks).toHaveLength(1);
    expect(grid.days).toHaveLength(7);
    expect(grid.weekStartsOn).toBe(0);
    expect(grid.days[0].key).toBe("2026-03-08");
    expect(grid.days[6].key).toBe("2026-03-14");
    expect(grid.days.every((day) => day.inMonth)).toBe(true);
  });

  it("labels the scale switch in the active locale", () => {
    expect(monthShortLabel(2026, 2, "en")).toBe("Mar");
    const anchor = Date.UTC(2026, 2, 9) / MS_PER_DAY;
    const label = weekRangeLabel(weekGrid(anchor, 0).days, "en");
    expect(label).toContain("Mar");
    expect(label).toContain("8");
    expect(label).toContain("14");
  });
});

/* -------------------------------------------------------------------------- */
/* Static tokens-only guard                                                    */
/* -------------------------------------------------------------------------- */

describe("tokens-only source guard", () => {
  const source = readFileSync(
    new URL("./timeline-chart-views.tsx", import.meta.url),
    "utf8",
  );

  it("carries no raw hex, no magic z-index and no ad-hoc ms duration", () => {
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(source).not.toMatch(/\bz-\[\d/);
    expect(source).not.toMatch(/transition[^;]*\d+ms/);
  });
});

/* -------------------------------------------------------------------------- */
/* Render                                                                      */
/* -------------------------------------------------------------------------- */

const dateProperty: DBProperty = { id: "date", name: "Due", type: "DATE", config: null };
const statusProperty: DBProperty = {
  id: "status",
  name: "Status",
  type: "SELECT",
  config: {
    options: [
      { id: "todo", name: "To do", color: "blue" },
      { id: "done", name: "Done", color: "green" },
    ],
  },
};

const now = new Date();
const inThisMonth = new Date(Date.UTC(now.getFullYear(), now.getMonth(), 10)).toISOString();

const rows: DBRow[] = [
  {
    id: "r1",
    title: "Alpha",
    icon: null,
    propertyValues: [
      { propertyId: "date", value: { start: inThisMonth } },
      { propertyId: "status", value: { optionId: "todo" } },
    ],
  },
  {
    id: "r2",
    title: "Beta",
    icon: null,
    propertyValues: [{ propertyId: "status", value: { optionId: "done" } }],
  },
];

const valueFor = (row: DBRow, propertyId: string): unknown =>
  row.propertyValues.find((entry) => entry.propertyId === propertyId)?.value ?? null;

const render = (node: ReactElement) =>
  renderToStaticMarkup(createElement(TooltipProvider, null, node));

describe("TimelineView render", () => {
  it("renders an actionable empty state when there is no date property", () => {
    const html = render(
      createElement(TimelineView, {
        locale: "en",
        workspaceSlug: "w",
        properties: [statusProperty],
        rows,
      }),
    );
    expect(html).toContain('data-empty-state="compact"');
    expect(html).toContain("Timeline view needs a Date property.");
  });

  it("renders lanes, guides, a danger today marker and tooltipped bars", () => {
    const html = render(
      createElement(TimelineView, {
        locale: "en",
        workspaceSlug: "w",
        properties: [dateProperty, statusProperty],
        rows,
      }),
    );
    expect(html).toContain('data-testid="timeline-axis"');
    expect(html).toContain('data-testid="timeline-today"');
    expect(html).toContain("border-border-strong"); // lane guides
    expect(html).toContain("bg-danger"); // today marker token
    expect(html).toContain('data-testid="segmented"'); // zoom control
    // The bar carries a real tooltip label, not a `title`.
    expect(html).toContain("aria-label=");
    expect(html).not.toContain("title=\"2026");
  });

  it("renders a skeleton while loading", () => {
    const html = render(
      createElement(TimelineView, {
        locale: "en",
        workspaceSlug: "w",
        properties: [dateProperty],
        rows,
        loading: true,
      }),
    );
    expect(html).toContain('data-testid="timeline-skeleton"');
  });
});

describe("ChartView render", () => {
  it("renders an empty state when the group-by has no data", () => {
    const html = render(
      createElement(ChartView, {
        locale: "en",
        properties: [statusProperty],
        rows: [],
        groupByPropertyId: "status",
      }),
    );
    expect(html).toContain('data-empty-state="compact"');
    expect(html).toContain("No data yet.");
  });

  it("renders a bar per category with token ink and value tooltips", () => {
    const html = render(
      createElement(ChartView, {
        locale: "en",
        properties: [statusProperty],
        rows,
        groupByPropertyId: "status",
      }),
    );
    expect(html).toContain('data-testid="chart-bar"');
    expect(html).toContain("To do");
    expect(html).toContain("Done");
    expect(html).toContain("var(--tag-blue-fg)");
    expect(html).toContain('aria-label="To do: 1"');
    expect(html).toContain('aria-label="Done: 1"');
  });

  it("renders a line legend as tag chips", () => {
    const html = render(
      createElement(ChartView, {
        locale: "en",
        properties: [statusProperty],
        rows,
        groupByPropertyId: "status",
        chartType: "line",
      }),
    );
    expect(html).toContain('data-testid="chart-line"');
    expect(html).toContain('data-testid="chart-legend"');
    expect(html).toContain("tag tag-blue");
    expect(html).toContain("To do: 1");
  });

  it("renders a skeleton while loading", () => {
    const html = render(
      createElement(ChartView, {
        locale: "en",
        properties: [statusProperty],
        rows,
        groupByPropertyId: "status",
        loading: true,
      }),
    );
    expect(html).toContain('data-testid="chart-skeleton"');
  });
});

describe("CalendarView render", () => {
  it("renders an actionable empty state when there is no date property", () => {
    const html = render(
      createElement(CalendarView, {
        locale: "en",
        workspaceSlug: "w",
        properties: [statusProperty],
        rows,
        valueFor,
      }),
    );
    expect(html).toContain('data-empty-state="full"');
    expect(html).toContain("Calendar view needs a Date property.");
    expect(html).toContain(">Today</button>"); // the primary action
  });

  it("renders multi-day bars from tag tokens and a month/week switch", () => {
    const html = render(
      createElement(CalendarView, {
        locale: "en",
        workspaceSlug: "w",
        properties: [dateProperty, statusProperty],
        rows,
        valueFor,
      }),
    );
    expect(html).toContain('data-testid="calendar-grid"');
    expect(html).toContain("Alpha");
    expect(html).toContain('aria-label="Alpha"'); // real tooltip, not `title`
    expect(html).toContain("var(--tag-");
    expect(html).toContain('data-testid="segmented"');
  });

  it("renders a skeleton while loading", () => {
    const html = render(
      createElement(CalendarView, {
        locale: "en",
        workspaceSlug: "w",
        properties: [dateProperty],
        rows,
        valueFor,
        loading: true,
      }),
    );
    expect(html).toContain('data-testid="calendar-skeleton"');
  });
});
