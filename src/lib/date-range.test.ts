import { describe, expect, it } from "vitest";
import {
  contains,
  durationDays,
  formatDateRange,
  isSameDay,
  isValidTimeZone,
  overlaps,
  parseDateValue,
  sortRanges,
  withTimeZone,
  type DateValue,
} from "./date-range";

/**
 * B-date-range — Date range property + time zones
 * (docs/MISSING_FEATURES.md §4 "Date range", "Date time zone").
 *
 * Written RED-first against a stub, then implemented. Coverage pins:
 * - UTC-safe parsing (date-only never routed through local `new Date(str)`),
 * - inclusive overlap (ranges that merely touch still overlap),
 * - durationDays inclusive for all-day ranges across month/year boundaries,
 * - explicit `timeZone: "UTC"` formatting so machine TZ can never leak in,
 * - Intl-backed time-zone validation ("America/New_York" yes / "Mars/Olympus" no),
 * - determinism: identical input twice, incl. a DST-boundary all-day date.
 *
 * Fixed date strings only — no `new Date()` (the one nondeterministic input).
 */

/** Build an already-normalised all-day range for the predicate tests. */
const day = (start: string, end: string = start): DateValue => ({
  start,
  end,
  allDay: true,
});

const timed = (start: string, end: string): DateValue => ({
  start,
  end,
  allDay: false,
});

describe("parseDateValue — ISO validation + normalisation", () => {
  it("defaults a bare date-only string's end to its start (all-day)", () => {
    expect(parseDateValue("2026-03-03")).toEqual({
      ok: true,
      value: { start: "2026-03-03", end: "2026-03-03", allDay: true },
    });
  });

  it("accepts an object range and infers all-day for date-only bounds", () => {
    expect(parseDateValue({ start: "2026-03-03", end: "2026-03-05" })).toEqual({
      ok: true,
      value: { start: "2026-03-03", end: "2026-03-05", allDay: true },
    });
  });

  it("infers a timed (non-all-day) range from datetime bounds", () => {
    expect(
      parseDateValue({
        start: "2026-03-03T09:00:00.000Z",
        end: "2026-03-03T17:00:00.000Z",
      }),
    ).toEqual({
      ok: true,
      value: {
        start: "2026-03-03T09:00:00.000Z",
        end: "2026-03-03T17:00:00.000Z",
        allDay: false,
      },
    });
  });

  it("honours an explicit allDay flag over the inferred one", () => {
    const result = parseDateValue({
      start: "2026-03-03",
      end: "2026-03-03",
      allDay: false,
    });
    expect(result).toEqual({
      ok: true,
      value: { start: "2026-03-03", end: "2026-03-03", allDay: false },
    });
  });

  it("trims surrounding whitespace", () => {
    expect(parseDateValue({ start: "  2026-03-03  " })).toEqual({
      ok: true,
      value: { start: "2026-03-03", end: "2026-03-03", allDay: true },
    });
  });

  it("keeps a valid time zone and drops defaulted end", () => {
    expect(parseDateValue({ start: "2026-03-03", timeZone: "America/New_York" })).toEqual({
      ok: true,
      value: {
        start: "2026-03-03",
        end: "2026-03-03",
        allDay: true,
        timeZone: "America/New_York",
      },
    });
  });

  it("rejects non-ISO and impossible dates", () => {
    for (const bad of [
      "not a date",
      "03/03/2026",
      "2026-13-03",
      "2026-02-30",
      "2026-3-3",
      "2026-03-03T25:00:00Z",
      "2026-03-03T09:61:00Z",
    ]) {
      const result = parseDateValue(bad);
      expect(result.ok, bad).toBe(false);
    }
  });

  it("rejects a missing start", () => {
    expect(parseDateValue(undefined).ok).toBe(false);
    expect(parseDateValue({ start: "  " }).ok).toBe(false);
    expect(parseDateValue(42).ok).toBe(false);
  });

  it("rejects an unrecognised time zone", () => {
    expect(parseDateValue({ start: "2026-03-03", timeZone: "Mars/Olympus" }).ok).toBe(false);
  });

  it("rejects start after end unless swap is requested", () => {
    expect(parseDateValue({ start: "2026-03-05", end: "2026-03-03" }).ok).toBe(false);
    expect(
      parseDateValue({ start: "2026-03-05", end: "2026-03-03" }, { swap: true }),
    ).toEqual({
      ok: true,
      value: { start: "2026-03-03", end: "2026-03-05", allDay: true },
    });
  });

  it("treats equal start and end as valid (a single day)", () => {
    expect(parseDateValue({ start: "2026-03-03", end: "2026-03-03" }).ok).toBe(true);
  });
});

describe("overlaps — inclusive touching", () => {
  it("touching date-only ranges overlap", () => {
    expect(overlaps(day("2026-03-01", "2026-03-03"), day("2026-03-03", "2026-03-05"))).toBe(
      true,
    );
  });

  it("touching timed ranges overlap at the shared instant", () => {
    expect(
      overlaps(
        timed("2026-03-03T09:00:00.000Z", "2026-03-03T10:00:00.000Z"),
        timed("2026-03-03T10:00:00.000Z", "2026-03-03T11:00:00.000Z"),
      ),
    ).toBe(true);
  });

  it("a nested range overlaps its container", () => {
    expect(overlaps(day("2026-03-01", "2026-03-10"), day("2026-03-03", "2026-03-05"))).toBe(
      true,
    );
  });

  it("is symmetric", () => {
    const a = day("2026-03-01", "2026-03-10");
    const b = day("2026-03-03", "2026-03-05");
    expect(overlaps(a, b)).toBe(overlaps(b, a));
  });

  it("disjoint date-only ranges do not overlap", () => {
    expect(overlaps(day("2026-03-01", "2026-03-02"), day("2026-03-03", "2026-03-04"))).toBe(
      false,
    );
  });

  it("disjoint timed ranges do not overlap", () => {
    expect(
      overlaps(
        timed("2026-03-03T09:00:00.000Z", "2026-03-03T10:00:00.000Z"),
        timed("2026-03-03T11:00:00.000Z", "2026-03-03T12:00:00.000Z"),
      ),
    ).toBe(false);
  });

  it("the same single day overlaps itself", () => {
    expect(overlaps(day("2026-03-03"), day("2026-03-03"))).toBe(true);
  });
});

describe("contains", () => {
  it("contains an instant inside an all-day range", () => {
    expect(contains(day("2026-03-01", "2026-03-05"), "2026-03-03T12:00:00Z")).toBe(true);
  });

  it("contains both inclusive boundaries", () => {
    const range = day("2026-03-01", "2026-03-05");
    expect(contains(range, "2026-03-01T00:00:00.000Z")).toBe(true);
    expect(contains(range, "2026-03-05T23:59:59.999Z")).toBe(true);
  });

  it("rejects instants outside the range", () => {
    const range = day("2026-03-01", "2026-03-05");
    expect(contains(range, "2026-02-28T23:59:59.999Z")).toBe(false);
    expect(contains(range, "2026-03-06T00:00:00.000Z")).toBe(false);
  });
});

describe("durationDays", () => {
  it("counts a single all-day day as one", () => {
    expect(durationDays(day("2026-03-03"))).toBe(1);
  });

  it("counts all-day ranges inclusively", () => {
    expect(durationDays(day("2026-03-03", "2026-03-05"))).toBe(3);
  });

  it("spans a month boundary", () => {
    expect(durationDays(day("2026-02-27", "2026-03-02"))).toBe(4);
  });

  it("spans a year boundary", () => {
    expect(durationDays(day("2026-12-30", "2027-01-02"))).toBe(4);
  });

  it("measures timed ranges as elapsed days", () => {
    expect(durationDays(timed("2026-03-03T06:00:00.000Z", "2026-03-03T18:00:00.000Z"))).toBe(
      0.5,
    );
  });
});

describe("isSameDay", () => {
  it("is true for a single all-day range", () => {
    expect(isSameDay(day("2026-03-03"))).toBe(true);
  });

  it("is false when the range spans days", () => {
    expect(isSameDay(day("2026-03-03", "2026-03-04"))).toBe(false);
  });

  it("is true for a timed range within one UTC day", () => {
    expect(
      isSameDay(timed("2026-03-03T09:00:00.000Z", "2026-03-03T17:00:00.000Z")),
    ).toBe(true);
  });

  it("is false for a timed range crossing UTC midnight", () => {
    expect(
      isSameDay(timed("2026-03-03T23:00:00.000Z", "2026-03-04T01:00:00.000Z")),
    ).toBe(false);
  });
});

describe("formatDateRange", () => {
  it("formats a single day (short)", () => {
    expect(formatDateRange(day("2026-03-03"), { style: "short" })).toBe("Mar 3, 2026");
  });

  it("formats a single day (long)", () => {
    expect(formatDateRange(day("2026-03-03"), { style: "long" })).toBe("March 3, 2026");
  });

  it("defaults to the short style", () => {
    expect(formatDateRange(day("2026-03-03"))).toBe("Mar 3, 2026");
  });

  it("formats a same-year range with a shared trailing year", () => {
    expect(formatDateRange(day("2026-03-03", "2026-03-05"), { style: "short" })).toBe(
      "Mar 3 – Mar 5, 2026",
    );
  });

  it("formats a same-year range (long)", () => {
    expect(formatDateRange(day("2026-03-03", "2026-03-05"), { style: "long" })).toBe(
      "March 3 – March 5, 2026",
    );
  });

  it("formats a cross-year range with both years", () => {
    expect(formatDateRange(day("2026-12-30", "2027-01-02"), { style: "short" })).toBe(
      "Dec 30, 2026 – Jan 2, 2027",
    );
  });
});

describe("isValidTimeZone", () => {
  it("accepts IANA zones and UTC", () => {
    expect(isValidTimeZone("America/New_York")).toBe(true);
    expect(isValidTimeZone("Europe/London")).toBe(true);
    expect(isValidTimeZone("UTC")).toBe(true);
  });

  it("rejects made-up zones and junk", () => {
    expect(isValidTimeZone("Mars/Olympus")).toBe(false);
    expect(isValidTimeZone("Not/AZone")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
    expect(isValidTimeZone("   ")).toBe(false);
    expect(isValidTimeZone(123)).toBe(false);
    expect(isValidTimeZone(undefined)).toBe(false);
  });
});

describe("withTimeZone", () => {
  it("returns a new range carrying a valid zone", () => {
    const base = day("2026-03-03", "2026-03-05");
    const zoned = withTimeZone(base, "America/New_York");
    expect(zoned).toEqual({
      start: "2026-03-03",
      end: "2026-03-05",
      allDay: true,
      timeZone: "America/New_York",
    });
    expect(base.timeZone).toBeUndefined(); // input untouched
    expect(zoned).not.toBe(base);
  });

  it("leaves the range unchanged for an invalid zone", () => {
    const base = withTimeZone(day("2026-03-03"), "Europe/Paris");
    expect(withTimeZone(base, "Mars/Olympus")).toEqual(base);
  });
});

describe("sortRanges", () => {
  it("sorts ascending by start and is stable for equal starts", () => {
    const values: DateValue[] = [
      day("2026-03-05"),
      day("2026-03-01", "2026-03-02"),
      day("2026-03-01", "2026-03-09"),
      day("2026-03-03"),
    ];
    const sorted = sortRanges(values);
    expect(sorted.map((v) => v.start)).toEqual([
      "2026-03-01",
      "2026-03-01",
      "2026-03-03",
      "2026-03-05",
    ]);
    // Stability: the two Mar-1 ranges keep their input order.
    expect(sorted[0].end).toBe("2026-03-02");
    expect(sorted[1].end).toBe("2026-03-09");
  });

  it("does not mutate the input array", () => {
    const values: DateValue[] = [day("2026-03-05"), day("2026-03-01")];
    const sorted = sortRanges(values);
    expect(sorted).not.toBe(values);
    expect(values[0].start).toBe("2026-03-05");
    expect(values[1].start).toBe("2026-03-01");
  });
});

describe("determinism — time-zone and DST independent", () => {
  it("formats the same range identically twice", () => {
    const range = day("2026-07-04", "2026-07-06");
    expect(formatDateRange(range, { style: "short" })).toBe(
      formatDateRange(range, { style: "short" }),
    );
  });

  it("parses the same value identically twice", () => {
    expect(parseDateValue("2026-03-03")).toEqual(parseDateValue("2026-03-03"));
  });

  it("keeps a spring-forward all-day date stable", () => {
    // US DST starts 2026-03-08: an all-day date must not shift by an hour/day.
    const spring = day("2026-03-08");
    expect(formatDateRange(spring, { style: "short" })).toBe("Mar 8, 2026");
    expect(durationDays(spring)).toBe(1);
    expect(isSameDay(spring)).toBe(true);
  });

  it("keeps an autumn-back all-day date stable", () => {
    const autumn = day("2026-11-01");
    expect(formatDateRange(autumn, { style: "short" })).toBe("Nov 1, 2026");
    expect(durationDays(autumn)).toBe(1);
  });
});
