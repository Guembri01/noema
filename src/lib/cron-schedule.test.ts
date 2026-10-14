import { describe, expect, it } from "vitest";
import {
  describeCron,
  isValidCron,
  matchesCron,
  nextRuns,
  parseCron,
} from "./cron-schedule";

/**
 * Cron expression utilities (docs/specs/scheduling.md): a pure, UTC,
 * dependency-free parser / matcher / describer for 5-field cron expressions
 * (`minute hour day-of-month month day-of-week`).
 *
 * Red-first: `src/lib/cron-schedule.ts` does not exist until this lands — the
 * first run fails to resolve the import, then the suite goes green with the
 * implementation.
 *
 * Everything is deterministic: every instant is built with `Date.UTC`, the
 * module never reads the wall clock, and `nextRuns` is handed its `from` date.
 * `dayOfWeek` uses `getUTCDay` numbering (0 = Sunday .. 6 = Saturday).
 *
 * Calendar pins (2026): Jun 1 Mon, Jun 2 Tue, Jun 3 Wed, Jun 5 Fri, Jun 8 Mon,
 * Jun 15 Mon.
 */

const utc = (y: number, m: number, d: number, h = 0, min = 0, s = 0) =>
  new Date(Date.UTC(y, m - 1, d, h, min, s));

describe("parseCron", () => {
  it("expands wildcards and keeps lists/ranges/steps sorted and unique", () => {
    expect(parseCron("30 9 * * *")).toMatchObject({ minute: [30], hour: [9] });
    expect(parseCron("30 9 * * *").dayOfMonth).toHaveLength(31);
    expect(parseCron("0,30 8-10/2 * * 1-5")).toMatchObject({
      minute: [0, 30],
      hour: [8, 10],
      dayOfWeek: [1, 2, 3, 4, 5],
    });
    expect(parseCron("*/20,0-40/20 * * * *").minute).toEqual([0, 20, 40]);
  });

  it("records a literal `*` separately from an equivalent range", () => {
    expect(parseCron("0 0 * * *")).toMatchObject({ domWildcard: true, dowWildcard: true });
    expect(parseCron("0 0 1-31 * *").domWildcard).toBe(false);
  });

  it("rejects a malformed expression with a field-specific error", () => {
    expect(() => parseCron("0 0 * *")).toThrow(/5 fields/);
    expect(() => parseCron("60 0 * * *")).toThrow(/minute/);
    expect(() => parseCron("0 0 * * 7")).toThrow(/day of week/);
  });
});

describe("isValidCron", () => {
  it("accepts well-formed expressions and rejects malformed ones", () => {
    expect(["* * * * *", "*/5 0 1 1 0"].every((e) => isValidCron(e))).toBe(true);
    expect(
      ["", "60 * * * *", "0 0 * * MON", "0 0 * * 5-1", "0 0 * * */0", "0 0 * * 5/10"].every(
        (e) => !isValidCron(e),
      ),
    ).toBe(true);
  });
});

describe("matchesCron", () => {
  it("matches the exact UTC minute and ignores seconds", () => {
    const at = utc(2026, 6, 1, 9, 30, 45);
    expect(matchesCron("30 9 * * *", at)).toBe(true);
    expect(matchesCron("31 9 * * *", at)).toBe(false);
  });

  it("matches the UTC day-of-week and month", () => {
    const monday = utc(2026, 6, 1, 9, 30);
    expect(matchesCron("30 9 * * 1", monday)).toBe(true);
    expect(matchesCron("30 9 * 6 *", monday)).toBe(true);
  });

  it("ORs dom/dow when both are restricted, ANDs when one is `*`", () => {
    const first = utc(2026, 6, 1, 0, 0); // Monday the 1st
    expect(matchesCron("0 0 15 * 1", first)).toBe(true); // dow matches
    expect(matchesCron("0 0 1 * 2", first)).toBe(true); // dom matches
    expect(matchesCron("0 0 15 * 2", first)).toBe(false); // neither
    expect(matchesCron("0 0 * * 2", first)).toBe(false); // AND via wildcard dom
  });

  it("returns false for an invalid expression or date", () => {
    expect(matchesCron("nope", utc(2026, 6, 1))).toBe(false);
    expect(matchesCron("* * * * *", new Date("nope"))).toBe(false);
  });
});

describe("nextRuns", () => {
  it("lists the next runs strictly after `from`", () => {
    expect(nextRuns("*/15 * * * *", utc(2026, 6, 1, 9, 30), 3)).toEqual([
      utc(2026, 6, 1, 9, 45),
      utc(2026, 6, 1, 10, 0),
      utc(2026, 6, 1, 10, 15),
    ]);
  });

  it("excludes an instant exactly equal to `from`", () => {
    expect(nextRuns("0 0 * * *", utc(2026, 6, 1, 0, 0), 1)).toEqual([utc(2026, 6, 2, 0, 0)]);
  });

  it("rolls across midnight", () => {
    expect(nextRuns("0 0 * * *", utc(2026, 6, 1, 23, 59, 30), 2)).toEqual([
      utc(2026, 6, 2, 0, 0),
      utc(2026, 6, 3, 0, 0),
    ]);
  });

  it("honours a weekday restriction", () => {
    expect(nextRuns("0 9 * * 1", utc(2026, 6, 5, 0, 0), 2)).toEqual([
      utc(2026, 6, 8, 9, 0),
      utc(2026, 6, 15, 9, 0),
    ]);
  });

  it("ORs dom/dow when both are restricted", () => {
    // Jun 2026 Mondays: 1, 8, 15, 22, 29; the 15th also matches the dom.
    expect(nextRuns("0 0 15 * 1", utc(2026, 6, 1, 0, 0), 1)).toEqual([utc(2026, 6, 8, 0, 0)]);
  });

  it("returns nothing for an impossible or invalid request", () => {
    expect(nextRuns("0 0 31 2 *", utc(2026, 6, 1), 1)).toEqual([]);
    expect(nextRuns("bad", utc(2026, 6, 1), 1)).toEqual([]);
  });
});

describe("describeCron", () => {
  it("describes every-minute, stepped and hourly schedules", () => {
    expect(describeCron("* * * * *")).toBe("Every minute");
    expect(describeCron("*/15 * * * *")).toBe("Every 15 minutes");
    expect(describeCron("0 * * * *")).toBe("Every hour");
  });

  it("describes daily and weekly schedules", () => {
    expect(describeCron("0 0 * * *")).toBe("Every day at 00:00");
    expect(describeCron("0 9 * * 1-5")).toBe("Every weekday at 09:00");
  });

  it("describes monthly and month-scoped schedules", () => {
    expect(describeCron("0 0 1 * *")).toBe("Monthly on day 1 at 00:00");
    expect(describeCron("0 0 * 1 *")).toBe("Every day in January at 00:00");
  });

  it("describes a dom-OR-dow schedule and rejects garbage", () => {
    expect(describeCron("0 0 1 * 3")).toBe("On day 1 or Wednesday at 00:00");
    expect(() => describeCron("0 0 * *")).toThrow(/5 fields/);
  });
});
