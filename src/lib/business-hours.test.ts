import { describe, expect, it } from "vitest";
import {
  addBusinessDays,
  addBusinessHours,
  businessMinutesBetween,
  isBusinessDay,
  isBusinessTime,
  type WorkingHours,
} from "@/lib/business-hours";

const MIN = 60_000;
const HOUR = 60 * MIN;

/** UTC instant from calendar parts (month is 1-based). */
const utc = (y: number, m: number, d: number, h = 0, min = 0, s = 0, ms = 0) =>
  Date.UTC(y, m - 1, d, h, min, s, ms);

/**
 * Mon-Fri, 09:00-17:00 UTC, closed on 2026-01-01 (a Thursday).
 * 2026-01-01 is Thu, 01-02 Fri, 01-03 Sat, 01-04 Sun, 01-05 Mon.
 */
const WEEKDAYS: WorkingHours = {
  days: [1, 2, 3, 4, 5],
  startMinutes: 9 * 60,
  endMinutes: 17 * 60,
  holidays: ["2026-01-01"],
};

describe("isBusinessTime / isBusinessDay — is the office open?", () => {
  it("is open on a working day within the half-open window", () => {
    expect(isBusinessTime(utc(2026, 1, 5, 9, 0), WEEKDAYS)).toBe(true); // start inclusive
    expect(isBusinessTime(utc(2026, 1, 5, 12, 0), WEEKDAYS)).toBe(true);
    expect(isBusinessTime(utc(2026, 1, 5, 16, 59, 59), WEEKDAYS)).toBe(true);
  });

  it("is closed just before the start and at/after the end", () => {
    expect(isBusinessTime(utc(2026, 1, 5, 8, 59), WEEKDAYS)).toBe(false);
    expect(isBusinessTime(utc(2026, 1, 5, 8, 59, 59, 999), WEEKDAYS)).toBe(false);
    expect(isBusinessTime(utc(2026, 1, 5, 17, 0), WEEKDAYS)).toBe(false); // end exclusive
    expect(isBusinessTime(utc(2026, 1, 5, 23, 0), WEEKDAYS)).toBe(false);
  });

  it("is closed on weekends", () => {
    expect(isBusinessTime(utc(2026, 1, 3, 12, 0), WEEKDAYS)).toBe(false); // Saturday
    expect(isBusinessTime(utc(2026, 1, 4, 12, 0), WEEKDAYS)).toBe(false); // Sunday
  });

  it("is closed on a listed holiday even though the weekday is open", () => {
    expect(isBusinessTime(utc(2026, 1, 1, 12, 0), WEEKDAYS)).toBe(false); // Thursday holiday
    expect(isBusinessDay(utc(2026, 1, 1, 12, 0), WEEKDAYS)).toBe(false);
  });

  it("distinguishes a working day from a business instant", () => {
    expect(isBusinessDay(utc(2026, 1, 2), WEEKDAYS)).toBe(true); // Friday, 00:00
    expect(isBusinessTime(utc(2026, 1, 2), WEEKDAYS)).toBe(false); // too early
    expect(isBusinessDay(utc(2026, 1, 3), WEEKDAYS)).toBe(false); // Saturday
  });

  it("fails safe on an unparseable instant or an unusable config", () => {
    expect(isBusinessTime("not-a-date", WEEKDAYS)).toBe(false);
    expect(isBusinessDay("not-a-date", WEEKDAYS)).toBe(false);
    expect(isBusinessTime(utc(2026, 1, 5, 12, 0), { days: [], startMinutes: 540, endMinutes: 1020 })).toBe(
      false,
    );
    expect(isBusinessTime(utc(2026, 1, 5, 12, 0), { days: [1], startMinutes: 1020, endMinutes: 540 })).toBe(
      false,
    );
  });
});

describe("addBusinessDays — count working days, keep the time of day", () => {
  it("steps forward across a weekend", () => {
    const friday = utc(2026, 1, 2, 10, 30);
    expect(addBusinessDays(friday, 1, WEEKDAYS).getTime()).toBe(utc(2026, 1, 5, 10, 30));
    expect(addBusinessDays(friday, 2, WEEKDAYS).getTime()).toBe(utc(2026, 1, 6, 10, 30));
  });

  it("steps back across a weekend and a holiday", () => {
    const monday = utc(2026, 1, 5, 10, 30);
    expect(addBusinessDays(monday, -1, WEEKDAYS).getTime()).toBe(utc(2026, 1, 2, 10, 30));
    // Friday minus one skips the Thursday holiday back to Wednesday.
    expect(addBusinessDays(utc(2026, 1, 2, 10, 30), -1, WEEKDAYS).getTime()).toBe(
      utc(2025, 12, 31, 10, 30),
    );
  });

  it("does not count the starting day, even when it is a weekend", () => {
    expect(addBusinessDays(utc(2026, 1, 3, 10, 30), 1, WEEKDAYS).getTime()).toBe(
      utc(2026, 1, 5, 10, 30),
    ); // Saturday -> Monday
  });

  it("returns the instant unchanged for n = 0", () => {
    const base = utc(2026, 1, 2, 10, 30);
    expect(addBusinessDays(base, 0, WEEKDAYS).getTime()).toBe(base);
  });

  it("spans several working days while preserving hours and minutes", () => {
    const out = addBusinessDays(utc(2026, 1, 5, 10, 30), 5, WEEKDAYS);
    expect(out.getTime()).toBe(utc(2026, 1, 12, 10, 30));
    expect(out.getUTCHours()).toBe(10);
    expect(out.getUTCMinutes()).toBe(30);
  });

  it("yields an Invalid Date for an unparseable instant or non-integer count", () => {
    expect(Number.isNaN(addBusinessDays("not-a-date", 1, WEEKDAYS).getTime())).toBe(true);
    expect(Number.isNaN(addBusinessDays(utc(2026, 1, 5), 1.5, WEEKDAYS).getTime())).toBe(true);
  });
});

describe("addBusinessHours — advance only through open hours", () => {
  it("moves within a single working day", () => {
    expect(addBusinessHours(utc(2026, 1, 5, 9, 0), 4, WEEKDAYS).getTime()).toBe(
      utc(2026, 1, 5, 13, 0),
    );
    expect(addBusinessHours(utc(2026, 1, 5, 9, 0), 0.5, WEEKDAYS).getTime()).toBe(
      utc(2026, 1, 5, 9, 30),
    );
  });

  it("lands exactly on the close and rolls into the next working day", () => {
    expect(addBusinessHours(utc(2026, 1, 5, 9, 0), 8, WEEKDAYS).getTime()).toBe(
      utc(2026, 1, 5, 17, 0),
    );
    expect(addBusinessHours(utc(2026, 1, 5, 9, 0), 9, WEEKDAYS).getTime()).toBe(
      utc(2026, 1, 6, 10, 0),
    );
  });

  it("carries the remainder over a weekend", () => {
    // Friday 16:00 + 1h closes out the week, then 1h on Monday.
    expect(addBusinessHours(utc(2026, 1, 2, 16, 0), 2, WEEKDAYS).getTime()).toBe(
      utc(2026, 1, 5, 10, 0),
    );
  });

  it("skips the holiday between two working days", () => {
    expect(addBusinessHours(utc(2025, 12, 31, 16, 0), 2, WEEKDAYS).getTime()).toBe(
      utc(2026, 1, 2, 10, 0),
    );
  });

  it("opens from outside business hours before consuming time", () => {
    expect(addBusinessHours(utc(2026, 1, 5, 8, 0), 1, WEEKDAYS).getTime()).toBe(
      utc(2026, 1, 5, 10, 0),
    ); // before open
    expect(addBusinessHours(utc(2026, 1, 3, 12, 0), 1, WEEKDAYS).getTime()).toBe(
      utc(2026, 1, 5, 10, 0),
    ); // Saturday
  });

  it("is a no-op for zero or negative hours", () => {
    const base = utc(2026, 1, 5, 9, 0);
    expect(addBusinessHours(base, 0, WEEKDAYS).getTime()).toBe(base);
    expect(addBusinessHours(base, -3, WEEKDAYS).getTime()).toBe(base);
  });
});

describe("businessMinutesBetween — working time inside a span", () => {
  it("counts a same-day span, clamped to the window", () => {
    expect(businessMinutesBetween(utc(2026, 1, 5, 9, 0), utc(2026, 1, 5, 12, 0), WEEKDAYS)).toBe(180);
    expect(businessMinutesBetween(utc(2026, 1, 5, 9, 0), utc(2026, 1, 5, 18, 0), WEEKDAYS)).toBe(480);
    expect(businessMinutesBetween(utc(2026, 1, 5, 16, 0), utc(2026, 1, 5, 23, 0), WEEKDAYS)).toBe(60);
  });

  it("sums across a boundary and a weekend", () => {
    expect(businessMinutesBetween(utc(2026, 1, 5, 16, 0), utc(2026, 1, 6, 10, 0), WEEKDAYS)).toBe(120);
    expect(businessMinutesBetween(utc(2026, 1, 2, 16, 0), utc(2026, 1, 5, 10, 0), WEEKDAYS)).toBe(120);
    expect(businessMinutesBetween(utc(2026, 1, 5, 0, 0), utc(2026, 1, 12, 0, 0), WEEKDAYS)).toBe(2400);
  });

  it("excludes holidays", () => {
    expect(
      businessMinutesBetween(utc(2025, 12, 31, 16, 0), utc(2026, 1, 2, 10, 0), WEEKDAYS),
    ).toBe(120);
  });

  it("is zero for weekends, empty spans, reversed spans and bad input", () => {
    expect(businessMinutesBetween(utc(2026, 1, 3, 0, 0), utc(2026, 1, 5, 9, 0), WEEKDAYS)).toBe(0);
    expect(businessMinutesBetween(utc(2026, 1, 5, 9, 0), utc(2026, 1, 5, 9, 0), WEEKDAYS)).toBe(0);
    expect(businessMinutesBetween(utc(2026, 1, 6, 9, 0), utc(2026, 1, 5, 9, 0), WEEKDAYS)).toBe(0);
    expect(businessMinutesBetween("not-a-date", utc(2026, 1, 5, 9, 0), WEEKDAYS)).toBe(0);
  });

  it("measures sub-minute spans exactly", () => {
    expect(
      businessMinutesBetween(utc(2026, 1, 5, 9, 0, 30), utc(2026, 1, 5, 9, 1, 30), WEEKDAYS),
    ).toBe(1);
  });
});
