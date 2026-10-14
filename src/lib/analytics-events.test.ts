import { describe, expect, it } from "vitest";
import {
  ANALYTICS_EVENT_KINDS,
  aggregateByPage,
  dailySeries,
  recentActors,
  topPages,
  type AnalyticsEvent,
  type AnalyticsEventKind,
} from "@/lib/analytics-events";

/**
 * B-analytics-events — Page analytics events (view/edit/create/comment).
 *
 * Written RED-first against a missing module. Coverage pins:
 * - `aggregateByPage`: per-kind counts, unique actors, last activity,
 *   deterministic page-id order, out-of-order input,
 * - `dailySeries`: dense UTC day buckets, per-kind counts, inclusive bounds,
 *   excluded out-of-range/invalid events,
 * - `topPages`: count ranking, deterministic tie-break, kind filter, limits,
 * - `recentActors`: recency order, ties, actors without a valid timestamp,
 * - purity: inputs are never mutated, results are fresh objects.
 */

const ev = (
  id: string,
  pageId: string,
  actorId: string,
  kind: AnalyticsEventKind,
  at: string,
): AnalyticsEvent => ({ id, pageId, actorId, kind, at });

const sample: AnalyticsEvent[] = [
  ev("e1", "p2", "u1", "view", "2026-03-01T10:00:00.000Z"),
  ev("e2", "p1", "u1", "view", "2026-03-01T09:00:00.000Z"),
  ev("e3", "p1", "u2", "edit", "2026-03-02T09:00:00.000Z"),
  ev("e4", "p1", "u1", "comment", "2026-03-01T12:00:00.000Z"),
  ev("e5", "p2", "u2", "view", "2026-03-03T09:00:00.000Z"),
];

describe("ANALYTICS_EVENT_KINDS", () => {
  it("lists the four tracked kinds in a stable order", () => {
    expect(ANALYTICS_EVENT_KINDS).toEqual(["view", "edit", "create", "comment"]);
  });
});

describe("aggregateByPage", () => {
  it("counts each kind, unique actors and last activity per page", () => {
    const result = aggregateByPage(sample);
    expect(result.map((entry) => entry.pageId)).toEqual(["p1", "p2"]);

    const p1 = result[0];
    expect(p1.counts).toEqual({ view: 1, edit: 1, create: 0, comment: 1 });
    expect(p1.total).toBe(3);
    expect(p1.uniqueActors).toBe(2);
    expect(p1.lastActivity).toBe("2026-03-02T09:00:00.000Z");

    const p2 = result[1];
    expect(p2.counts).toEqual({ view: 2, edit: 0, create: 0, comment: 0 });
    expect(p2.total).toBe(2);
    expect(p2.uniqueActors).toBe(2);
    expect(p2.lastActivity).toBe("2026-03-03T09:00:00.000Z");
  });

  it("returns an empty list for no events", () => {
    expect(aggregateByPage([])).toEqual([]);
  });

  it("dedupes actors and normalizes the winning timestamp to UTC", () => {
    const result = aggregateByPage([
      ev("a", "p", "u1", "view", "2026-03-01T10:00:00.000Z"),
      ev("b", "p", "u1", "view", "2026-03-01T12:00:00+02:00"),
      ev("c", "p", "u2", "edit", "2026-03-01T08:00:00.000Z"),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].uniqueActors).toBe(2);
    // 12:00+02:00 == 10:00Z, so both share the same instant; still one actor.
    expect(result[0].lastActivity).toBe("2026-03-01T10:00:00.000Z");
    expect(result[0].counts.view).toBe(2);
  });

  it("still counts an event with an unparseable timestamp, with null last activity", () => {
    const result = aggregateByPage([
      ev("a", "p", "u1", "create", "not-a-date"),
      ev("b", "p", "u2", "view", ""),
    ]);
    expect(result[0].counts).toEqual({ view: 1, edit: 0, create: 1, comment: 0 });
    expect(result[0].lastActivity).toBeNull();
  });

  it("does not mutate its input", () => {
    const snapshot = JSON.parse(JSON.stringify(sample));
    aggregateByPage(sample);
    expect(sample).toEqual(snapshot);
  });
});

describe("dailySeries", () => {
  it("fills dense UTC day buckets with per-kind counts", () => {
    const events = [
      ev("a", "p", "u1", "view", "2026-03-01T00:00:00.000Z"),
      ev("b", "p", "u2", "view", "2026-03-01T23:59:59.999Z"),
      ev("c", "p", "u1", "edit", "2026-03-02T05:00:00.000Z"),
    ];
    const series = dailySeries(events, { from: "2026-03-01", to: "2026-03-03" });
    expect(series.map((bucket) => bucket.date)).toEqual([
      "2026-03-01",
      "2026-03-02",
      "2026-03-03",
    ]);
    expect(series[0].counts).toEqual({ view: 2, edit: 0, create: 0, comment: 0 });
    expect(series[0].total).toBe(2);
    expect(series[1].counts).toEqual({ view: 0, edit: 1, create: 0, comment: 0 });
    expect(series[1].total).toBe(1);
    expect(series[2].counts).toEqual({ view: 0, edit: 0, create: 0, comment: 0 });
    expect(series[2].total).toBe(0);
  });

  it("excludes events outside the inclusive range", () => {
    const events = [
      ev("before", "p", "u1", "view", "2026-02-28T23:59:59.999Z"),
      ev("first", "p", "u1", "view", "2026-03-01T00:00:00.000Z"),
      ev("last", "p", "u1", "view", "2026-03-03T23:59:59.999Z"),
      ev("after", "p", "u1", "view", "2026-03-04T00:00:00.000Z"),
    ];
    const series = dailySeries(events, { from: "2026-03-01", to: "2026-03-03" });
    expect(series).toHaveLength(3);
    expect(series.reduce((total, bucket) => total + bucket.total, 0)).toBe(2);
    expect(series[0].total).toBe(1);
    expect(series[2].total).toBe(1);
  });

  it("treats a datetime bound as its whole UTC day", () => {
    const series = dailySeries(
      [ev("a", "p", "u1", "view", "2026-03-01T23:00:00.000Z")],
      { from: "2026-03-01T23:00:00.000Z", to: "2026-03-01T23:30:00.000Z" },
    );
    expect(series).toHaveLength(1);
    expect(series[0].date).toBe("2026-03-01");
    expect(series[0].total).toBe(1);
  });

  it("ignores events with an invalid timestamp", () => {
    const series = dailySeries(
      [ev("bad", "p", "u1", "view", "garbage"), ev("ok", "p", "u1", "edit", "2026-03-01T09:00:00.000Z")],
      { from: "2026-03-01", to: "2026-03-01" },
    );
    expect(series).toHaveLength(1);
    expect(series[0].counts).toEqual({ view: 0, edit: 1, create: 0, comment: 0 });
  });

  it("returns an empty series for a reversed or invalid range", () => {
    expect(dailySeries([], { from: "2026-03-03", to: "2026-03-01" })).toEqual([]);
    expect(dailySeries([], { from: "nope", to: "2026-03-01" })).toEqual([]);
    expect(dailySeries([], { from: "2026-03-01", to: "nope" })).toEqual([]);
  });

  it("does not mutate its input", () => {
    const events = [ev("a", "p", "u1", "view", "2026-03-01T09:00:00.000Z")];
    const snapshot = JSON.parse(JSON.stringify(events));
    dailySeries(events, { from: "2026-03-01", to: "2026-03-01" });
    expect(events).toEqual(snapshot);
  });
});

describe("topPages", () => {
  const ranked: AnalyticsEvent[] = [
    ev("a", "p2", "u1", "view", "2026-03-01T01:00:00.000Z"),
    ev("b", "p3", "u1", "edit", "2026-03-01T02:00:00.000Z"),
    ev("c", "p1", "u1", "view", "2026-03-01T03:00:00.000Z"),
    ev("d", "p2", "u2", "view", "2026-03-01T04:00:00.000Z"),
    ev("e", "p1", "u2", "edit", "2026-03-01T05:00:00.000Z"),
    ev("f", "p1", "u3", "comment", "2026-03-01T06:00:00.000Z"),
    ev("g", "p2", "u3", "create", "2026-03-01T07:00:00.000Z"),
    ev("h", "p3", "u3", "view", "2026-03-01T08:00:00.000Z"),
  ];

  it("ranks pages by count with a deterministic page-id tie-break", () => {
    expect(topPages(ranked, { limit: 10 })).toEqual([
      { pageId: "p1", count: 3 },
      { pageId: "p2", count: 3 },
      { pageId: "p3", count: 2 },
    ]);
  });

  it("counts only the requested kind", () => {
    expect(topPages(ranked, { limit: 10, kind: "view" })).toEqual([
      { pageId: "p2", count: 2 },
      { pageId: "p1", count: 1 },
      { pageId: "p3", count: 1 },
    ]);
  });

  it("honours the limit and rejects non-positive limits", () => {
    expect(topPages(ranked, { limit: 2 })).toEqual([
      { pageId: "p1", count: 3 },
      { pageId: "p2", count: 3 },
    ]);
    expect(topPages(ranked, { limit: 0 })).toEqual([]);
    expect(topPages(ranked, { limit: -5 })).toEqual([]);
  });

  it("is stable regardless of input order", () => {
    const shuffled = [...ranked].reverse();
    expect(topPages(shuffled, { limit: 10 })).toEqual(topPages(ranked, { limit: 10 }));
  });

  it("returns an empty list for no events", () => {
    expect(topPages([], { limit: 5 })).toEqual([]);
  });
});

describe("recentActors", () => {
  const actors: AnalyticsEvent[] = [
    ev("a", "p", "u1", "view", "2026-03-04T09:00:00.000Z"),
    ev("b", "p", "u1", "edit", "2026-03-05T09:00:00.000Z"),
    ev("c", "p", "u2", "view", "2026-03-06T09:00:00.000Z"),
    ev("d", "p", "u3", "view", "2026-03-03T09:00:00.000Z"),
    ev("e", "p", "u3", "edit", "2026-03-04T09:00:00.000Z"),
    ev("f", "p", "u3", "comment", "2026-03-02T09:00:00.000Z"),
    ev("g", "p", "u4", "view", "not-a-date"),
  ];

  it("orders actors by most recent activity, tie-broken by actor id", () => {
    expect(recentActors(actors, { limit: 10 })).toEqual([
      { actorId: "u2", count: 1, lastActivity: "2026-03-06T09:00:00.000Z" },
      { actorId: "u1", count: 2, lastActivity: "2026-03-05T09:00:00.000Z" },
      { actorId: "u3", count: 3, lastActivity: "2026-03-04T09:00:00.000Z" },
      { actorId: "u4", count: 1, lastActivity: null },
    ]);
  });

  it("honours the limit", () => {
    expect(recentActors(actors, { limit: 2 })).toEqual([
      { actorId: "u2", count: 1, lastActivity: "2026-03-06T09:00:00.000Z" },
      { actorId: "u1", count: 2, lastActivity: "2026-03-05T09:00:00.000Z" },
    ]);
    expect(recentActors(actors, { limit: 0 })).toEqual([]);
  });

  it("breaks ties on the same instant by actor id", () => {
    const tied: AnalyticsEvent[] = [
      ev("a", "p", "uB", "view", "2026-03-01T09:00:00.000Z"),
      ev("b", "p", "uA", "view", "2026-03-01T09:00:00.000Z"),
    ];
    expect(recentActors(tied, { limit: 10 }).map((entry) => entry.actorId)).toEqual(["uA", "uB"]);
  });

  it("returns an empty list for no events", () => {
    expect(recentActors([], { limit: 5 })).toEqual([]);
  });

  it("does not mutate its input", () => {
    const snapshot = JSON.parse(JSON.stringify(actors));
    recentActors(actors, { limit: 10 });
    expect(actors).toEqual(snapshot);
  });
});
