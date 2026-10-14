import { describe, expect, it } from "vitest";
import { nextRunFor } from "./recurrence";

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
