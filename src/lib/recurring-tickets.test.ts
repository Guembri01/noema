import { describe, expect, it } from "vitest";
import {
  RecurrenceRuleError,
  describeRule,
  materializeTickets,
  nextOccurrence,
  occurrencesBetween,
  parseRule,
  shouldSpawn,
  ticketKey,
  type RecurrenceRule,
} from "./recurring-tickets";

/**
 * §20 Recurring tickets + §13 Automations — the pure scheduling engine the
 * tracker's "New → Recurring ticket" shortcut (spec R27.15) is built on.
 *
 * Written RED-first: none of `parseRule`, `nextOccurrence`,
 * `occurrencesBetween`, `describeRule`, `materializeTickets`, `shouldSpawn`
 * or `ticketKey` existed, so every case below failed at compile time
 * (module not found) and at runtime before the engine landed.
 *
 * The engine is deliberately independent of the host machine's time zone:
 * every evaluation takes an injected `tzOffsetMinutes` (minutes east of UTC,
 * e.g. 120 for UTC+2), and occurrence instants are the local midnight of the
 * scheduled day. So the suite is deterministic on any developer's machine.
 *
 * Two behaviours are intentionally different from the older
 * `src/lib/recurrence.ts` engine (which clamps month-ends: Jan 31 → Feb 28):
 * a ticket schedule **skips** invalid days instead (Jan 31 → Mar 31, February
 * has no 31st) and it understands a `yearly` cadence plus `count`/`until`.
 */

const utc = (y: number, m: number, d: number, h = 0, min = 0) =>
  new Date(Date.UTC(y, m - 1, d, h, min, 0, 0));

describe("parseRule — strict but friendly", () => {
  it("parses a minimal daily rule and defaults interval to 1", () => {
    expect(parseRule({ freq: "daily" })).toEqual({ freq: "daily", interval: 1 });
  });

  it("normalizes byWeekday: lowercased, deduped, sorted Sunday-first", () => {
    expect(parseRule({ freq: "weekly", byWeekday: ["TUE", "thu", "TUE"] })).toEqual({
      freq: "weekly",
      interval: 1,
      byWeekday: ["tue", "thu"],
    });
    // A bare string is accepted for friendliness.
    expect(parseRule({ freq: "weekly", byWeekday: "mon" }).byWeekday).toEqual(["mon"]);
  });

  it("accepts interval 1..365 and rejects 0, -1, 366, 2.5 and NaN", () => {
    expect(parseRule({ freq: "daily", interval: 365 }).interval).toBe(365);
    for (const interval of [0, -1, 366, 2.5, Number.NaN]) {
      expect(() => parseRule({ freq: "daily", interval })).toThrow(/interval/i);
    }
  });

  it("rejects an unknown frequency and names the allowed ones", () => {
    expect(() => parseRule({ freq: "fortnightly" })).toThrow(/freq/i);
    expect(() => parseRule({ freq: "fortnightly" })).toThrow(/daily/);
  });

  it("rejects unknown keys rather than silently ignoring them", () => {
    expect(() => parseRule({ freq: "daily", everyN: 2 })).toThrow(/everyN/);
  });

  it("rejects a missing frequency", () => {
    expect(() => parseRule({})).toThrow(/freq/i);
  });

  it("scopes byWeekday to weekly rules", () => {
    expect(() => parseRule({ freq: "daily", byWeekday: ["mon"] })).toThrow(/byWeekday/);
    expect(() => parseRule({ freq: "monthly", byWeekday: ["mon"] })).toThrow(/byWeekday/);
  });

  it("rejects an unknown weekday", () => {
    expect(() => parseRule({ freq: "weekly", byWeekday: ["funday"] })).toThrow(/weekday/i);
  });

  it("scopes byMonthDay to monthly/yearly and rejects out-of-range days", () => {
    expect(() => parseRule({ freq: "weekly", byMonthDay: 15 })).toThrow(/byMonthDay/);
    for (const day of [0, 32, 2.5, Number.NaN]) {
      expect(() => parseRule({ freq: "monthly", byMonthDay: day })).toThrow(/byMonthDay/);
    }
  });

  it("normalizes a single byMonthDay to a sorted, deduped array", () => {
    expect(parseRule({ freq: "monthly", byMonthDay: 15 }).byMonthDay).toEqual([15]);
    expect(parseRule({ freq: "monthly", byMonthDay: [15, 1, 15] }).byMonthDay).toEqual([1, 15]);
  });

  it("count must be a positive integer", () => {
    expect(parseRule({ freq: "daily", count: 3 }).count).toBe(3);
    for (const count of [0, -1, 2.5]) {
      expect(() => parseRule({ freq: "daily", count })).toThrow(/count/i);
    }
  });

  it("parses until from an ISO string and rejects an unparseable value", () => {
    expect(parseRule({ freq: "daily", until: "2026-12-31" }).until).toEqual(
      new Date("2026-12-31"),
    );
    expect(() => parseRule({ freq: "daily", until: "whenever" })).toThrow(/until/i);
  });

  it("parses start from a Date or ISO string and rejects an unparseable value", () => {
    const start = utc(2026, 1, 1);
    expect(parseRule({ freq: "daily", start }).start).toEqual(start);
    expect(parseRule({ freq: "daily", start: "2026-01-01" }).start).toEqual(start);
    expect(() => parseRule({ freq: "daily", start: "someday" })).toThrow(/start/i);
  });

  it("accepts a JSON string payload", () => {
    expect(parseRule('{"freq":"daily","interval":2}')).toEqual({ freq: "daily", interval: 2 });
  });

  it("rejects malformed JSON and non-object input with a friendly error", () => {
    expect(() => parseRule("{nope")).toThrow(/JSON/i);
    expect(() => parseRule(42)).toThrow(/object/i);
    expect(() => parseRule([])).toThrow(/object/i);
    expect(() => parseRule(null)).toThrow(RecurrenceRuleError);
    expect(() => parseRule(null)).toThrow(/object/i);
  });

  it("raises RecurrenceRuleError (not a bare Error) so callers can catch it", () => {
    try {
      parseRule({ freq: "nope" });
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(RecurrenceRuleError);
      expect((error as RecurrenceRuleError).name).toBe("RecurrenceRuleError");
    }
  });
});

describe("nextOccurrence — the next single fire time", () => {
  it("daily: the following day, strictly after from", () => {
    const rule = parseRule({ freq: "daily", start: "2026-01-01" });
    expect(nextOccurrence(rule, utc(2026, 1, 1))).toEqual(utc(2026, 1, 2));
  });

  it("skips an occurrence landing exactly on from", () => {
    const rule = parseRule({ freq: "daily", start: "2026-01-01" });
    expect(nextOccurrence(rule, utc(2026, 1, 2))).toEqual(utc(2026, 1, 3));
  });

  it("honours the interval", () => {
    const rule = parseRule({ freq: "daily", interval: 2, start: "2026-01-01" });
    expect(nextOccurrence(rule, utc(2026, 1, 1))).toEqual(utc(2026, 1, 3));
  });

  it("weekly ByDay: from a Thursday, the next Tuesday", () => {
    const rule = parseRule({ freq: "weekly", byWeekday: ["tue", "thu"], start: "2026-01-01" });
    expect(nextOccurrence(rule, utc(2026, 1, 1))).toEqual(utc(2026, 1, 6));
  });

  it("weekly interval 2 skips the off-week", () => {
    const rule = parseRule({ freq: "weekly", interval: 2, byWeekday: ["mon"], start: "2026-01-05" });
    expect(nextOccurrence(rule, utc(2026, 1, 5))).toEqual(utc(2026, 1, 19));
  });

  it("monthly on the 31st fires in January and skips February", () => {
    const rule = parseRule({ freq: "monthly", byMonthDay: 31, start: "2026-01-01" });
    expect(nextOccurrence(rule, utc(2026, 1, 1))).toEqual(utc(2026, 1, 31));
    expect(nextOccurrence(rule, utc(2026, 1, 31))).toEqual(utc(2026, 3, 31));
  });

  it("monthly: a day that never exists in February is skipped, not clamped", () => {
    const rule = parseRule({ freq: "monthly", byMonthDay: 30, start: "2026-01-01" });
    expect(nextOccurrence(rule, utc(2026, 1, 1))).toEqual(utc(2026, 1, 30));
    // February has no 30th; the engine jumps straight to March.
    expect(nextOccurrence(rule, utc(2026, 1, 30))).toEqual(utc(2026, 3, 30));
  });

  it("monthly byMonthDay decouples from the start day", () => {
    const rule = parseRule({ freq: "monthly", byMonthDay: 15, start: "2026-01-01" });
    expect(nextOccurrence(rule, utc(2026, 1, 1))).toEqual(utc(2026, 1, 15));
  });

  it("yearly Feb 29 only fires in leap years", () => {
    const rule = parseRule({ freq: "yearly", byMonthDay: 29, start: "2026-02-01" });
    expect(nextOccurrence(rule, utc(2026, 2, 1))).toEqual(utc(2028, 2, 29));
  });

  it("respects count: the series is exhausted", () => {
    const rule = parseRule({ freq: "daily", start: "2026-01-01", count: 3 });
    expect(nextOccurrence(rule, utc(2026, 1, 1))).toEqual(utc(2026, 1, 2));
    expect(nextOccurrence(rule, utc(2026, 1, 2))).toEqual(utc(2026, 1, 3));
    expect(nextOccurrence(rule, utc(2026, 1, 3))).toBeNull();
  });

  it("respects until inclusively and then stops", () => {
    const rule = parseRule({ freq: "daily", start: "2026-01-01", until: "2026-01-05" });
    expect(nextOccurrence(rule, utc(2026, 1, 4))).toEqual(utc(2026, 1, 5));
    expect(nextOccurrence(rule, utc(2026, 1, 5))).toBeNull();
  });

  it("returns null for an invalid from", () => {
    const rule = parseRule({ freq: "daily" });
    expect(nextOccurrence(rule, new Date(Number.NaN))).toBeNull();
  });

  it("with an injected UTC+2 offset, occurrences are local midnight instants", () => {
    const rule = parseRule({ freq: "daily", start: "2026-01-01" });
    // Local Jan 2, 00:00 at UTC+2 is Jan 1, 22:00 UTC.
    expect(nextOccurrence(rule, utc(2026, 1, 1), { tzOffsetMinutes: 120 })).toEqual(
      new Date(Date.UTC(2026, 0, 1, 22)),
    );
  });
});

describe("occurrencesBetween — a bounded window", () => {
  it("daily: strictly after from, inclusive of to", () => {
    const rule = parseRule({ freq: "daily", start: "2026-01-01" });
    expect(occurrencesBetween(rule, utc(2026, 1, 1), utc(2026, 1, 4))).toEqual([
      utc(2026, 1, 2),
      utc(2026, 1, 3),
      utc(2026, 1, 4),
    ]);
  });

  it("limit caps the result", () => {
    const rule = parseRule({ freq: "daily", start: "2026-01-01" });
    expect(occurrencesBetween(rule, utc(2026, 1, 1), utc(2026, 1, 31), { limit: 2 })).toEqual([
      utc(2026, 1, 2),
      utc(2026, 1, 3),
    ]);
  });

  it("count caps the series even when the window is wider", () => {
    const rule = parseRule({ freq: "daily", start: "2026-01-01", count: 3 });
    expect(occurrencesBetween(rule, utc(2026, 1, 1), utc(2026, 1, 31))).toEqual([
      utc(2026, 1, 2),
      utc(2026, 1, 3),
    ]);
  });

  it("until caps the series", () => {
    const rule = parseRule({ freq: "daily", start: "2026-01-01", until: "2026-01-03" });
    expect(occurrencesBetween(rule, utc(2026, 1, 1), utc(2026, 1, 31))).toEqual([
      utc(2026, 1, 2),
      utc(2026, 1, 3),
    ]);
  });

  it("returns [] for an empty or invalid window", () => {
    const rule = parseRule({ freq: "daily", start: "2026-01-01" });
    expect(occurrencesBetween(rule, utc(2026, 1, 5), utc(2026, 1, 1))).toEqual([]);
    expect(occurrencesBetween(rule, new Date(Number.NaN), utc(2026, 1, 1))).toEqual([]);
    expect(occurrencesBetween(rule, utc(2026, 1, 1), new Date(Number.NaN))).toEqual([]);
  });

  it("monthly skips the months without the requested day", () => {
    const rule = parseRule({ freq: "monthly", byMonthDay: 31, start: "2026-01-01" });
    expect(occurrencesBetween(rule, utc(2026, 1, 1), utc(2026, 7, 31))).toEqual([
      utc(2026, 1, 31),
      utc(2026, 3, 31),
      utc(2026, 5, 31),
      utc(2026, 7, 31),
    ]);
  });

  it("yearly lists only the leap years in the window", () => {
    const rule = parseRule({ freq: "yearly", byMonthDay: 29, start: "2026-02-01" });
    expect(occurrencesBetween(rule, utc(2026, 1, 1), utc(2033, 1, 1))).toEqual([
      utc(2028, 2, 29),
      utc(2032, 2, 29),
    ]);
  });

  it("applies the injected offset to both window boundaries", () => {
    const rule = parseRule({ freq: "daily", start: "2026-01-01" });
    expect(
      occurrencesBetween(rule, utc(2026, 1, 1), utc(2026, 1, 5), { tzOffsetMinutes: 120 }),
    ).toEqual([
      new Date(Date.UTC(2026, 0, 1, 22)),
      new Date(Date.UTC(2026, 0, 2, 22)),
      new Date(Date.UTC(2026, 0, 3, 22)),
      new Date(Date.UTC(2026, 0, 4, 22)),
    ]);
  });
});

describe("describeRule — human summary", () => {
  it("daily: interval phrasing", () => {
    expect(describeRule(parseRule({ freq: "daily" }))).toBe("Every day");
    expect(describeRule(parseRule({ freq: "daily", interval: 2 }))).toBe("Every 2 days");
  });

  it("weekly: names the weekdays in order", () => {
    expect(describeRule(parseRule({ freq: "weekly" }))).toBe("Every week");
    expect(describeRule(parseRule({ freq: "weekly", byWeekday: ["fri", "mon"] }))).toBe(
      "Every week on Mon, Fri",
    );
  });

  it("weekly: interval 2 with two days (the spec example)", () => {
    const rule = parseRule({ freq: "weekly", interval: 2, byWeekday: ["tue", "thu"] });
    expect(describeRule(rule)).toBe("Every 2 weeks on Tue, Thu");
  });

  it("monthly: ordinals, including a joined list", () => {
    expect(describeRule(parseRule({ freq: "monthly", byMonthDay: 31 }))).toBe(
      "Every month on the 31st",
    );
    expect(describeRule(parseRule({ freq: "monthly", byMonthDay: [15, 1] }))).toBe(
      "Every month on the 1st and 15th",
    );
  });

  it("yearly: ordinal day", () => {
    expect(describeRule(parseRule({ freq: "yearly", byMonthDay: 29 }))).toBe(
      "Every year on the 29th",
    );
  });

  it("appends count and until bounds", () => {
    expect(describeRule(parseRule({ freq: "daily", count: 3 }))).toBe("Every day, 3 times");
    expect(
      describeRule(parseRule({ freq: "weekly", byWeekday: ["tue"], until: "2026-12-31" })),
    ).toBe("Every week on Tue, until 2026-12-31");
  });
});

describe("materializeTickets — deterministic drafts, no I/O", () => {
  const template = {
    id: "tpl-1",
    title: "Weekly triage",
    projectId: "proj-1",
    priority: "high",
    labels: ["ops"],
  };
  const rule = parseRule({ freq: "weekly", byWeekday: ["mon"], start: "2026-01-05" });

  it("produces one draft per occurrence, ascending, stamped with the template", () => {
    const drafts = materializeTickets(rule, template, {
      from: utc(2026, 1, 5),
      to: utc(2026, 1, 26),
      actorId: "u1",
    });
    expect(drafts.map((draft) => draft.occurrence)).toEqual([
      utc(2026, 1, 12),
      utc(2026, 1, 19),
      utc(2026, 1, 26),
    ]);
    expect(drafts[0]).toMatchObject({
      templateId: "tpl-1",
      title: "Weekly triage",
      projectId: "proj-1",
      priority: "high",
      actorId: "u1",
    });
    expect(drafts[0].labels).toEqual(["ops"]);
  });

  it("derives a stable dedupe key from (templateId, occurrence)", () => {
    const drafts = materializeTickets(rule, template, {
      from: utc(2026, 1, 5),
      to: utc(2026, 1, 19),
      actorId: "u1",
    });
    expect(ticketKey("tpl-1", utc(2026, 1, 12))).toBe("tpl-1:2026-01-12T00:00:00.000Z");
    expect(drafts.map((draft) => draft.key)).toEqual([
      ticketKey("tpl-1", utc(2026, 1, 12)),
      ticketKey("tpl-1", utc(2026, 1, 19)),
    ]);
  });

  it("dedupes against already-materialized occurrences (by templateId+occurrence)", () => {
    const drafts = materializeTickets(rule, template, {
      from: utc(2026, 1, 5),
      to: utc(2026, 1, 26),
      actorId: "u1",
      existing: [ticketKey("tpl-1", utc(2026, 1, 12)), ticketKey("tpl-1", utc(2026, 1, 12))],
    });
    expect(drafts.map((draft) => draft.occurrence)).toEqual([utc(2026, 1, 19), utc(2026, 1, 26)]);
  });

  it("does not treat a different template's matching date as a duplicate", () => {
    const drafts = materializeTickets(rule, template, {
      from: utc(2026, 1, 5),
      to: utc(2026, 1, 12),
      actorId: "u1",
      existing: [ticketKey("tpl-2", utc(2026, 1, 12))],
    });
    expect(drafts).toHaveLength(1);
    expect(drafts[0].occurrence).toEqual(utc(2026, 1, 12));
  });

  it("copies labels (does not alias the template) and is pure", () => {
    const before = JSON.stringify(template);
    const first = materializeTickets(rule, template, {
      from: utc(2026, 1, 5),
      to: utc(2026, 1, 12),
      actorId: "u1",
    });
    const second = materializeTickets(rule, template, {
      from: utc(2026, 1, 5),
      to: utc(2026, 1, 12),
      actorId: "u1",
    });
    expect(first).toEqual(second);
    expect(first[0].labels).not.toBe(template.labels);
    expect(JSON.stringify(template)).toBe(before);
  });

  it("returns [] for an empty window", () => {
    expect(
      materializeTickets(rule, template, {
        from: utc(2026, 1, 5),
        to: utc(2026, 1, 1),
        actorId: "u1",
      }),
    ).toEqual([]);
  });
});

describe("shouldSpawn — cron gate", () => {
  const rule = parseRule({ freq: "daily", start: "2026-01-01" });

  it("is due once the next occurrence has arrived", () => {
    expect(shouldSpawn(rule, utc(2026, 1, 1), utc(2026, 1, 2))).toBe(true);
    expect(shouldSpawn(rule, utc(2026, 1, 1), utc(2026, 1, 1, 12))).toBe(false);
  });

  it("does not spawn twice for the same occurrence", () => {
    expect(shouldSpawn(rule, utc(2026, 1, 2), utc(2026, 1, 2, 9))).toBe(false);
    expect(shouldSpawn(rule, utc(2026, 1, 2), utc(2026, 1, 3))).toBe(true);
  });

  it("returns false without a prior spawn or with an invalid one", () => {
    expect(shouldSpawn(rule, null, utc(2026, 6, 1))).toBe(false);
    expect(shouldSpawn(rule, new Date(Number.NaN), utc(2026, 6, 1))).toBe(false);
  });

  it("returns false once the series is exhausted", () => {
    const counted = parseRule({ freq: "daily", start: "2026-01-01", count: 1 });
    expect(shouldSpawn(counted, utc(2026, 1, 1), utc(2026, 6, 1))).toBe(false);
    const bounded = parseRule({ freq: "daily", start: "2026-01-01", until: "2026-01-02" });
    expect(shouldSpawn(bounded, utc(2026, 1, 2), utc(2026, 6, 1))).toBe(false);
  });

  it("returns false for an invalid now", () => {
    expect(shouldSpawn(rule, utc(2026, 1, 1), new Date(Number.NaN))).toBe(false);
  });
});

describe("RecurrenceRule type surface", () => {
  it("accepts a directly constructed rule without parseRule", () => {
    const rule: RecurrenceRule = { freq: "daily", interval: 1 };
    expect(nextOccurrence(rule, utc(2026, 1, 1))).toEqual(utc(2026, 1, 2));
  });
});
