import { describe, expect, it } from "vitest";
import {
  computeReminderTimes,
  describeOffset,
  nextReminder,
  parseReminderOffset,
  type ReminderOffset,
} from "./date-reminder";

/**
 * B-f8-date-reminder — Date reminders
 * (docs/FEATURE_MATRIX.md "Date reminders": notify at a chosen time).
 *
 * Red-first unit pin. Pure + UTC-safe + deterministic (injected `now`), so no
 * `new Date()` without an argument ever runs here. Coverage pins:
 * - strict ISO parsing: date-only and naive datetimes read as UTC, explicit
 *   `Z`/offsets honoured, calendar overflow (Feb 30) rejected;
 * - offsets combine as signed minute/hour/day deltas around the due instant;
 * - `computeReminderTimes` sorts ascending, de-duplicates equal instants and
 *   skips malformed entries without throwing;
 * - `nextReminder` is strictly future and null once every offset is past;
 * - `parseReminderOffset` normalises and rejects malformed raw input;
 * - `describeOffset` singular/plural labels and the zero offset.
 */

const offset = (
  amount: number,
  unit: ReminderOffset["unit"],
  direction: ReminderOffset["direction"],
): ReminderOffset => ({ amount, unit, direction });

describe("parseReminderOffset — validate + normalise raw input", () => {
  it("accepts a minutes-before offset", () => {
    expect(parseReminderOffset({ amount: 30, unit: "minutes", direction: "before" })).toEqual({
      amount: 30,
      unit: "minutes",
      direction: "before",
    });
  });

  it("accepts an hours-after offset", () => {
    expect(parseReminderOffset({ amount: 2, unit: "hours", direction: "after" })).toEqual({
      amount: 2,
      unit: "hours",
      direction: "after",
    });
  });

  it("accepts a days-before offset", () => {
    expect(parseReminderOffset({ amount: 1, unit: "days", direction: "before" })).toEqual({
      amount: 1,
      unit: "days",
      direction: "before",
    });
  });

  it("accepts a zero amount (the due time itself)", () => {
    expect(parseReminderOffset({ amount: 0, unit: "minutes", direction: "before" })).toEqual({
      amount: 0,
      unit: "minutes",
      direction: "before",
    });
  });

  it("drops unknown extra fields when normalising", () => {
    expect(
      parseReminderOffset({
        amount: 5,
        unit: "minutes",
        direction: "before",
        label: "noise",
      }),
    ).toEqual({ amount: 5, unit: "minutes", direction: "before" });
  });

  it("rejects a non-object", () => {
    expect(parseReminderOffset(null)).toBeNull();
    expect(parseReminderOffset("30 minutes before")).toBeNull();
  });

  it("rejects an unknown unit", () => {
    expect(parseReminderOffset({ amount: 3, unit: "weeks", direction: "before" })).toBeNull();
  });

  it("rejects an unknown direction", () => {
    expect(parseReminderOffset({ amount: 3, unit: "days", direction: "around" })).toBeNull();
  });

  it("rejects a negative or non-integer amount", () => {
    expect(parseReminderOffset({ amount: -5, unit: "minutes", direction: "before" })).toBeNull();
    expect(parseReminderOffset({ amount: 1.5, unit: "hours", direction: "after" })).toBeNull();
  });

  it("rejects a missing or non-numeric amount", () => {
    expect(parseReminderOffset({ unit: "days", direction: "before" })).toBeNull();
    expect(parseReminderOffset({ amount: "3", unit: "days", direction: "before" })).toBeNull();
  });
});

describe("computeReminderTimes — signed deltas around a due instant", () => {
  const due = "2026-03-03T09:00:00.000Z";

  it("returns an empty list for no offsets", () => {
    expect(computeReminderTimes(due, [])).toEqual([]);
  });

  it("computes a single minutes-before reminder", () => {
    expect(computeReminderTimes(due, [offset(30, "minutes", "before")])).toEqual([
      "2026-03-03T08:30:00.000Z",
    ]);
  });

  it("computes an after reminder ahead of the due instant", () => {
    expect(computeReminderTimes(due, [offset(2, "hours", "after")])).toEqual([
      "2026-03-03T11:00:00.000Z",
    ]);
  });

  it("sorts mixed before/after reminders ascending regardless of input order", () => {
    const times = computeReminderTimes(due, [
      offset(2, "hours", "after"),
      offset(1, "days", "before"),
      offset(30, "minutes", "before"),
    ]);
    expect(times).toEqual([
      "2026-03-02T09:00:00.000Z",
      "2026-03-03T08:30:00.000Z",
      "2026-03-03T11:00:00.000Z",
    ]);
  });

  it("de-duplicates offsets that resolve to the same instant", () => {
    expect(
      computeReminderTimes(due, [
        offset(60, "minutes", "before"),
        offset(1, "hours", "before"),
      ]),
    ).toEqual(["2026-03-03T08:00:00.000Z"]);
  });

  it("crosses a month boundary for a days-before reminder", () => {
    expect(computeReminderTimes("2026-03-01T00:00:00.000Z", [offset(1, "days", "before")])).toEqual(
      ["2026-02-28T00:00:00.000Z"],
    );
  });

  it("reads a naive (zone-less) datetime as UTC", () => {
    expect(computeReminderTimes("2026-03-03T09:00:00", [offset(30, "minutes", "before")])).toEqual(
      ["2026-03-03T08:30:00.000Z"],
    );
  });

  it("honours an explicit numeric zone offset", () => {
    expect(
      computeReminderTimes("2026-03-03T09:00:00+02:00", [offset(30, "minutes", "before")]),
    ).toEqual(["2026-03-03T06:30:00.000Z"]);
  });

  it("emits ISO strings ending in Z", () => {
    const [iso] = computeReminderTimes(due, [offset(1, "days", "before")]);
    expect(iso).toMatch(/Z$/);
  });

  it("skips malformed offsets and invalid due dates without throwing", () => {
    expect(
      computeReminderTimes(due, [
        offset(15, "minutes", "before"),
        { amount: -1, unit: "days", direction: "before" } as ReminderOffset,
      ]),
    ).toEqual(["2026-03-03T08:45:00.000Z"]);
    expect(computeReminderTimes("not-a-date", [offset(1, "hours", "before")])).toEqual([]);
    expect(computeReminderTimes("2026-02-30T00:00:00.000Z", [offset(1, "hours", "before")])).toEqual(
      [],
    );
  });

  it("does not mutate the offsets array", () => {
    const offsets = [offset(2, "days", "after"), offset(1, "hours", "before")];
    const copy = offsets.map((entry) => ({ ...entry }));
    computeReminderTimes(due, offsets);
    expect(offsets).toEqual(copy);
  });
});

describe("nextReminder — strictly-future selection against an injected now", () => {
  const due = "2026-03-03T09:00:00.000Z";
  const offsets = [
    offset(1, "days", "before"),
    offset(30, "minutes", "before"),
    offset(2, "hours", "after"),
  ];

  it("returns the earliest reminder after now", () => {
    expect(nextReminder(due, offsets, "2026-03-03T08:00:00.000Z")).toBe(
      "2026-03-03T08:30:00.000Z",
    );
  });

  it("excludes a reminder exactly at now (strictly future)", () => {
    expect(nextReminder(due, offsets, "2026-03-03T08:30:00.000Z")).toBe(
      "2026-03-03T11:00:00.000Z",
    );
  });

  it("returns the first reminder when now precedes every one", () => {
    expect(nextReminder(due, offsets, "2026-02-01T00:00:00.000Z")).toBe(
      "2026-03-02T09:00:00.000Z",
    );
  });

  it("returns null once every reminder is in the past", () => {
    expect(nextReminder(due, offsets, "2026-03-04T00:00:00.000Z")).toBeNull();
  });

  it("accepts a Date for now and returns null with no offsets", () => {
    expect(nextReminder(due, offsets, new Date("2026-03-03T08:00:00.000Z"))).toBe(
      "2026-03-03T08:30:00.000Z",
    );
    expect(nextReminder(due, [], "2026-01-01T00:00:00.000Z")).toBeNull();
  });

  it("returns null for an invalid due date", () => {
    expect(nextReminder("nope", offsets, "2026-01-01T00:00:00.000Z")).toBeNull();
  });
});

describe("describeOffset — human labels", () => {
  it("pluralises minutes", () => {
    expect(describeOffset(offset(30, "minutes", "before"))).toBe("30 minutes before");
  });

  it("uses the singular for one hour", () => {
    expect(describeOffset(offset(1, "hours", "after"))).toBe("1 hour after");
  });

  it("pluralises days", () => {
    expect(describeOffset(offset(2, "days", "before"))).toBe("2 days before");
  });

  it("keeps the singular for one day", () => {
    expect(describeOffset(offset(1, "days", "after"))).toBe("1 day after");
  });

  it("labels a zero offset as the due time", () => {
    expect(describeOffset(offset(0, "minutes", "before"))).toBe("at the due time");
  });
});
