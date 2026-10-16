"use client";

import { useMemo, useState, type KeyboardEvent } from "react";
import {
  monthGrid,
  MS_PER_DAY,
  type CalendarGrid as MonthGridData,
} from "@/lib/calendar-multiday";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * The month-grid *view* used by the date/time control.
 *
 * This is not a second calendar engine: the day layout comes from
 * `@/lib/calendar-multiday` (`monthGrid`), which already owns UTC day math,
 * whole-week layout and adjacent-month spill cells. Everything here is the
 * presentation + interaction layer that was missing — weekday headers that
 * honour the locale's week start, today emphasis, keyboard navigation and the
 * range-selection helpers the picker drives.
 *
 * The pure helpers (week start, weekday order, focus movement, range state) are
 * exported so `calendar-grid.test.ts` can pin them without a DOM. The component
 * itself is controlled: the parent owns the visible month and the selection, so
 * `renderToStaticMarkup` is deterministic and there is no clock read during
 * render (today is a prop, `null` until the client mounts).
 */

/** Weekday catalogue keys, indexed 0 = Sunday .. 6 = Saturday (`Date` order). */
export const WEEKDAY_KEYS = [
  "wdSun",
  "wdMon",
  "wdTue",
  "wdWed",
  "wdThu",
  "wdFri",
  "wdSat",
] as const;

export type WeekdayKey = (typeof WEEKDAY_KEYS)[number];

/**
 * First day of the week for the app's locales, per CLDR (`0` = Sunday). Kept
 * explicit so the header is deterministic on every runtime; an unknown locale
 * falls back to `Intl.Locale`'s `weekInfo` and finally to Sunday.
 */
export const LOCALE_WEEK_START: Readonly<Record<string, number>> = {
  en: 0,
  fr: 1,
  es: 1,
  de: 1,
  ar: 6,
};

/** The week-start column for a locale (`0` = Sunday .. `6` = Saturday). */
export function weekStartsOnForLocale(locale: string): number {
  const base = (locale || "en").toLowerCase().split(/[-_]/)[0];
  const known = LOCALE_WEEK_START[base];
  if (known !== undefined) return known;
  try {
    const info = new Intl.Locale(locale) as Intl.Locale & {
      weekInfo?: { firstDay?: number };
    };
    const first = info.weekInfo?.firstDay;
    // CLDR numbers Monday as 1 .. Sunday as 7.
    if (typeof first === "number" && first >= 1 && first <= 7) return first === 7 ? 0 : first;
  } catch {
    // Unknown locale — fall through to Sunday.
  }
  return 0;
}

/** Weekday keys rotated so the column at `weekStartsOn` comes first. */
export function weekdayOrder(weekStartsOn: number): WeekdayKey[] {
  const start = ((weekStartsOn % 7) + 7) % 7;
  return [...WEEKDAY_KEYS.slice(start), ...WEEKDAY_KEYS.slice(0, start)];
}

/**
 * Deterministic UTC month label ("March 2026"). Fixed timezone so the server and
 * the first client paint agree byte for byte.
 */
export function calendarMonthLabel(year: number, month: number, locale = "en"): string {
  return new Intl.DateTimeFormat(locale, {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, month, 1)));
}

/** Keys that move the roving focus inside the grid. */
export type GridMoveKey =
  | "ArrowLeft"
  | "ArrowRight"
  | "ArrowUp"
  | "ArrowDown"
  | "Home"
  | "End";

/**
 * Move the focused day within a whole-week grid. Columns are `index % 7`
 * (the grid already starts on the week-start column), arrows step a day or a
 * week, and `Home`/`End` jump to the edges of the focused row. The result is
 * always clamped to the grid — never wraps to a different month.
 */
export function moveFocusIndex(count: number, index: number, key: GridMoveKey): number {
  if (count <= 0) return 0;
  const clamp = (value: number) => Math.max(0, Math.min(count - 1, value));
  const safe = clamp(index);
  const column = safe % 7;
  switch (key) {
    case "ArrowLeft":
      return clamp(safe - 1);
    case "ArrowRight":
      return clamp(safe + 1);
    case "ArrowUp":
      return clamp(safe - 7);
    case "ArrowDown":
      return clamp(safe + 7);
    case "Home":
      return clamp(safe - column);
    case "End":
      return clamp(safe - column + 6);
  }
}

/** Shift `(year, month)` by whole months, normalising across year edges. */
export function shiftMonth(
  year: number,
  month: number,
  delta: number,
): { year: number; month: number } {
  const total = year * 12 + month + delta;
  const nextYear = Math.floor(total / 12);
  const nextMonth = ((total % 12) + 12) % 12;
  return { year: nextYear, month: nextMonth };
}

/** Clamp a day-of-month to a real day, so 31 Jan → 28/29 Feb never overflows. */
export function clampDayOfMonth(year: number, month: number, date: number): number {
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return Math.max(1, Math.min(last, date));
}

/** Inclusive `[start, end)`-free selection: `end === null` means "awaiting". */
export type RangeSelection = { start: string | null; end: string | null };

/** An empty selection. */
export function emptyRange(): RangeSelection {
  return { start: null, end: null };
}

/** `true` while the first bound is set and the second is still pending. */
export function isRangePending(selection: RangeSelection): boolean {
  return selection.start !== null && selection.end === null;
}

/**
 * The range selection state machine behind range mode.
 *
 * - first click sets `start` and leaves `end` pending (hover previews the rest);
 * - the second click closes the range, swapping if the user picked backwards;
 * - a click on an already-complete range starts a fresh selection.
 */
export function selectDay(selection: RangeSelection, day: string): RangeSelection {
  if (selection.start === null) return { start: day, end: null };
  if (selection.end === null) {
    return day < selection.start
      ? { start: day, end: selection.start }
      : { start: selection.start, end: day };
  }
  return { start: day, end: null };
}

/** The sorted, inclusive bounds of a selection (or `null` when empty). */
export function rangeBounds(
  selection: RangeSelection,
): { from: string; to: string } | null {
  if (selection.start === null) return null;
  const to = selection.end ?? selection.start;
  return selection.start <= to
    ? { from: selection.start, to }
    : { from: to, to: selection.start };
}

export type DayRangeEdges = {
  inRange: boolean;
  isStart: boolean;
  isEnd: boolean;
  continuesBefore: boolean;
  continuesAfter: boolean;
};

/**
 * Where one day sits inside the current (or hover-previewed) range. The
 * `continuesBefore` / `continuesAfter` flags let the cell drop its inner
 * rounding so a multi-day band reads as one continuous bar, mirroring the
 * `continuesBefore` / `continuesAfter` affordance of the event bars.
 */
export function dayRangeEdges(
  day: string,
  selection: RangeSelection,
  hover: string | null = null,
): DayRangeEdges {
  const bounds = rangeBounds(
    isRangePending(selection) && hover ? { start: selection.start, end: hover } : selection,
  );
  if (!bounds) {
    return {
      inRange: false,
      isStart: false,
      isEnd: false,
      continuesBefore: false,
      continuesAfter: false,
    };
  }
  const inRange = day >= bounds.from && day <= bounds.to;
  const isStart = day === bounds.from;
  const isEnd = day === bounds.to;
  return {
    inRange,
    isStart,
    isEnd,
    continuesBefore: inRange && !isStart,
    continuesAfter: inRange && !isEnd,
  };
}

/** The `YYYY-MM-DD` key of a UTC day index. */
function isoFromDayIndex(dayIndex: number): string {
  const date = new Date(dayIndex * MS_PER_DAY);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** The day key shown first, so the grid always has a roving tab stop. */
export function defaultFocusKey(grid: MonthGridData, today: string | null): string {
  return (
    grid.days.find((day) => day.key === today)?.key ??
    grid.days.find((day) => day.inMonth)?.key ??
    grid.days[0].key
  );
}

export type CalendarGridProps = {
  /** 0-based month, `Date` convention. */
  year: number;
  month: number;
  locale?: string;
  /** Overrides the locale-derived week start (`0` = Sunday .. `6` = Saturday). */
  weekStartsOn?: number;
  /** `YYYY-MM-DD` of "today" for emphasis; `null` renders no emphasis. */
  today?: string | null;
  /** Selected range; a single date is `{ start: day, end: day }`. */
  value?: RangeSelection | null;
  /** Hovered day, used to preview a pending range. */
  hover?: string | null;
  /** Controlled roving focus; omit to let the grid manage it. */
  focusKey?: string | null;
  onSelectDay?: (day: string) => void;
  onHoverDay?: (day: string | null) => void;
  /** Required for PageUp/PageDown and the header arrows to do anything. */
  onShiftMonth?: (delta: number) => void;
  onFocusKeyChange?: (day: string) => void;
  className?: string;
};

/**
 * Month grid: weekday headers (locale week start), whole weeks from
 * `monthGrid`, adjacent-month spill cells, today emphasis, keyboard navigation
 * and range/hover highlighting.
 */
export function CalendarGrid({
  year,
  month,
  locale = "en",
  weekStartsOn,
  today = null,
  value = null,
  hover = null,
  focusKey: controlledFocus,
  onSelectDay,
  onHoverDay,
  onShiftMonth,
  onFocusKeyChange,
  className,
}: CalendarGridProps) {
  const startsOn = weekStartsOn ?? weekStartsOnForLocale(locale);
  const grid = useMemo(
    () => monthGrid(year, month, { weekStartsOn: startsOn }),
    [year, month, startsOn],
  );
  const [internalFocus, setInternalFocus] = useState<string | null>(null);
  const label = calendarMonthLabel(year, month, locale);

  const fallbackFocus = defaultFocusKey(grid, today);
  const focusKey = controlledFocus ?? internalFocus ?? fallbackFocus;
  const focusIndex = Math.max(
    0,
    grid.days.findIndex((day) => day.key === focusKey),
  );

  const headers = weekdayOrder(grid.weekStartsOn);
  const gridId = `cal-${grid.year}-${grid.month}`;

  const setFocus = (key: string) => {
    if (controlledFocus === undefined) setInternalFocus(key);
    onFocusKeyChange?.(key);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const { key } = event;
    if (key === "PageUp" || key === "PageDown") {
      event.preventDefault();
      onShiftMonth?.(key === "PageUp" ? -1 : 1);
      return;
    }
    if (key === "Enter" || key === " ") {
      event.preventDefault();
      onSelectDay?.(grid.days[focusIndex].key);
      return;
    }
    if (
      key === "ArrowLeft" ||
      key === "ArrowRight" ||
      key === "ArrowUp" ||
      key === "ArrowDown" ||
      key === "Home" ||
      key === "End"
    ) {
      event.preventDefault();
      const next = moveFocusIndex(grid.days.length, focusIndex, key);
      setFocus(grid.days[next].key);
    }
  };

  return (
    <div className={cn("w-[17rem] select-none", className)}>
      <div className="mb-2 flex items-center justify-between">
        <button
          type="button"
          aria-label={t(locale, "previousMonth")}
          disabled={!onShiftMonth}
          onClick={() => onShiftMonth?.(-1)}
          className="focus-ring grid h-7 w-7 place-items-center rounded-sm text-muted u-interactive hover:bg-surface-2 hover:text-fg disabled:pointer-events-none disabled:opacity-50"
        >
          <span aria-hidden>‹</span>
        </button>
        <span className="text-sm font-medium" aria-live="polite">
          {label}
        </span>
        <button
          type="button"
          aria-label={t(locale, "nextMonth")}
          disabled={!onShiftMonth}
          onClick={() => onShiftMonth?.(1)}
          className="focus-ring grid h-7 w-7 place-items-center rounded-sm text-muted u-interactive hover:bg-surface-2 hover:text-fg disabled:pointer-events-none disabled:opacity-50"
        >
          <span aria-hidden>›</span>
        </button>
      </div>

      <div
        role="grid"
        aria-label={label}
        data-testid="calendar-grid"
        tabIndex={0}
        aria-activedescendant={`${gridId}-${grid.days[focusIndex].key}`}
        onKeyDown={handleKeyDown}
        className="focus-ring rounded-sm outline-none"
      >
        <div role="row" className="grid grid-cols-7">
          {headers.map((weekday) => (
            <div
              key={weekday}
              role="columnheader"
              className="py-1 text-center text-xs font-medium text-muted"
            >
              {t(locale, weekday)}
            </div>
          ))}
        </div>

        {grid.weeks.map((week) => (
          <div
            key={week[0].key}
            role="row"
            className="grid grid-cols-7 justify-items-center"
          >
            {week.map((day) => {
              const edges = value
                ? dayRangeEdges(day.key, value, hover)
                : {
                    inRange: false,
                    isStart: false,
                    isEnd: false,
                    continuesBefore: false,
                    continuesAfter: false,
                  };
              const isToday = today === day.key;
              const isFocused = day.key === focusKey;
              const selected = edges.isStart || edges.isEnd;
              return (
                <button
                  key={day.key}
                  type="button"
                  role="gridcell"
                  id={`${gridId}-${day.key}`}
                  data-day={day.key}
                  data-out={day.inMonth ? undefined : "true"}
                  data-today={isToday ? "true" : undefined}
                  data-in-range={edges.inRange ? "true" : undefined}
                  data-range-start={edges.isStart ? "true" : undefined}
                  data-range-end={edges.isEnd ? "true" : undefined}
                  data-continues-before={edges.continuesBefore ? "true" : undefined}
                  data-continues-after={edges.continuesAfter ? "true" : undefined}
                  data-focused={isFocused ? "true" : undefined}
                  aria-selected={edges.inRange ? true : undefined}
                  tabIndex={-1}
                  onMouseEnter={() => onHoverDay?.(day.key)}
                  onFocus={() => setFocus(day.key)}
                  onClick={() => onSelectDay?.(day.key)}
                  className={cn(
                    "focus-ring relative grid h-9 w-9 place-items-center rounded-sm text-sm tabular-nums u-interactive before:absolute before:-inset-1 before:content-['']",
                    day.inMonth ? "text-fg" : "text-fg-subtle",
                    isFocused && !edges.inRange && "bg-surface-2",
                    edges.inRange && !selected && "bg-accent-soft text-fg",
                    selected && "bg-accent text-accent-fg",
                    isToday && !selected && "font-semibold text-accent",
                    edges.continuesBefore && "rounded-l-none",
                    edges.continuesAfter && "rounded-r-none",
                  )}
                >
                  {day.date}
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

/** The day key of a UTC instant, used by callers to seed `today`. */
export function isoDayOf(date: Date | number): string {
  const ms = typeof date === "number" ? date : date.getTime();
  return isoFromDayIndex(Math.floor(ms / MS_PER_DAY));
}
