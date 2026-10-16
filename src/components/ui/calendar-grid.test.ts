import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { monthGrid } from "@/lib/calendar-multiday";
import {
  CalendarGrid,
  LOCALE_WEEK_START,
  WEEKDAY_KEYS,
  calendarMonthLabel,
  clampDayOfMonth,
  dayRangeEdges,
  defaultFocusKey,
  emptyRange,
  isRangePending,
  moveFocusIndex,
  rangeBounds,
  selectDay,
  shiftMonth,
  weekStartsOnForLocale,
  weekdayOrder,
  isoDayOf,
} from "./calendar-grid";

/**
 * Pure-logic + static-render proof for the month-grid *view*.
 *
 * The layout engine (`monthGrid`) is already pinned by
 * `src/lib/calendar-multiday.test.ts`; these tests cover the layer this task
 * adds on top: locale week start, weekday header order, keyboard focus
 * movement, the range-selection state machine and the range/hover edges — plus
 * one `renderToStaticMarkup` pass so the JSX cannot silently regress.
 *
 * Everything is UTC and every "today" is an explicit argument: no assertion
 * depends on the machine's clock or timezone. (18 March 2026 is a Wednesday.)
 */

const NOW_KEY = "2026-03-18";

describe("week start + weekday headers", () => {
  it("maps the app locales to their CLDR week start", () => {
    expect(weekStartsOnForLocale("en")).toBe(0);
    expect(weekStartsOnForLocale("en-US")).toBe(0);
    expect(weekStartsOnForLocale("fr")).toBe(1);
    expect(weekStartsOnForLocale("de-DE")).toBe(1);
    expect(weekStartsOnForLocale("es")).toBe(1);
    expect(weekStartsOnForLocale("ar")).toBe(6);
    // An unknown locale falls back through `Intl.Locale.weekInfo` (or Sunday)
    // but must always be a valid column.
    const unknown = weekStartsOnForLocale("zz");
    expect(Number.isInteger(unknown)).toBe(true);
    expect(unknown).toBeGreaterThanOrEqual(0);
    expect(unknown).toBeLessThanOrEqual(6);
    expect(LOCALE_WEEK_START.en).toBe(0);
  });

  it("rotates the weekday keys to the requested start", () => {
    expect(weekdayOrder(0)).toEqual([...WEEKDAY_KEYS]);
    expect(weekdayOrder(1)[0]).toBe("wdMon");
    expect(weekdayOrder(1)[6]).toBe("wdSun");
    expect(weekdayOrder(6)[0]).toBe("wdSat");
    // Out-of-range values are normalised, never thrown.
    expect(weekdayOrder(7)[0]).toBe("wdSun");
    expect(weekdayOrder(-1)[0]).toBe("wdSat");
  });

  it("agrees with the month grid's first column", () => {
    const grid = monthGrid(2026, 2, { weekStartsOn: 1 });
    expect(grid.weeks[0][0].weekday).toBe(1);
    expect(weekdayOrder(grid.weekStartsOn)[0]).toBe("wdMon");
    // March 1 2026 is a Sunday, so the Monday-first grid opens on 23 Feb and
    // the month's first day closes the row.
    expect(grid.weeks[0][0].key).toBe("2026-02-23");
    expect(grid.weeks[0][6].key).toBe("2026-03-01");
  });

  it("labels the month deterministically in UTC", () => {
    expect(calendarMonthLabel(2026, 2)).toBe("March 2026");
    expect(calendarMonthLabel(2026, 0)).toBe("January 2026");
  });
});

describe("focus movement", () => {
  it("steps a day / a week and clamps at the grid edges", () => {
    expect(moveFocusIndex(35, 10, "ArrowRight")).toBe(11);
    expect(moveFocusIndex(35, 10, "ArrowLeft")).toBe(9);
    expect(moveFocusIndex(35, 10, "ArrowDown")).toBe(17);
    expect(moveFocusIndex(35, 10, "ArrowUp")).toBe(3);
    expect(moveFocusIndex(35, 0, "ArrowUp")).toBe(0);
    expect(moveFocusIndex(35, 0, "ArrowLeft")).toBe(0);
    expect(moveFocusIndex(35, 34, "ArrowDown")).toBe(34);
    expect(moveFocusIndex(35, 34, "ArrowRight")).toBe(34);
  });

  it("jumps to the edges of the focused row", () => {
    expect(moveFocusIndex(35, 10, "Home")).toBe(7);
    expect(moveFocusIndex(35, 10, "End")).toBe(13);
    expect(moveFocusIndex(35, 0, "Home")).toBe(0);
    expect(moveFocusIndex(35, 0, "End")).toBe(6);
  });

  it("is safe on an empty grid", () => {
    expect(moveFocusIndex(0, 0, "ArrowDown")).toBe(0);
  });

  it("shifts months across year boundaries and clamps days", () => {
    expect(shiftMonth(2026, 0, -1)).toEqual({ year: 2025, month: 11 });
    expect(shiftMonth(2026, 11, 1)).toEqual({ year: 2027, month: 0 });
    expect(shiftMonth(2026, 5, 7)).toEqual({ year: 2027, month: 0 });
    expect(clampDayOfMonth(2026, 1, 31)).toBe(28); // Feb 2026
    expect(clampDayOfMonth(2024, 1, 31)).toBe(29); // leap Feb
    expect(clampDayOfMonth(2026, 0, 31)).toBe(31);
  });

  it("seeds the roving tab stop from today, else the first in-month day", () => {
    const grid = monthGrid(2026, 2, { weekStartsOn: 1 });
    expect(defaultFocusKey(grid, NOW_KEY)).toBe(NOW_KEY);
    expect(defaultFocusKey(grid, "2026-01-01")).toBe("2026-03-01");
    expect(defaultFocusKey(grid, null)).toBe("2026-03-01");
  });
});

describe("range selection state machine", () => {
  it("opens with the first click and closes with the second", () => {
    const started = selectDay(emptyRange(), "2026-03-20");
    expect(started).toEqual({ start: "2026-03-20", end: null });
    expect(isRangePending(started)).toBe(true);

    const closed = selectDay(started, "2026-03-24");
    expect(closed).toEqual({ start: "2026-03-20", end: "2026-03-24" });
    expect(isRangePending(closed)).toBe(false);
  });

  it("swaps a backwards range so start <= end", () => {
    const started = selectDay(emptyRange(), "2026-03-20");
    expect(selectDay(started, "2026-03-16")).toEqual({
      start: "2026-03-16",
      end: "2026-03-20",
    });
  });

  it("starts fresh when a complete range is clicked again", () => {
    const complete = { start: "2026-03-16", end: "2026-03-20" };
    expect(selectDay(complete, "2026-03-25")).toEqual({ start: "2026-03-25", end: null });
  });

  it("exposes sorted inclusive bounds", () => {
    expect(rangeBounds(emptyRange())).toBeNull();
    expect(rangeBounds({ start: "2026-03-20", end: null })).toEqual({
      from: "2026-03-20",
      to: "2026-03-20",
    });
    expect(rangeBounds({ start: "2026-03-20", end: "2026-03-16" })).toEqual({
      from: "2026-03-16",
      to: "2026-03-20",
    });
  });
});

describe("range + hover edges", () => {
  const range = { start: "2026-03-16", end: "2026-03-20" };

  it("marks ends and continuous middles", () => {
    expect(dayRangeEdges("2026-03-16", range)).toMatchObject({
      inRange: true,
      isStart: true,
      isEnd: false,
      continuesBefore: false,
      continuesAfter: true,
    });
    expect(dayRangeEdges("2026-03-18", range)).toMatchObject({
      inRange: true,
      isStart: false,
      isEnd: false,
      continuesBefore: true,
      continuesAfter: true,
    });
    expect(dayRangeEdges("2026-03-20", range)).toMatchObject({
      inRange: true,
      isStart: false,
      isEnd: true,
      continuesBefore: true,
      continuesAfter: false,
    });
    expect(dayRangeEdges("2026-03-25", range).inRange).toBe(false);
  });

  it("previews a pending range with the hovered day", () => {
    const pending = { start: "2026-03-16", end: null };
    expect(dayRangeEdges("2026-03-18", pending, "2026-03-22")).toMatchObject({
      inRange: true,
      continuesAfter: true,
    });
    // A backwards hover still previews a forward band, with the earlier day
    // as the start.
    expect(dayRangeEdges("2026-03-14", pending, "2026-03-12")).toMatchObject({
      inRange: true,
      isStart: false,
      continuesAfter: true,
    });
    expect(dayRangeEdges("2026-03-12", pending, "2026-03-12")).toMatchObject({
      inRange: true,
      isStart: true,
      continuesAfter: true,
    });
    // No hover → only the start cell.
    expect(dayRangeEdges("2026-03-18", pending, null).inRange).toBe(false);
    expect(dayRangeEdges("2026-03-16", pending, null).isStart).toBe(true);
  });

  it("renders nothing for an empty selection", () => {
    expect(dayRangeEdges("2026-03-18", emptyRange()).inRange).toBe(false);
  });
});

describe("isoDayOf", () => {
  it("formats a UTC instant as a date key", () => {
    expect(isoDayOf(Date.UTC(2026, 2, 18))).toBe("2026-03-18");
    expect(isoDayOf(Date.UTC(2026, 0, 1))).toBe("2026-01-01");
  });
});

describe("CalendarGrid static render", () => {
  const html = renderToStaticMarkup(
    createElement(CalendarGrid, {
      year: 2026,
      month: 2,
      locale: "en",
      weekStartsOn: 1,
      today: NOW_KEY,
      value: { start: "2026-03-16", end: "2026-03-20" },
    }),
  );

  it("renders the month grid with the locale week start", () => {
    expect(html).toContain('role="grid"');
    expect(html).toContain('data-testid="calendar-grid"');
    expect(html).toContain("March 2026");
    // Monday-first header: Mon appears before Sun.
    expect(html.indexOf(">Mon<")).toBeGreaterThan(-1);
    expect(html.indexOf(">Mon<")).toBeLessThan(html.indexOf(">Sun<"));
  });

  it("shows adjacent-month spill cells and today emphasis", () => {
    // Monday 23 Feb 2026 opens the first row of March.
    expect(html).toContain('data-day="2026-02-23"');
    expect(html).toContain('data-out="true"');
    expect(html).toContain('data-today="true"');
  });

  it("marks the selected range ends and the continuous band", () => {
    expect(html).toContain('data-range-start="true"');
    expect(html).toContain('data-range-end="true"');
    expect(html).toContain('data-in-range="true"');
    expect(html).toContain('data-continues-before="true"');
    expect(html).toContain('data-continues-after="true"');
    expect(html).toContain('aria-selected="true"');
  });

  it("omits today emphasis when today is null", () => {
    const bare = renderToStaticMarkup(
      createElement(CalendarGrid, { year: 2026, month: 0, locale: "en", today: null }),
    );
    expect(bare).not.toContain('data-today="true"');
  });
});
