import { describe, expect, it } from "vitest";
import {
  bucketKey,
  bucketLabel,
  bucketRange,
  groupByBucket,
  type Bucket,
  type BucketUnit,
} from "./date-bucket";

/**
 * H1-date-bucket — UTC date bucketing for grouped views.
 *
 * Written RED-first against a stub, then implemented. Coverage pins:
 * - every unit's key shape (`YYYY-MM-DD`, `YYYY-Www`, `YYYY-MM`, `YYYY-Qn`,
 *   `YYYY`) and lexicographic orderability,
 * - ISO-8601 week numbering (Monday start, week-year at the Dec/Jan seam),
 * - offset/naive datetimes resolved to UTC before bucketing,
 * - `bucketRange` inclusive bounds (`…T00:00:00.000Z` .. `…T23:59:59.999Z`),
 * - quarter/month/week spans, incl. a leap February and a week crossing year end,
 * - `groupByBucket` chronological bucket order, stable entries, skipped bad dates,
 * - determinism and UTC independence (no wall clock, no machine timezone).
 */

const UNITS: readonly BucketUnit[] = ["day", "week", "month", "quarter", "year"];

describe("bucketKey — canonical UTC key per unit", () => {
  it("uses the UTC day and ignores the time of day", () => {
    expect(bucketKey("2026-03-03T23:59:59.999Z", "day")).toBe("2026-03-03");
    expect(bucketKey("2026-03-03T00:00:00.000Z", "day")).toBe("2026-03-03");
  });

  it("resolves an offset datetime into UTC before bucketing", () => {
    // 23:30 on Mar 3 in −05:00 is 04:30 on Mar 4 UTC.
    expect(bucketKey("2026-03-03T23:30:00-05:00", "day")).toBe("2026-03-04");
  });

  it("treats a zone-less datetime as UTC (never local)", () => {
    expect(bucketKey("2026-03-03T01:00", "day")).toBe("2026-03-03");
    expect(bucketKey("2026-03-03T23:00:00", "month")).toBe("2026-03");
  });

  it("numbers ISO weeks (Monday start)", () => {
    expect(bucketKey("2026-03-03", "week")).toBe("2026-W10");
    expect(bucketKey("2026-01-05", "week")).toBe("2026-W02");
  });

  it("keeps the ISO week-year at the Dec/Jan seam", () => {
    expect(bucketKey("2025-12-29", "week")).toBe("2026-W01");
    expect(bucketKey("2027-01-01", "week")).toBe("2026-W53");
  });

  it("builds month, quarter and year keys", () => {
    expect(bucketKey("2026-03-15", "month")).toBe("2026-03");
    expect(bucketKey("2026-03-31", "quarter")).toBe("2026-Q1");
    expect(bucketKey("2026-10-01", "quarter")).toBe("2026-Q4");
    expect(bucketKey("2026-12-31", "year")).toBe("2026");
  });

  it("orders keys lexicographically in chronological order", () => {
    const keys = [
      bucketKey("2026-12-31", "month"),
      bucketKey("2026-01-01", "month"),
      bucketKey("2026-03-03", "month"),
    ];
    expect([...keys].sort()).toEqual(["2026-01", "2026-03", "2026-12"]);
  });

  it("returns an empty key for junk input or an unknown unit", () => {
    expect(bucketKey("not a date", "day")).toBe("");
    expect(bucketKey("2026-02-30", "day")).toBe("");
    expect(bucketKey("2026-13-01", "month")).toBe("");
    expect(bucketKey("2026-03-03", "fortnight" as BucketUnit)).toBe("");
  });
});

describe("bucketLabel — human label from a key", () => {
  it("labels a day, month, quarter and year", () => {
    expect(bucketLabel("2026-03-03", "day")).toBe("Mar 3, 2026");
    expect(bucketLabel("2026-03", "month")).toBe("March 2026");
    expect(bucketLabel("2026-Q1", "quarter")).toBe("Q1 2026");
    expect(bucketLabel("2026", "year")).toBe("2026");
  });

  it("labels a week by its Monday", () => {
    expect(bucketLabel("2026-W10", "week")).toBe("Week of Mar 2, 2026");
  });

  it("returns an empty label for a malformed or out-of-range key", () => {
    expect(bucketLabel("2026-02-30", "day")).toBe("");
    expect(bucketLabel("2026-13", "month")).toBe("");
    expect(bucketLabel("2026-Q5", "quarter")).toBe("");
    expect(bucketLabel("2026-W54", "week")).toBe("");
  });
});

describe("bucketRange — inclusive UTC bounds", () => {
  it("spans exactly one UTC day", () => {
    expect(bucketRange("2026-03-03", "day")).toEqual({
      start: "2026-03-03T00:00:00.000Z",
      end: "2026-03-03T23:59:59.999Z",
    });
  });

  it("spans Monday 00:00 through Sunday 23:59:59.999", () => {
    expect(bucketRange("2026-W10", "week")).toEqual({
      start: "2026-03-02T00:00:00.000Z",
      end: "2026-03-08T23:59:59.999Z",
    });
  });

  it("lets a week cross the year boundary", () => {
    expect(bucketRange("2026-W53", "week")).toEqual({
      start: "2026-12-28T00:00:00.000Z",
      end: "2027-01-03T23:59:59.999Z",
    });
  });

  it("handles a leap and a non-leap February", () => {
    expect(bucketRange("2026-02", "month")?.end).toBe("2026-02-28T23:59:59.999Z");
    expect(bucketRange("2024-02", "month")?.end).toBe("2024-02-29T23:59:59.999Z");
  });

  it("spans a quarter and a year", () => {
    expect(bucketRange("2026-Q1", "quarter")).toEqual({
      start: "2026-01-01T00:00:00.000Z",
      end: "2026-03-31T23:59:59.999Z",
    });
    expect(bucketRange("2026", "year")).toEqual({
      start: "2026-01-01T00:00:00.000Z",
      end: "2026-12-31T23:59:59.999Z",
    });
  });

  it("returns null for an invalid key", () => {
    expect(bucketRange("2025-W53", "week")).toBeNull();
    expect(bucketRange("nope", "day")).toBeNull();
  });
});

type Entry = { id: string; at: string | null };

const entry = (id: string, at: string | null): Entry => ({ id, at });

describe("groupByBucket — ordered buckets", () => {
  it("orders buckets chronologically regardless of input order", () => {
    const entries = [
      entry("c", "2026-03-10"),
      entry("a", "2026-03-03"),
      entry("b", "2026-03-05"),
    ];
    const buckets = groupByBucket(entries, { dateOf: (e) => e.at, unit: "month" });
    expect(buckets.map((b) => b.key)).toEqual(["2026-03"]);
    expect(buckets[0].entries.map((e) => e.id)).toEqual(["c", "a", "b"]);

    const byDay: Bucket<Entry>[] = groupByBucket(entries, { dateOf: (e) => e.at, unit: "day" });
    expect(byDay.map((b) => b.key)).toEqual(["2026-03-03", "2026-03-05", "2026-03-10"]);
    expect(byDay.map((b) => b.label)).toEqual(["Mar 3, 2026", "Mar 5, 2026", "Mar 10, 2026"]);
  });

  it("keeps entry order within a bucket (stable)", () => {
    const entries = [
      entry("first", "2026-03-03T09:00:00.000Z"),
      entry("second", "2026-03-03T17:00:00.000Z"),
    ];
    const buckets = groupByBucket(entries, { dateOf: (e) => e.at, unit: "day" });
    expect(buckets).toHaveLength(1);
    expect(buckets[0].entries.map((e) => e.id)).toEqual(["first", "second"]);
  });

  it("groups by ISO week", () => {
    const entries = [
      entry("mon", "2026-03-02"),
      entry("sun", "2026-03-08"),
      entry("next", "2026-03-09"),
    ];
    const buckets = groupByBucket(entries, { dateOf: (e) => e.at, unit: "week" });
    expect(buckets.map((b) => b.key)).toEqual(["2026-W10", "2026-W11"]);
    expect(buckets[0].entries.map((e) => e.id)).toEqual(["mon", "sun"]);
  });

  it("skips entries with a missing or invalid date", () => {
    const entries = [entry("ok", "2026-03-03"), entry("none", null), entry("bad", "nope")];
    const buckets = groupByBucket(entries, { dateOf: (e) => e.at, unit: "day" });
    expect(buckets).toHaveLength(1);
    expect(buckets[0].entries.map((e) => e.id)).toEqual(["ok"]);
  });

  it("returns no buckets for empty input and does not mutate it", () => {
    const entries = [entry("a", "2026-03-05"), entry("b", "2026-03-01")];
    const snapshot = JSON.parse(JSON.stringify(entries));
    const empty: Entry[] = [];
    expect(groupByBucket(empty, { dateOf: (e) => e.at, unit: "day" })).toEqual([]);
    groupByBucket(entries, { dateOf: (e) => e.at, unit: "day" });
    expect(entries).toEqual(snapshot);
  });
});

describe("determinism — UTC independent, no wall clock", () => {
  it("produces identical keys and labels on repeated calls", () => {
    for (const unit of UNITS) {
      const key = bucketKey("2026-07-04T13:37:00.000Z", unit);
      expect(bucketKey("2026-07-04T13:37:00.000Z", unit)).toBe(key);
      expect(bucketLabel(key, unit)).toBe(bucketLabel(key, unit));
    }
  });

  it("keeps a stable day key across the DST seams", () => {
    // US DST 2026: spring-forward Mar 8, fall-back Nov 1.
    expect(bucketKey("2026-03-08T12:00:00.000Z", "day")).toBe("2026-03-08");
    expect(bucketKey("2026-11-01T12:00:00.000Z", "day")).toBe("2026-11-01");
  });
});
