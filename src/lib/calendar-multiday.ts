/**
 * Calendar month/week grid + multi-day event layout
 * (docs/FEATURE_MATRIX.md:256 "Calendar multi-day events", spec R89.10 in
 * docs/specs/database-deep.md).
 *
 * Pure, DB-free and timezone-free layout logic: build the UTC day grid a
 * month calendar renders, then place events onto it as horizontal bars that
 * span every covered day and are packed into non-overlapping lanes per week
 * row. No `Date.now()`, no `new Date()` without an explicit UTC basis and no
 * local-time getters are ever used, so results are identical on any machine
 * and clock.
 *
 * Day arithmetic is done on **UTC day indices** (`floor(ms / 86_400_000)`)
 * and events use the same half-open meaning as `@/lib/timeline`: `start` is
 * inclusive, `end` is exclusive, so an event ending exactly on a day boundary
 * does not spill into the next day and back-to-back events can share a lane.
 *
 * This is layout only — the React calendar surface that consumes it is
 * separate work.
 */

/** Milliseconds in one UTC day. */
export const MS_PER_DAY = 86_400_000;

/** A single UTC day cell in a calendar grid. */
export type CalendarDay = {
  /** `YYYY-MM-DD` UTC key (zero-padded). */
  key: string;
  /** UTC day number since the epoch: `floor(ms / MS_PER_DAY)`. */
  dayIndex: number;
  /** Day of month, 1..31. */
  date: number;
  /** 0-based month (`Date` convention: 0 = January). May be a spill day. */
  month: number;
  /** Full year of this cell. */
  year: number;
  /** 0 = Sunday .. 6 = Saturday, matching `getUTCDay()`. */
  weekday: number;
  /** `true` when the cell belongs to the month the grid was requested for. */
  inMonth: boolean;
};

/** A month laid out as whole UTC weeks (`weeks[w][d]`, 7 cells per week). */
export type CalendarGrid = {
  year: number;
  /** 0-based month the grid was requested for. */
  month: number;
  /** Column the week starts on: 0 = Sunday .. 6 = Saturday. */
  weekStartsOn: number;
  /** Whole weeks covering the month, each exactly 7 days. */
  weeks: CalendarDay[][];
  /** Every cell, flattened in reading order (`weeks.flat()`). */
  days: CalendarDay[];
};

export type MonthGridOptions = {
  /** Day the week starts on: 0 = Sunday (default) .. 6 = Saturday. */
  weekStartsOn?: number;
};

/** Minimal event shape: an id plus a half-open `[start, end)` ms-epoch span. */
export type CalendarEvent = {
  id: string;
  start: number;
  end: number;
};

/** One event placed on a week row. Generic so callers keep their payload. */
export type EventPlacement<T extends CalendarEvent = CalendarEvent> = {
  event: T;
  /** Lane (row) inside the week, 0-based. */
  lane: number;
  /** First covered column in the week, 0..6. */
  startCol: number;
  /** Number of columns covered in this week, >= 1. */
  span: number;
  /** The event began before this week's first day (bar continues from the left). */
  continuesBefore: boolean;
  /** The event ends after this week's last day (bar continues to the right). */
  continuesAfter: boolean;
};

/** A week row with its event bars packed into lanes. */
export type WeekLayout<T extends CalendarEvent = CalendarEvent> = {
  days: CalendarDay[];
  placements: EventPlacement<T>[];
  /** Lanes actually occupied (never exceeds `maxLanes`). */
  laneCount: number;
  /** Bars dropped in this week because they fell past `maxLanes`. */
  hiddenCount: number;
};

/** The laid-out calendar: the grid plus every week's packed placements. */
export type CalendarLayout<T extends CalendarEvent = CalendarEvent> = {
  year: number;
  month: number;
  weekStartsOn: number;
  weeks: WeekLayout<T>[];
  /**
   * Total bars hidden across all week rows. An event spanning several weeks
   * that is dropped in each of them counts once per week (each row counts the
   * bars it could not show).
   */
  hiddenCount: number;
};

function assertInteger(value: number, name: string): void {
  if (!Number.isInteger(value)) {
    throw new RangeError(`${name} must be an integer, got ${value}`);
  }
}

function assertMonth(month: number): void {
  assertInteger(month, "month");
  if (month < 0 || month > 11) {
    throw new RangeError(`month must be in [0, 11] (0 = January), got ${month}`);
  }
}

function assertWeekStartsOn(weekStartsOn: number): void {
  assertInteger(weekStartsOn, "weekStartsOn");
  if (weekStartsOn < 0 || weekStartsOn > 6) {
    throw new RangeError(`weekStartsOn must be in [0, 6], got ${weekStartsOn}`);
  }
}

/** UTC day index of the instant `ms`. */
function dayIndexOf(ms: number): number {
  return Math.floor(ms / MS_PER_DAY);
}

/** Inclusive last day index of a half-open `[start, end)` span. */
function lastDayIndexOf(event: CalendarEvent): number {
  const startDay = dayIndexOf(event.start);
  if (!(event.end > event.start)) return startDay;
  return dayIndexOf(event.end - 1);
}

const pad2 = (value: number): string => String(value).padStart(2, "0");

/** Build the day cell at a UTC day index, tagged against the requested month. */
function dayCell(dayIndex: number, year: number, month: number): CalendarDay {
  const date = new Date(dayIndex * MS_PER_DAY);
  const cellYear = date.getUTCFullYear();
  const cellMonth = date.getUTCMonth();
  const cellDate = date.getUTCDate();
  return {
    key: `${cellYear}-${pad2(cellMonth + 1)}-${pad2(cellDate)}`,
    dayIndex,
    date: cellDate,
    month: cellMonth,
    year: cellYear,
    weekday: date.getUTCDay(),
    inMonth: cellYear === year && cellMonth === month,
  };
}

/**
 * Lay a month out as whole UTC weeks.
 *
 * `month` is 0-based (`0` = January), matching `Date`. The grid starts on the
 * `weekStartsOn` column (default Sunday) and always contains complete weeks,
 * so the first and last rows may include spill days from the neighbouring
 * months (flagged `inMonth: false`). The number of weeks is the minimum that
 * covers the month: 4 for a 28-day month starting on the week-start column,
 * otherwise 5 or at most 6.
 *
 * @throws RangeError for a non-integer year, a month outside `[0, 11]` or a
 *   `weekStartsOn` outside `[0, 6]`.
 */
export function monthGrid(
  year: number,
  month: number,
  options: MonthGridOptions = {},
): CalendarGrid {
  assertInteger(year, "year");
  assertMonth(month);
  const weekStartsOn = options.weekStartsOn ?? 0;
  assertWeekStartsOn(weekStartsOn);

  const firstDayIndex = dayIndexOf(Date.UTC(year, month, 1));
  const firstWeekday = new Date(firstDayIndex * MS_PER_DAY).getUTCDay();
  const leading = (firstWeekday - weekStartsOn + 7) % 7;
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const weekCount = Math.ceil((leading + daysInMonth) / 7);
  const gridStart = firstDayIndex - leading;

  const weeks: CalendarDay[][] = [];
  for (let w = 0; w < weekCount; w++) {
    const week: CalendarDay[] = [];
    for (let d = 0; d < 7; d++) {
      week.push(dayCell(gridStart + w * 7 + d, year, month));
    }
    weeks.push(week);
  }

  return {
    year,
    month,
    weekStartsOn,
    weeks,
    days: weeks.flat(),
  };
}

export type PlaceEventsOptions = {
  /**
   * Maximum number of lanes a week row may show. Bars that would need a lane
   * at or past this limit are dropped and counted in `hiddenCount` (they do
   * not reserve the lane, so a later, non-overlapping event can still use it).
   * Omit for unlimited lanes.
   */
  maxLanes?: number;
};

/**
 * Place events on a month/week grid as multi-day bars.
 *
 * Every week row is packed independently: events overlapping that week's day
 * range are sorted by the stable key `(start, end, id)` and greedily assigned
 * the lowest lane no earlier event in it overlaps. Two bars may share a lane
 * when they merely touch (half-open day ranges), and a bar that runs past the
 * week edge is clipped to the seven columns with `continuesBefore` /
 * `continuesAfter` set so the UI can draw an open end. Inputs are never
 * mutated; `placements` reference the caller's original event objects, in the
 * stable order.
 *
 * Events entirely outside the grid are ignored. With `maxLanes`, overflowing
 * bars are dropped and tallied in `hiddenCount` (per week and in total).
 */
export function placeEvents<T extends CalendarEvent>(
  grid: CalendarGrid,
  events: readonly T[],
  options: PlaceEventsOptions = {},
): CalendarLayout<T> {
  const maxLanes = options.maxLanes;
  if (maxLanes !== undefined) {
    assertInteger(maxLanes, "maxLanes");
    if (maxLanes < 0) {
      throw new RangeError(`maxLanes must be >= 0, got ${maxLanes}`);
    }
  }

  const sorted = [...events].sort(
    (a, b) => a.start - b.start || a.end - b.end || a.id.localeCompare(b.id),
  );
  const spans = sorted.map((event) => ({
    event,
    startDay: dayIndexOf(event.start),
    endDay: lastDayIndexOf(event),
  }));

  let totalHidden = 0;
  const weeks = grid.weeks.map((days) => {
    const firstDay = days[0].dayIndex;
    const lastDay = days[days.length - 1].dayIndex;
    // laneEnd[lane] = last column covered by the most recent bar in that lane.
    const laneEnd: number[] = [];
    const placements: EventPlacement<T>[] = [];
    let hiddenCount = 0;

    for (const span of spans) {
      if (span.startDay > lastDay || span.endDay < firstDay) continue;
      const startCol = Math.max(span.startDay, firstDay) - firstDay;
      const endCol = Math.min(span.endDay, lastDay) - firstDay;
      let lane = laneEnd.findIndex((end) => startCol > end);
      if (lane === -1) lane = laneEnd.length;
      if (maxLanes !== undefined && lane >= maxLanes) {
        hiddenCount += 1;
        continue;
      }
      if (lane === laneEnd.length) laneEnd.push(endCol);
      else laneEnd[lane] = endCol;
      placements.push({
        event: span.event,
        lane,
        startCol,
        span: endCol - startCol + 1,
        continuesBefore: span.startDay < firstDay,
        continuesAfter: span.endDay > lastDay,
      });
    }

    totalHidden += hiddenCount;
    return { days, placements, laneCount: laneEnd.length, hiddenCount };
  });

  return {
    year: grid.year,
    month: grid.month,
    weekStartsOn: grid.weekStartsOn,
    weeks,
    hiddenCount: totalHidden,
  };
}
