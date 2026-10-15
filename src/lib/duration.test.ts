import { describe, expect, it } from "vitest";
import {
  DEFAULT_DURATION_UNITS,
  addDuration,
  formatDuration,
  humanizeDuration,
  parseDuration,
} from "./duration";

/**
 * Duration parsing/formatting — pure helpers for durations expressed as
 * milliseconds.
 *
 * Written RED-first against a missing module, then implemented. Coverage pins:
 * - `DEFAULT_DURATION_UNITS` aliases → milliseconds,
 * - `parseDuration` for compact ("2h 30m") and ISO-8601 ("PT1H30M") input,
 *   signs, fractions, case-insensitivity and the fail-soft `null`,
 * - `formatDuration` `short` / `long` / `clock` styles, plurals and non-finite,
 * - `humanizeDuration` future/past phrasing and the injected `now`,
 * - `addDuration` immutability and invalid-input handling.
 */

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

describe("DEFAULT_DURATION_UNITS", () => {
  it("maps common aliases to milliseconds", () => {
    expect(DEFAULT_DURATION_UNITS.ms).toBe(1);
    expect(DEFAULT_DURATION_UNITS.s).toBe(SECOND);
    expect(DEFAULT_DURATION_UNITS.min).toBe(MINUTE);
    expect(DEFAULT_DURATION_UNITS.h).toBe(HOUR);
    expect(DEFAULT_DURATION_UNITS.d).toBe(DAY);
    expect(DEFAULT_DURATION_UNITS.w).toBe(WEEK);
  });

  it("maps spelled-out aliases too", () => {
    expect(DEFAULT_DURATION_UNITS.seconds).toBe(SECOND);
    expect(DEFAULT_DURATION_UNITS.minutes).toBe(MINUTE);
    expect(DEFAULT_DURATION_UNITS.hours).toBe(HOUR);
    expect(DEFAULT_DURATION_UNITS.days).toBe(DAY);
  });
});

describe("parseDuration — compact input", () => {
  it("parses multiple components", () => {
    expect(parseDuration("2h 30m")).toBe(2 * HOUR + 30 * MINUTE);
    expect(parseDuration("1 day 2 hours")).toBe(DAY + 2 * HOUR);
  });

  it("parses a single component", () => {
    expect(parseDuration("90m")).toBe(90 * MINUTE);
    expect(parseDuration("45s")).toBe(45 * SECOND);
    expect(parseDuration("500ms")).toBe(500);
  });

  it("accepts fractional values", () => {
    expect(parseDuration("1.5h")).toBe(90 * MINUTE);
  });

  it("is case-insensitive and whitespace tolerant", () => {
    expect(parseDuration("  2H 30M  ")).toBe(2 * HOUR + 30 * MINUTE);
  });

  it("honours a leading sign", () => {
    expect(parseDuration("-2h 30m")).toBe(-(2 * HOUR + 30 * MINUTE));
    expect(parseDuration("+45m")).toBe(45 * MINUTE);
  });

  it("returns null for text without a unit, unknown units or empty input", () => {
    expect(parseDuration("")).toBeNull();
    expect(parseDuration("   ")).toBeNull();
    expect(parseDuration("1000")).toBeNull();
    expect(parseDuration("2h 30x")).toBeNull();
    expect(parseDuration("later")).toBeNull();
  });
});

describe("parseDuration — ISO-8601 input", () => {
  it("parses time components", () => {
    expect(parseDuration("PT1H30M")).toBe(HOUR + 30 * MINUTE);
    expect(parseDuration("PT45S")).toBe(45 * SECOND);
    expect(parseDuration("PT0S")).toBe(0);
  });

  it("parses date and time components", () => {
    expect(parseDuration("P1DT2H")).toBe(DAY + 2 * HOUR);
    expect(parseDuration("P2W")).toBe(2 * WEEK);
  });

  it("parses a fractional component", () => {
    expect(parseDuration("PT0.5H")).toBe(30 * MINUTE);
  });

  it("honours a leading sign and is case-insensitive", () => {
    expect(parseDuration("-PT1H")).toBe(-HOUR);
    expect(parseDuration("pt30m")).toBe(30 * MINUTE);
  });

  it("returns null for malformed ISO durations", () => {
    expect(parseDuration("P")).toBeNull();
    expect(parseDuration("PT")).toBeNull();
    expect(parseDuration("P1DT")).toBeNull();
    expect(parseDuration("P1H")).toBeNull();
  });
});

describe("formatDuration", () => {
  it("formats the short style with compact suffixes", () => {
    expect(formatDuration(2 * HOUR + 30 * MINUTE)).toBe("2h 30m");
    expect(formatDuration(DAY)).toBe("1d");
    expect(formatDuration(45 * MINUTE)).toBe("45m");
  });

  it("defaults to the short style", () => {
    expect(formatDuration(HOUR)).toBe(formatDuration(HOUR, { style: "short" }));
  });

  it("formats the long style with pluralised unit names", () => {
    expect(formatDuration(2 * HOUR + 30 * MINUTE, { style: "long" })).toBe("2 hours 30 minutes");
    expect(formatDuration(DAY, { style: "long" })).toBe("1 day");
  });

  it("renders zero and sub-second durations", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(0, { style: "long" })).toBe("0 seconds");
    expect(formatDuration(500)).toBe("500ms");
  });

  it("keeps the sign of negative durations", () => {
    expect(formatDuration(-(HOUR + 30 * MINUTE))).toBe("-1h 30m");
  });

  it("formats the clock style as HH:MM:SS", () => {
    expect(formatDuration(2 * HOUR + 30 * MINUTE, { style: "clock" })).toBe("02:30:00");
    expect(formatDuration(HOUR + 2 * MINUTE + 3 * SECOND, { style: "clock" })).toBe("01:02:03");
    expect(formatDuration(0, { style: "clock" })).toBe("00:00:00");
    expect(formatDuration(-SECOND, { style: "clock" })).toBe("-00:00:01");
  });

  it("renders an empty string for non-finite input", () => {
    expect(formatDuration(Number.NaN)).toBe("");
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe("");
  });
});

describe("humanizeDuration", () => {
  it("phrases a positive duration as future", () => {
    expect(humanizeDuration(2 * HOUR)).toBe("in 2 hours");
    expect(humanizeDuration(HOUR)).toBe("in 1 hour");
  });

  it("phrases a negative duration as past", () => {
    expect(humanizeDuration(-3 * DAY)).toBe("3 days ago");
    expect(humanizeDuration(-HOUR)).toBe("1 hour ago");
  });

  it("rounds up to the nearest larger whole unit", () => {
    expect(humanizeDuration(90 * MINUTE)).toBe("in 2 hours");
  });

  it("collapses zero and sub-second durations to now", () => {
    expect(humanizeDuration(0)).toBe("now");
    expect(humanizeDuration(300)).toBe("now");
  });

  it("reads an absolute instant against an injected now", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    expect(humanizeDuration(now.getTime() + 3 * DAY, { now })).toBe("in 3 days");
    expect(humanizeDuration(now.getTime() - 3 * DAY, { now })).toBe("3 days ago");
  });

  it("renders an empty string for non-finite input", () => {
    expect(humanizeDuration(Number.NaN)).toBe("");
  });
});

describe("addDuration", () => {
  it("adds milliseconds to an ISO string", () => {
    expect(addDuration("2026-01-01T00:00:00.000Z", 2 * HOUR).toISOString()).toBe(
      "2026-01-01T02:00:00.000Z",
    );
  });

  it("adds milliseconds to epoch millis", () => {
    expect(addDuration(Date.UTC(2026, 0, 1), DAY).toISOString()).toBe("2026-01-02T00:00:00.000Z");
  });

  it("returns a fresh Date and never mutates its input", () => {
    const start = new Date("2026-01-01T00:00:00.000Z");
    const result = addDuration(start, HOUR);
    expect(result.toISOString()).toBe("2026-01-01T01:00:00.000Z");
    expect(result).not.toBe(start);
    expect(start.toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });

  it("returns an invalid Date for a bad date or offset", () => {
    expect(Number.isNaN(addDuration("not a date", HOUR).getTime())).toBe(true);
    expect(Number.isNaN(addDuration(new Date(), Number.NaN).getTime())).toBe(true);
  });
});
