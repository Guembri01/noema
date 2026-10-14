import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { matches, nextOccurrences, nextRunFor, type RecurrenceRule } from "./recurrence";

/**
 * B57 — D4 defect coverage (docs/specs/templates.md D4 / R31.20):
 * `nextRunFor` drifted with execution jitter and monthly `setMonth(+1)` from
 * Jan 31 landed on Mar 3 (February skipped). Written RED-first against the
 * 13-line original:
 * - month-end: Jan-31 → Feb-28 asserted Mar-3 fail (the headline D4 case)
 * - month-end: the third argument did not exist (TS) and was ignored at
 *   runtime, so every anchor expectation failed against `from`-only math
 * - the Feb-28 → Mar-31 "remembered day" chain failed (old: Feb 28 → Mar 28)
 *
 * The catch-up case (stale `nextRunAt` must advance past now with ONE row) is
 * route policy and lives in `src/app/api/cron/templates/route.test.ts`.
 */

const at = (y: number, m: number, d: number, h = 9, min = 0) =>
  new Date(y, m - 1, d, h, min, 0, 0);

describe("nextRunFor — daily/weekly", () => {
  it("daily: same time next day (anchor defaults to from)", () => {
    expect(nextRunFor("daily", at(2026, 1, 1, 9))).toEqual(at(2026, 1, 2, 9));
  });

  it("daily: pins to the anchor time-of-day even when from carries jitter", () => {
    // `from` is a jittered execution moment (09:37), the anchor is the
    // scheduled 09:00 — tomorrow must land on 09:00, not drift to 09:37.
    expect(nextRunFor("daily", at(2026, 1, 1, 9, 37), at(2026, 1, 1, 9))).toEqual(
      at(2026, 1, 2, 9),
    );
  });

  it("weekly: +7 days keeps the weekday and the anchor time", () => {
    const wednesday = at(2026, 1, 7, 9); // 2026-01-07 is a Wednesday
    expect(nextRunFor("weekly", wednesday)).toEqual(at(2026, 1, 14, 9));
    expect(nextRunFor("weekly", at(2026, 1, 7, 9, 12), wednesday)).toEqual(at(2026, 1, 14, 9));
  });

  it("never returns a date at or before from (catch-up precondition)", () => {
    for (const from of [at(2026, 1, 31, 9), at(2026, 2, 28, 9), at(2026, 12, 31, 23, 59)]) {
      for (const recurrence of ["daily", "weekly", "monthly"] as const) {
        expect(nextRunFor(recurrence, from).getTime()).toBeGreaterThan(from.getTime());
      }
    }
  });
});

describe("nextRunFor — monthly month-end (D4 headline)", () => {
  it("Jan 31 → Feb 28 in a non-leap year, never Mar 3", () => {
    const next = nextRunFor("monthly", at(2026, 1, 31, 9));
    // Red-first tail: the old `setMonth(+1)` produced 2026-03-03T09:00 —
    // February was skipped entirely.
    expect(next).toEqual(at(2026, 2, 28, 9));
  });

  it("Jan 31 → Feb 29 in a leap year", () => {
    expect(nextRunFor("monthly", at(2024, 1, 31, 9))).toEqual(at(2024, 2, 29, 9));
  });

  it("remembers the anchor day through the clamp: Feb 28 → Mar 31 (not Mar 28)", () => {
    const anchor = at(2026, 1, 31, 9);
    // Red-first tail: without the anchor parameter this chain settled on
    // Mar 28 — the 31st was lost after the February clamp.
    expect(nextRunFor("monthly", at(2026, 2, 28, 9), anchor)).toEqual(at(2026, 3, 31, 9));
  });

  it("full D4 chain: Jan 31 → Feb 28 → Mar 31, one run per month, time pinned", () => {
    const anchor = at(2026, 1, 31, 9);
    let cursor = at(2026, 1, 31, 9);
    const walked: Date[] = [];
    for (let i = 0; i < 3; i += 1) {
      cursor = nextRunFor("monthly", cursor, anchor);
      walked.push(cursor);
    }
    expect(walked).toEqual([at(2026, 2, 28, 9), at(2026, 3, 31, 9), at(2026, 4, 30, 9)]);
  });

  it("keeps the anchor time-of-day across a month with a late-night from", () => {
    expect(
      nextRunFor("monthly", at(2026, 2, 28, 23, 58), at(2026, 1, 31, 9)),
    ).toEqual(at(2026, 3, 31, 9));
  });

  it("rolls the year: Dec 15 → Jan 15 next year", () => {
    expect(nextRunFor("monthly", at(2026, 12, 15, 9))).toEqual(at(2027, 1, 15, 9));
  });

  it("without a stored anchor (anchor defaults to from) the clamp still holds", () => {
    // Characterization: callers that never stored an anchor keep a correct,
    // clamped schedule — the day settles at the clamped date until R31.20's
    // `config.anchorAt` write path (setTemplateRecurrenceAction, database.ts,
    // deferred) can restore the original day-of-month.
    expect(nextRunFor("monthly", at(2026, 1, 31, 9))).toEqual(at(2026, 2, 28, 9));
    expect(nextRunFor("monthly", at(2026, 2, 28, 9))).toEqual(at(2026, 3, 28, 9));
  });
});

/**
 * §20 recurring tickets + §3 scheduled row creation — the generalized rules
 * engine: `RecurrenceRule` (freq + interval + ByDay + byMonthDay), the list
 * helper `nextOccurrences(rule, from, count)` and the predicate
 * `matches(rule, date)`. Written RED-first: none of the three exports
 * existed, so every case below failed at compile time (`tsc`: TS2305,
 * "has no exported member") and at runtime before the engine landed.
 *
 * Contract pinned here:
 * - results are strictly ascending and every instant is `> from`;
 * - `start` (`Date` or ISO string) is the schedule epoch: it aligns interval
 *   math, anchors a bare weekly's weekday / a bare monthly's day-of-month,
 *   and nothing fires before it. Without `start` the epoch falls back to
 *   1970-01-01 local — deterministic, and `matches` uses the same epoch so
 *   the two helpers can never disagree;
 * - wall clock comes from `hour`/`minute` when set, otherwise from `from`
 *   (the D4 anti-drift rule), and stays fixed across DST gaps;
 * - month-end clamps remember the raw day: Jan 31 → Feb 28 → Mar 31.
 */

describe("nextOccurrences — daily cadence + interval", () => {
  it("daily: the next N days at the same wall clock", () => {
    expect(nextOccurrences({ freq: "daily" }, at(2026, 1, 1, 9), 3)).toEqual([
      at(2026, 1, 2, 9),
      at(2026, 1, 3, 9),
      at(2026, 1, 4, 9),
    ]);
  });

  it("every 2 days from a start (ISO date-only or Date align identically)", () => {
    const from = at(2026, 1, 1, 9);
    const viaString = nextOccurrences(
      { freq: "daily", interval: 2, start: "2026-01-01" },
      from,
      3,
    );
    const viaDate = nextOccurrences(
      { freq: "daily", interval: 2, start: at(2026, 1, 1, 9) },
      from,
      3,
    );
    const expected = [at(2026, 1, 3, 9), at(2026, 1, 5, 9), at(2026, 1, 7, 9)];
    expect(viaString).toEqual(expected);
    expect(viaDate).toEqual(expected);
  });

  it("rule hour fires on the start day while it is still ahead of from", () => {
    expect(nextOccurrences({ freq: "daily", hour: 14 }, at(2026, 1, 1, 9), 2)).toEqual([
      at(2026, 1, 1, 14),
      at(2026, 1, 2, 14),
    ]);
  });

  it("never fires before start, even when from sits before the epoch", () => {
    expect(
      nextOccurrences({ freq: "daily", start: "2026-01-10", hour: 9 }, at(2026, 1, 1, 9), 3),
    ).toEqual([at(2026, 1, 10, 9), at(2026, 1, 11, 9), at(2026, 1, 12, 9)]);
  });

  it("an occurrence landing exactly on from is skipped (strictly-after)", () => {
    const rule: RecurrenceRule = { freq: "daily", interval: 2, start: "2026-01-01" };
    expect(nextOccurrences(rule, at(2026, 1, 3, 9), 1)).toEqual([at(2026, 1, 5, 9)]);
  });

  it("normalizes hostile input: count ≤ 0 → [], interval 0 → 1, 2.7 → 2, hour 25/minute 99 clamp", () => {
    expect(nextOccurrences({ freq: "daily" }, at(2026, 1, 1, 9), 0)).toEqual([]);
    expect(nextOccurrences({ freq: "daily" }, at(2026, 1, 1, 9), -2)).toEqual([]);
    expect(nextOccurrences({ freq: "daily", interval: 0 }, at(2026, 1, 1, 9), 2)).toEqual([
      at(2026, 1, 2, 9),
      at(2026, 1, 3, 9),
    ]);
    expect(
      nextOccurrences({ freq: "daily", interval: 2.7, start: "2026-01-01" }, at(2026, 1, 1, 9), 2),
    ).toEqual([at(2026, 1, 3, 9), at(2026, 1, 5, 9)]);
    expect(nextOccurrences({ freq: "daily", hour: 25, minute: 99 }, at(2026, 1, 1, 9), 1)).toEqual([
      at(2026, 1, 1, 23, 59),
    ]);
  });
});

describe("nextOccurrences — weekly ByDay + interval", () => {
  it("Mon/Wed/Fri from a Monday start", () => {
    const rule: RecurrenceRule = {
      freq: "weekly",
      byDay: ["mon", "wed", "fri"],
      start: "2026-01-05",
      hour: 9,
    };
    expect(nextOccurrences(rule, at(2026, 1, 5, 9), 4)).toEqual([
      at(2026, 1, 7, 9),
      at(2026, 1, 9, 9),
      at(2026, 1, 12, 9),
      at(2026, 1, 14, 9),
    ]);
  });

  it("interval 2 skips the off-week entirely", () => {
    const rule: RecurrenceRule = {
      freq: "weekly",
      interval: 2,
      byDay: ["mon", "wed", "fri"],
      start: "2026-01-05",
      hour: 9,
    };
    expect(nextOccurrences(rule, at(2026, 1, 5, 9), 5)).toEqual([
      at(2026, 1, 7, 9),
      at(2026, 1, 9, 9),
      at(2026, 1, 19, 9),
      at(2026, 1, 21, 9),
      at(2026, 1, 23, 9),
    ]);
  });

  it("bare weekly anchors its weekday to start (Wednesday)", () => {
    expect(nextOccurrences({ freq: "weekly", start: "2026-01-07" }, at(2026, 1, 7, 9), 3)).toEqual([
      at(2026, 1, 14, 9),
      at(2026, 1, 21, 9),
      at(2026, 1, 28, 9),
    ]);
  });

  it("bare weekly without start falls back to the 1970-01-01 (Thursday) epoch weekday", () => {
    expect(nextOccurrences({ freq: "weekly" }, at(2026, 1, 5, 9), 2)).toEqual([
      at(2026, 1, 8, 9),
      at(2026, 1, 15, 9),
    ]);
  });
});

describe("nextOccurrences — monthly byMonthDay + month-end clamp", () => {
  it("Jan 31 anchor → Feb 28 → Mar 31 → Apr 30 (day remembered, not incremented)", () => {
    const rule: RecurrenceRule = { freq: "monthly", start: "2026-01-31", hour: 9 };
    expect(nextOccurrences(rule, at(2026, 1, 31, 9), 3)).toEqual([
      at(2026, 2, 28, 9),
      at(2026, 3, 31, 9),
      at(2026, 4, 30, 9),
    ]);
  });

  it("leap year: Jan 31 → Feb 29", () => {
    expect(
      nextOccurrences({ freq: "monthly", start: "2024-01-31" }, at(2024, 1, 31, 9), 1),
    ).toEqual([at(2024, 2, 29, 9)]);
  });

  it("explicit byMonthDay 15 decouples from the start day", () => {
    expect(
      nextOccurrences({ freq: "monthly", byMonthDay: 15, start: "2026-01-01" }, at(2026, 1, 1, 9), 3),
    ).toEqual([at(2026, 1, 15, 9), at(2026, 2, 15, 9), at(2026, 3, 15, 9)]);
  });

  it("multiple byMonthDays fire in ascending order inside the month", () => {
    expect(
      nextOccurrences(
        { freq: "monthly", byMonthDay: [1, 15], start: "2026-01-01" },
        at(2026, 1, 1, 9),
        4,
      ),
    ).toEqual([at(2026, 1, 15, 9), at(2026, 2, 1, 9), at(2026, 2, 15, 9), at(2026, 3, 1, 9)]);
  });

  it("byMonthDay 31 clamps per month while remembering 31", () => {
    expect(
      nextOccurrences({ freq: "monthly", byMonthDay: 31, start: "2026-01-01" }, at(2026, 1, 1, 9), 4),
    ).toEqual([at(2026, 1, 31, 9), at(2026, 2, 28, 9), at(2026, 3, 31, 9), at(2026, 4, 30, 9)]);
  });

  it("interval 2 skips every other month", () => {
    expect(
      nextOccurrences({ freq: "monthly", interval: 2, start: "2026-01-15" }, at(2026, 1, 15, 9), 3),
    ).toEqual([at(2026, 3, 15, 9), at(2026, 5, 15, 9), at(2026, 7, 15, 9)]);
  });
});

describe("matches — predicate agrees with the list", () => {
  it("daily: interval parity, day-level clock when no hour, epoch cutoff", () => {
    const rule: RecurrenceRule = { freq: "daily", interval: 2, start: "2026-01-01" };
    expect(matches(rule, at(2026, 1, 1, 9))).toBe(true);
    expect(matches(rule, at(2026, 1, 2, 9))).toBe(false);
    expect(matches(rule, at(2026, 1, 3, 23, 59))).toBe(true); // day-level without hour
    expect(matches(rule, at(2025, 12, 31, 9))).toBe(false); // before start
  });

  it("weekly ByDay honours the rule clock to the minute", () => {
    const rule: RecurrenceRule = {
      freq: "weekly",
      byDay: ["mon", "wed", "fri"],
      start: "2026-01-05",
      hour: 9,
    };
    expect(matches(rule, at(2026, 1, 5, 9))).toBe(true);
    expect(matches(rule, at(2026, 1, 6, 9))).toBe(false); // Tuesday
    expect(matches(rule, at(2026, 1, 7, 10))).toBe(false); // 10:00 ≠ 09:00
    expect(matches(rule, at(2026, 1, 7, 9, 30))).toBe(false); // :30 ≠ :00
    expect(matches(rule, at(2026, 1, 12, 9))).toBe(true);
  });

  it("weekly interval 2: the off-week does not match", () => {
    const rule: RecurrenceRule = { freq: "weekly", interval: 2, byDay: ["mon"], start: "2026-01-05" };
    expect(matches(rule, at(2026, 1, 5, 9))).toBe(true);
    expect(matches(rule, at(2026, 1, 12, 9))).toBe(false);
    expect(matches(rule, at(2026, 1, 19, 9))).toBe(true);
  });

  it("monthly byMonthDay 31 matches the clamped last day of shorter months", () => {
    const rule: RecurrenceRule = { freq: "monthly", byMonthDay: 31, start: "2026-01-01" };
    expect(matches(rule, at(2026, 1, 31))).toBe(true);
    expect(matches(rule, at(2026, 2, 28))).toBe(true); // clamped February fire
    expect(matches(rule, at(2026, 2, 27))).toBe(false);
    expect(matches(rule, at(2026, 3, 31))).toBe(true);
    expect(matches(rule, at(2026, 3, 30))).toBe(false);
    // Leap-year clamp honours the rule's own epoch.
    expect(matches({ freq: "monthly", byMonthDay: 31, start: "2024-01-01" }, at(2024, 2, 29))).toBe(
      true,
    );
  });

  it("every occurrence produced by nextOccurrences satisfies matches, ascending", () => {
    const rules: RecurrenceRule[] = [
      { freq: "daily", interval: 2, start: "2026-01-01", hour: 9 },
      { freq: "weekly", byDay: ["mon", "wed", "fri"], start: "2026-01-05", hour: 9 },
      { freq: "weekly", interval: 2, start: "2026-01-07", hour: 9 },
      { freq: "monthly", byMonthDay: 31, start: "2026-01-01", hour: 9 },
      { freq: "monthly", interval: 3, start: "2026-02-15", hour: 9 },
    ];
    for (const rule of rules) {
      const from = at(2026, 1, 1, 9);
      const occurrences = nextOccurrences(rule, from, 6);
      expect(occurrences).toHaveLength(6);
      let cursor = from;
      for (const occurrence of occurrences) {
        expect(matches(rule, occurrence)).toBe(true);
        expect(occurrence.getTime()).toBeGreaterThan(cursor.getTime());
        cursor = occurrence;
      }
    }
  });
});

describe("DST / time-zone safety (fixed America/New_York)", () => {
  // Node reads `process.env.TZ` at Date-construction time, and vitest runs
  // this file in its own isolated worker, so pinning the zone here cannot
  // leak into other suites; the ambient value is restored in afterAll.
  // New York 2026: spring-forward Sun Mar 8 (02:00 → 03:00),
  // fall-back Sun Nov 1 (02:00 → 01:00).
  const ORIGINAL_TZ = process.env.TZ;
  beforeAll(() => {
    process.env.TZ = "America/New_York";
  });
  afterAll(() => {
    if (ORIGINAL_TZ === undefined) delete process.env.TZ;
    else process.env.TZ = ORIGINAL_TZ;
  });

  it("daily 09:00 holds its wall clock across spring-forward (+24h math drifts to 10:00)", () => {
    expect(nextOccurrences({ freq: "daily", hour: 9 }, at(2026, 3, 6, 9), 4)).toEqual([
      at(2026, 3, 7, 9),
      at(2026, 3, 8, 9),
      at(2026, 3, 9, 9),
      at(2026, 3, 10, 9),
    ]);
  });

  it("daily 09:00 holds its wall clock across fall-back (+24h math drifts to 08:00)", () => {
    expect(nextOccurrences({ freq: "daily", hour: 9 }, at(2026, 10, 30, 9), 3)).toEqual([
      at(2026, 10, 31, 9),
      at(2026, 11, 1, 9),
      at(2026, 11, 2, 9),
    ]);
  });

  it("interval stepping + a date-only start survive the gap (UTC parse would shift the epoch a day)", () => {
    expect(
      nextOccurrences(
        { freq: "daily", interval: 2, start: "2026-03-06", hour: 9 },
        at(2026, 3, 6, 9),
        3,
      ),
    ).toEqual([at(2026, 3, 8, 9), at(2026, 3, 10, 9), at(2026, 3, 12, 9)]);
  });

  it("a wall clock inside the gap rolls forward once, then returns (no carried drift)", () => {
    expect(nextOccurrences({ freq: "daily" }, at(2026, 3, 7, 2, 30), 3)).toEqual([
      at(2026, 3, 8, 3, 30),
      at(2026, 3, 9, 2, 30),
      at(2026, 3, 10, 2, 30),
    ]);
  });

  it("the fall-back overlap resolves to the first (EDT) pass and keeps 01:30 thereafter", () => {
    const occurrences = nextOccurrences(
      { freq: "daily", hour: 1, minute: 30 },
      at(2026, 10, 31, 1, 30),
      3,
    );
    expect(occurrences).toEqual([
      at(2026, 11, 1, 1, 30),
      at(2026, 11, 2, 1, 30),
      at(2026, 11, 3, 1, 30),
    ]);
    expect(occurrences[0].getTimezoneOffset()).toBe(240); // 01:30 EDT (first pass)
    expect(occurrences[1].getTimezoneOffset()).toBe(300); // 01:30 EST
  });

  it("weekly ByDay crosses spring-forward keeping 09:00", () => {
    expect(
      nextOccurrences(
        { freq: "weekly", byDay: ["mon"], start: "2026-03-02", hour: 9 },
        at(2026, 3, 6, 9),
        4,
      ),
    ).toEqual([at(2026, 3, 9, 9), at(2026, 3, 16, 9), at(2026, 3, 23, 9), at(2026, 3, 30, 9)]);
  });

  it("the Jan-31 monthly chain keeps 09:00 through the DST change", () => {
    expect(
      nextOccurrences({ freq: "monthly", start: "2026-01-31", hour: 9 }, at(2026, 1, 31, 9), 3),
    ).toEqual([at(2026, 2, 28, 9), at(2026, 3, 31, 9), at(2026, 4, 30, 9)]);
  });
});
