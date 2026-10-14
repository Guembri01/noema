import { describe, expect, it } from "vitest";
import {
  isWithinQuietHours,
  mergeSchedules,
  nextDeliveryTime,
  validateSchedule,
} from "./notification-schedule";
import type { QuietSchedule } from "./notification-schedule";

/**
 * Notification quiet hours / do-not-disturb (docs/specs/notifications.md
 * delivery window; the DND half of "Notification preferences").
 *
 * Red-first: `src/lib/notification-schedule.ts` does not exist until this lands
 * - the first run fails to resolve the import, then the suite goes green with
 * the implementation.
 *
 * Everything is deterministic: every instant is built with `Date.UTC` and the
 * schedule carries an explicit `timezoneOffsetMinutes`, so no assertion depends
 * on the machine's timezone or the wall clock. `days` uses the `getUTCDay`
 * numbering (0 = Sunday .. 6 = Saturday) and the window is `[start, end)`.
 *
 * Calendar pins (2026): May 31 Sun, Jun 1 Mon, Jun 2 Tue, Jun 3 Wed,
 * Jun 5 Fri, Jun 6 Sat.
 */

const MIN = (h: number, m = 0): number => h * 60 + m;

/** A quiet schedule; defaults to Monday 22:00-07:00 UTC. */
function sched(overrides: Partial<QuietSchedule> = {}): QuietSchedule {
  return {
    days: [1],
    startMinutes: MIN(22),
    endMinutes: MIN(7),
    timezoneOffsetMinutes: 0,
    ...overrides,
  };
}

const SUN = (h: number, m = 0) => new Date(Date.UTC(2026, 4, 31, h, m));
const MON = (h: number, m = 0) => new Date(Date.UTC(2026, 5, 1, h, m));
const TUE = (h: number, m = 0) => new Date(Date.UTC(2026, 5, 2, h, m));
const WED = (h: number, m = 0) => new Date(Date.UTC(2026, 5, 3, h, m));
const FRI = (h: number, m = 0) => new Date(Date.UTC(2026, 5, 5, h, m));
const SAT = (h: number, m = 0) => new Date(Date.UTC(2026, 5, 6, h, m));

describe("isWithinQuietHours - same-day window", () => {
  const workHours = sched({ days: [3], startMinutes: MIN(9), endMinutes: MIN(17) });

  it("is quiet inside [start, end) and open at the boundaries", () => {
    expect(isWithinQuietHours(WED(10), workHours)).toBe(true);
    expect(isWithinQuietHours(WED(9), workHours)).toBe(true); // start inclusive
    expect(isWithinQuietHours(WED(16, 59), workHours)).toBe(true);
    expect(isWithinQuietHours(WED(17), workHours)).toBe(false); // end exclusive
    expect(isWithinQuietHours(WED(8, 59), workHours)).toBe(false);
  });

  it("ignores days that are not selected", () => {
    expect(isWithinQuietHours(TUE(10), workHours)).toBe(false);
    expect(isWithinQuietHours(WED(10), sched({ days: [1], startMinutes: MIN(9), endMinutes: MIN(17) }))).toBe(false);
  });
});

describe("isWithinQuietHours - wrap past midnight", () => {
  const fridayNight = sched({ days: [5], startMinutes: MIN(22), endMinutes: MIN(7) });

  it("covers the evening on the selected day", () => {
    expect(isWithinQuietHours(FRI(23, 30), fridayNight)).toBe(true);
    expect(isWithinQuietHours(FRI(21, 59), fridayNight)).toBe(false);
  });

  it("stays quiet into the next morning, up to (not including) the end", () => {
    expect(isWithinQuietHours(SAT(3), fridayNight)).toBe(true);
    expect(isWithinQuietHours(SAT(6, 59), fridayNight)).toBe(true);
    expect(isWithinQuietHours(SAT(7), fridayNight)).toBe(false); // end exclusive
  });

  it("does not bleed a morning window from an unselected day", () => {
    // Saturday is not selected, so Sunday morning has no Friday-into-Sunday run.
    expect(isWithinQuietHours(SUN(3), fridayNight)).toBe(false);
  });
});

describe("isWithinQuietHours - explicit timezone offset", () => {
  it("shifts the instant east before reading the local day and minute", () => {
    const mondayNight = sched({ days: [1], startMinutes: MIN(22), endMinutes: MIN(7), timezoneOffsetMinutes: 120 });
    expect(isWithinQuietHours(MON(20), mondayNight)).toBe(true); // 20:00Z -> Mon 22:00 local
    expect(isWithinQuietHours(MON(19, 59), mondayNight)).toBe(false); // 21:59 local
    // The same instant is open with no offset (20:00 local, window starts 22:00).
    expect(isWithinQuietHours(MON(20), sched({ days: [1], startMinutes: MIN(22), endMinutes: MIN(7) }))).toBe(false);
    // 01:00Z Tuesday is 03:00 local Tuesday: still inside Monday's overnight run.
    expect(isWithinQuietHours(TUE(1), mondayNight)).toBe(true);
  });

  it("handles a negative (west) offset", () => {
    const sundayDay = sched({ days: [0], startMinutes: MIN(9), endMinutes: MIN(17), timezoneOffsetMinutes: -300 });
    expect(isWithinQuietHours(SUN(15), sundayDay)).toBe(true); // 15:00Z -> Sun 10:00 local
    expect(isWithinQuietHours(SUN(9), sundayDay)).toBe(false); // 04:00 local
  });
});

describe("isWithinQuietHours - degenerate schedules fail open", () => {
  it("covers a whole day with a 00:00-24:00 window", () => {
    const allTuesday = sched({ days: [2], startMinutes: 0, endMinutes: 1440 });
    expect(isWithinQuietHours(TUE(0), allTuesday)).toBe(true);
    expect(isWithinQuietHours(TUE(12), allTuesday)).toBe(true);
    expect(isWithinQuietHours(MON(23, 59), allTuesday)).toBe(false);
  });

  it("never mutes an empty day list or a zero-duration window", () => {
    expect(isWithinQuietHours(WED(10), sched({ days: [] }))).toBe(false);
    expect(isWithinQuietHours(WED(10), sched({ days: [3], startMinutes: MIN(5), endMinutes: MIN(5) }))).toBe(false);
  });
});

describe("nextDeliveryTime", () => {
  it("returns the instant untouched when it is already open", () => {
    const open = WED(18);
    expect(nextDeliveryTime(open, sched({ days: [3], startMinutes: MIN(9), endMinutes: MIN(17) }))).toEqual(open);
    expect(nextDeliveryTime(open, sched({ days: [] }))).toEqual(open);
  });

  it("advances to the window end for a same-day window", () => {
    const next = nextDeliveryTime(WED(10), sched({ days: [3], startMinutes: MIN(9), endMinutes: MIN(17) }));
    expect(next).toBeInstanceOf(Date);
    expect(next).toEqual(WED(17));
  });

  it("advances an evening instant to the next morning's end", () => {
    const fridayNight = sched({ days: [5], startMinutes: MIN(22), endMinutes: MIN(7) });
    expect(nextDeliveryTime(FRI(23), fridayNight)).toEqual(SAT(7));
    expect(nextDeliveryTime(SAT(3), fridayNight)).toEqual(SAT(7)); // overnight tail
  });

  it("applies the timezone offset to the returned instant", () => {
    const mondayNight = sched({ days: [1], startMinutes: MIN(22), endMinutes: MIN(7), timezoneOffsetMinutes: 120 });
    // Mon 20:00Z = Mon 22:00 local -> next open is Tue 07:00 local = Tue 05:00Z.
    expect(nextDeliveryTime(MON(20), mondayNight)).toEqual(TUE(5));
  });

  it("treats the window end as the first deliverable instant", () => {
    const workHours = sched({ days: [3], startMinutes: MIN(9), endMinutes: MIN(17) });
    const next = nextDeliveryTime(WED(10), workHours);
    expect(next).toEqual(WED(17));
    expect(isWithinQuietHours(next, workHours)).toBe(false);
  });

  it("never returns an instant that is still inside quiet hours", () => {
    const fridayNight = sched({ days: [5], startMinutes: MIN(22), endMinutes: MIN(7) });
    expect(isWithinQuietHours(nextDeliveryTime(FRI(23), fridayNight), fridayNight)).toBe(false);
    expect(isWithinQuietHours(nextDeliveryTime(SAT(3), fridayNight), fridayNight)).toBe(false);
  });
});

describe("mergeSchedules", () => {
  it("unions the days of schedules that share a window and offset", () => {
    const merged = mergeSchedules([
      sched({ days: [2, 1] }),
      sched({ days: [3, 2] }),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toEqual(sched({ days: [1, 2, 3] }));
  });

  it("keeps genuinely different windows separate, sorted deterministically", () => {
    const merged = mergeSchedules([
      sched({ days: [3], startMinutes: MIN(9), endMinutes: MIN(17) }),
      sched({ days: [1], startMinutes: MIN(22), endMinutes: MIN(7) }),
      sched({ days: [2], startMinutes: MIN(9), endMinutes: MIN(17), timezoneOffsetMinutes: 120 }),
    ]);
    expect(merged).toEqual([
      sched({ days: [3], startMinutes: MIN(9), endMinutes: MIN(17) }),
      sched({ days: [1], startMinutes: MIN(22), endMinutes: MIN(7) }),
      sched({ days: [2], startMinutes: MIN(9), endMinutes: MIN(17), timezoneOffsetMinutes: 120 }),
    ]);
  });

  it("collapses duplicates and drops invalid or day-less schedules", () => {
    const merged = mergeSchedules([
      sched({ days: [1] }),
      sched({ days: [1] }),
      sched({ days: [] }),
      { days: [9], startMinutes: -1, endMinutes: 9999, timezoneOffsetMinutes: 0 },
    ]);
    expect(merged).toEqual([sched({ days: [1] })]);
  });

  it("returns an empty list for empty input", () => {
    expect(mergeSchedules([])).toEqual([]);
  });

  it("does not mutate its input and hands back fresh arrays", () => {
    const input = [sched({ days: [2, 1] })];
    const before = JSON.parse(JSON.stringify(input));
    const merged = mergeSchedules(input);
    expect(input).toEqual(before);
    expect(merged[0]?.days).not.toBe(input[0]?.days);
  });
});

describe("validateSchedule", () => {
  it("accepts a well-formed schedule and normalizes days", () => {
    const result = validateSchedule({
      days: [5, 1, 5, 3],
      startMinutes: MIN(22),
      endMinutes: MIN(7),
      timezoneOffsetMinutes: 120,
    });
    expect(result).toEqual({
      ok: true,
      value: { days: [1, 3, 5], startMinutes: MIN(22), endMinutes: MIN(7), timezoneOffsetMinutes: 120 },
    });
  });

  it("rejects anything that is not a plain object", () => {
    for (const junk of [undefined, null, "quiet", 7, []]) {
      const result = validateSchedule(junk);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(typeof result.error).toBe("string");
    }
  });

  it("rejects malformed days", () => {
    const base = { startMinutes: MIN(22), endMinutes: MIN(7), timezoneOffsetMinutes: 0 };
    expect(validateSchedule({ ...base, days: "monday" }).ok).toBe(false);
    expect(validateSchedule({ ...base, days: [7] }).ok).toBe(false);
    expect(validateSchedule({ ...base, days: [-1] }).ok).toBe(false);
    expect(validateSchedule({ ...base, days: [1.5] }).ok).toBe(false);
  });

  it("rejects out-of-range minutes and a zero-duration window", () => {
    const base = { days: [1], timezoneOffsetMinutes: 0 };
    expect(validateSchedule({ ...base, startMinutes: -1, endMinutes: MIN(7) }).ok).toBe(false);
    expect(validateSchedule({ ...base, startMinutes: 1440, endMinutes: 1440 }).ok).toBe(false);
    expect(validateSchedule({ ...base, startMinutes: MIN(9), endMinutes: 1441 }).ok).toBe(false);
    expect(validateSchedule({ ...base, startMinutes: MIN(9), endMinutes: MIN(9) }).ok).toBe(false);
  });

  it("rejects an out-of-range timezone offset", () => {
    const base = { days: [1], startMinutes: MIN(22), endMinutes: MIN(7) };
    expect(validateSchedule({ ...base, timezoneOffsetMinutes: 900 }).ok).toBe(false);
    expect(validateSchedule({ ...base, timezoneOffsetMinutes: -800 }).ok).toBe(false);
    expect(validateSchedule({ ...base, timezoneOffsetMinutes: 1.5 }).ok).toBe(false);
  });

  it("does not mutate its input", () => {
    const input = { days: [5, 1], startMinutes: MIN(22), endMinutes: MIN(7), timezoneOffsetMinutes: 0 };
    const before = JSON.parse(JSON.stringify(input));
    validateSchedule(input);
    expect(input).toEqual(before);
  });
});
