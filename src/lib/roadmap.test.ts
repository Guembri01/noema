import { describe, expect, it } from "vitest";
import {
  buildRoadmap,
  clampToWindow,
  describeRoadmap,
  milestones,
  projectRollup,
  roadmapAxis,
  type RoadmapItem,
  type RoadmapRow,
} from "@/lib/roadmap";

/* Times are ms epochs interpreted as UTC. Windows are half-open `[from, to)`
   and item spans are half-open `[start, end)`, matching `@/lib/timeline`.
   Every assertion is clock-free and timezone-free so it is byte-identical on
   any machine. */

const DAY = 86_400_000;
const HOUR = 3_600_000;

function item(over: Partial<RoadmapItem> & { id: string; projectId: string }): RoadmapItem {
  return { title: over.id, ...over };
}

/** True when every row in a lane group lies in a non-overlapping lane. */
function lanesAreNonOverlapping(rows: RoadmapRow[]): boolean {
  const byLane = new Map<number, RoadmapRow[]>();
  for (const row of rows) {
    const list = byLane.get(row.laneIndex);
    if (list) list.push(row);
    else byLane.set(row.laneIndex, [row]);
  }
  for (const lane of byLane.values()) {
    const sorted = [...lane].sort((a, b) => a.x - b.x);
    for (let i = 1; i < sorted.length; i++) {
      // Half-open intervals: a row may start exactly where the previous ends.
      if (sorted[i].x < sorted[i - 1].x + sorted[i - 1].width - 1e-9) {
        return false;
      }
    }
  }
  return true;
}

describe("clampToWindow", () => {
  const window = { from: 100, to: 900 };

  it("returns the span untouched when fully inside", () => {
    expect(clampToWindow(item({ id: "a", projectId: "p", start: 200, end: 400 }), window)).toEqual({
      start: 200,
      end: 400,
    });
  });

  it("clips an item hanging off the left edge", () => {
    expect(clampToWindow(item({ id: "a", projectId: "p", start: -500, end: 300 }), window)).toEqual({
      start: 100,
      end: 300,
    });
  });

  it("clips an item hanging off the right edge", () => {
    expect(clampToWindow(item({ id: "a", projectId: "p", start: 700, end: 5000 }), window)).toEqual({
      start: 700,
      end: 900,
    });
  });

  it("spans the whole window when the item covers it", () => {
    expect(clampToWindow(item({ id: "a", projectId: "p", start: -10, end: 2000 }), window)).toEqual({
      start: 100,
      end: 900,
    });
  });

  it("returns null for an item with no start", () => {
    expect(clampToWindow(item({ id: "a", projectId: "p" }), window)).toBeNull();
  });

  it("treats a missing end as an instant at start", () => {
    expect(clampToWindow(item({ id: "a", projectId: "p", start: 300 }), window)).toEqual({
      start: 300,
      end: 300,
    });
  });

  it("collapses an item entirely before the window to its left edge", () => {
    expect(clampToWindow(item({ id: "a", projectId: "p", start: 0, end: 50 }), window)).toEqual({
      start: 100,
      end: 100,
    });
  });

  it("collapses an item entirely after the window to its right edge", () => {
    expect(clampToWindow(item({ id: "a", projectId: "p", start: 1000, end: 1200 }), window)).toEqual({
      start: 900,
      end: 900,
    });
  });
});

describe("milestones", () => {
  it("extracts zero-duration items only", () => {
    const items = [
      item({ id: "m1", projectId: "p", start: 10 }),
      item({ id: "r1", projectId: "p", start: 0, end: 20 }),
      item({ id: "m2", projectId: "p", start: 30, end: 30 }),
    ];
    expect(milestones(items).map((i) => i.id)).toEqual(["m1", "m2"]);
  });

  it("excludes items without a start", () => {
    const items = [item({ id: "x", projectId: "p" }), item({ id: "m", projectId: "p", start: 5 })];
    expect(milestones(items).map((i) => i.id)).toEqual(["m"]);
  });

  it("sorts by start then id, deterministically", () => {
    const items = [
      item({ id: "b", projectId: "p", start: 5 }),
      item({ id: "a", projectId: "p", start: 5 }),
      item({ id: "c", projectId: "p", start: 1 }),
    ];
    expect(milestones(items).map((i) => i.id)).toEqual(["c", "a", "b"]);
  });

  it("treats end <= start as a milestone", () => {
    const items = [item({ id: "m", projectId: "p", start: 5, end: 3 })];
    expect(milestones(items).map((i) => i.id)).toEqual(["m"]);
  });
});

describe("roadmapAxis", () => {
  it("generates Monday-aligned weekly ticks covering the window", () => {
    // Jan 15 2026 is a Thursday; the covering Monday is Jan 12.
    const axis = roadmapAxis(Date.UTC(2026, 0, 15), Date.UTC(2026, 1, 15), "week");
    expect(axis.ticks.map((t) => new Date(t.start).toISOString().slice(0, 10))).toEqual([
      "2026-01-12",
      "2026-01-19",
      "2026-01-26",
      "2026-02-02",
      "2026-02-09",
    ]);
    expect(axis.ticks[0].label).toBe("Jan 12");
  });

  it("generates month-first ticks", () => {
    const axis = roadmapAxis(Date.UTC(2026, 0, 15), Date.UTC(2026, 3, 15), "month");
    expect(axis.ticks.map((t) => t.label)).toEqual([
      "Jan 2026",
      "Feb 2026",
      "Mar 2026",
      "Apr 2026",
    ]);
  });

  it("generates quarter-first ticks", () => {
    const axis = roadmapAxis(Date.UTC(2026, 0, 15), Date.UTC(2026, 10, 15), "quarter");
    expect(axis.ticks.map((t) => t.label)).toEqual(["Q1 2026", "Q2 2026", "Q3 2026", "Q4 2026"]);
    expect(axis.ticks[1].start).toBe(Date.UTC(2026, 3, 1));
  });

  it("makes each tick end where the next begins (contiguous)", () => {
    const axis = roadmapAxis(Date.UTC(2026, 0, 15), Date.UTC(2026, 4, 15), "month");
    for (let i = 1; i < axis.ticks.length; i++) {
      expect(axis.ticks[i].start).toBe(axis.ticks[i - 1].end);
    }
  });

  it("starts at or before `from` and ends before `to`", () => {
    const from = Date.UTC(2026, 5, 10);
    const to = Date.UTC(2026, 8, 2);
    const axis = roadmapAxis(from, to, "month");
    expect(axis.ticks[0].start).toBeLessThanOrEqual(from);
    expect(axis.ticks[axis.ticks.length - 1].start).toBeLessThan(to);
  });

  it("rolls a weekly tick across a month and year boundary", () => {
    const axis = roadmapAxis(Date.UTC(2026, 11, 28), Date.UTC(2027, 0, 15), "week");
    expect(axis.ticks.map((t) => new Date(t.start).toISOString().slice(0, 10))).toEqual([
      "2026-12-28",
      "2027-01-04",
      "2027-01-11",
    ]);
  });

  it("returns no ticks for a degenerate or inverted window", () => {
    expect(roadmapAxis(500, 500, "month").ticks).toEqual([]);
    expect(roadmapAxis(900, 100, "week").ticks).toEqual([]);
  });

  it("throws for a bad zoom or non-finite bounds", () => {
    expect(() => roadmapAxis(0, 1, "day" as unknown as "month")).toThrow(RangeError);
    expect(() => roadmapAxis(Number.NaN, 1, "month")).toThrow(RangeError);
    expect(() => roadmapAxis(0, Number.POSITIVE_INFINITY, "month")).toThrow(RangeError);
  });
});

describe("buildRoadmap lane packing", () => {
  const window = { from: 0, to: 100 };

  it("packs non-overlapping items onto a single lane", () => {
    const items = [
      item({ id: "a", projectId: "p", start: 0, end: 10 }),
      item({ id: "b", projectId: "p", start: 20, end: 30 }),
    ];
    const { lanes } = buildRoadmap(items, { ...window, zoom: "month" });
    expect(lanes).toHaveLength(1);
    expect(lanes[0].rows.map((r) => r.laneIndex)).toEqual([0, 0]);
  });

  it("pushes overlapping items onto separate lanes", () => {
    const items = [
      item({ id: "a", projectId: "p", start: 0, end: 10 }),
      item({ id: "b", projectId: "p", start: 5, end: 15 }),
      item({ id: "c", projectId: "p", start: 10, end: 20 }),
    ];
    const { lanes } = buildRoadmap(items, { ...window, zoom: "month" });
    expect(lanes[0].rows.map((r) => [r.item.id, r.laneIndex])).toEqual([
      ["a", 0],
      ["b", 1],
      ["c", 0],
    ]);
    expect(lanesAreNonOverlapping(lanes[0].rows)).toBe(true);
  });

  it("lets back-to-back items share a lane (half-open spans)", () => {
    const items = [
      item({ id: "a", projectId: "p", start: 0, end: 10 }),
      item({ id: "b", projectId: "p", start: 10, end: 20 }),
    ];
    const { lanes } = buildRoadmap(items, { ...window, zoom: "month" });
    expect(lanes[0].rows.map((r) => r.laneIndex)).toEqual([0, 0]);
  });

  it("is deterministic under input shuffling", () => {
    const items = [
      item({ id: "b", projectId: "p", start: 5, end: 60 }),
      item({ id: "a", projectId: "p", start: 0, end: 10 }),
      item({ id: "d", projectId: "q", start: 30, end: 40 }),
      item({ id: "c", projectId: "p", start: 50, end: 90 }),
    ];
    const shuffled = [items[2], items[0], items[3], items[1]];
    expect(JSON.stringify(buildRoadmap(shuffled, { ...window, zoom: "month" }))).toBe(
      JSON.stringify(buildRoadmap(items, { ...window, zoom: "month" })),
    );
  });

  it("groups lanes by project, ordered by projectId", () => {
    const items = [
      item({ id: "z", projectId: "beta", start: 0, end: 10 }),
      item({ id: "a", projectId: "alpha", start: 0, end: 10 }),
    ];
    const { lanes } = buildRoadmap(items, { ...window, zoom: "month" });
    expect(lanes.map((l) => l.projectId)).toEqual(["alpha", "beta"]);
  });

  it("maps clamped spans to 0..1 x/width fractions", () => {
    const items = [item({ id: "a", projectId: "p", start: -50, end: 50 })];
    const { lanes } = buildRoadmap(items, { ...window, zoom: "month" });
    expect(lanes[0].rows[0]).toMatchObject({ x: 0, width: 0.5 });
  });

  it("gives milestones zero width but keeps them placeable", () => {
    const items = [item({ id: "m", projectId: "p", start: 25 })];
    const { lanes } = buildRoadmap(items, { ...window, zoom: "month" });
    expect(lanes[0].rows[0]).toMatchObject({ x: 0.25, width: 0, laneIndex: 0 });
  });

  it("excludes items entirely outside the window", () => {
    const items = [
      item({ id: "outside", projectId: "p", start: 500, end: 600 }),
      item({ id: "inside", projectId: "p", start: 10, end: 20 }),
    ];
    const { lanes } = buildRoadmap(items, { ...window, zoom: "month" });
    expect(lanes[0].rows.map((r) => r.item.id)).toEqual(["inside"]);
  });

  it("flags overdue rows from `now` without a clock read", () => {
    const items = [
      item({ id: "late", projectId: "p", start: 0, end: 10, progress: 0.5 }),
      item({ id: "done", projectId: "p", start: 0, end: 10, progress: 1 }),
      item({ id: "future", projectId: "p", start: 200, end: 300 }),
    ];
    const { lanes } = buildRoadmap(items, { ...window, zoom: "month", now: 50 });
    const flags = Object.fromEntries(lanes[0].rows.map((r) => [r.item.id, r.overdue]));
    expect(flags).toEqual({ late: true, done: false });
  });

  it("returns an empty lane list for no items", () => {
    const result = buildRoadmap([], { ...window, zoom: "week" });
    expect(result.lanes).toEqual([]);
    expect(result.axis.ticks.length).toBeGreaterThan(0);
  });

  it("returns no lanes for a degenerate window", () => {
    const items = [item({ id: "a", projectId: "p", start: 0, end: 10 })];
    const result = buildRoadmap(items, { from: 100, to: 100, zoom: "month" });
    expect(result.lanes).toEqual([]);
    expect(result.axis.ticks).toEqual([]);
  });

  it("attaches an axis matching the requested zoom", () => {
    const result = buildRoadmap([], {
      from: Date.UTC(2026, 0, 1),
      to: Date.UTC(2026, 6, 1),
      zoom: "quarter",
    });
    expect(result.axis.zoom).toBe("quarter");
    expect(result.axis.ticks.map((t) => t.label)).toEqual(["Q1 2026", "Q2 2026"]);
  });
});

describe("projectRollup", () => {
  it("averages progress per project under the default key", () => {
    const items = [
      item({ id: "a", projectId: "p", progress: 0.5 }),
      item({ id: "b", projectId: "p", progress: 1 }),
      item({ id: "c", projectId: "p" }),
    ];
    expect(projectRollup(items)).toEqual([
      { projectId: "p", itemCount: 3, trackedCount: 2, progress: 0.75 },
    ]);
  });

  it("reads a custom progressKey", () => {
    const custom = {
      id: "a",
      projectId: "p",
      title: "a",
      percent: 0.25,
    };
    expect(projectRollup([custom], { progressKey: "percent" })).toEqual([
      { projectId: "p", itemCount: 1, trackedCount: 1, progress: 0.25 },
    ]);
  });

  it("ignores non-numeric and clamps out-of-range progress", () => {
    const items = [
      { id: "a", projectId: "p", title: "a", progress: "half" },
      { id: "b", projectId: "p", title: "b", progress: 1.5 },
      { id: "c", projectId: "p", title: "c", progress: -1 },
    ] as unknown as RoadmapItem[];
    expect(projectRollup(items)).toEqual([
      { projectId: "p", itemCount: 3, trackedCount: 2, progress: 0.5 },
    ]);
  });

  it("orders projects by projectId", () => {
    const items = [
      item({ id: "a", projectId: "zeta", progress: 1 }),
      item({ id: "b", projectId: "alpha", progress: 0 }),
    ];
    expect(projectRollup(items).map((r) => r.projectId)).toEqual(["alpha", "zeta"]);
  });

  it("returns an empty list for no items", () => {
    expect(projectRollup([])).toEqual([]);
  });
});

describe("describeRoadmap", () => {
  it("counts totals, scheduling and projects", () => {
    const items = [
      item({ id: "a", projectId: "p", start: 0, end: 10 }),
      item({ id: "b", projectId: "p", start: 20 }),
      item({ id: "c", projectId: "q" }),
    ];
    const summary = describeRoadmap(items);
    expect(summary).toMatchObject({ total: 3, projects: 2, scheduled: 2, unscheduled: 1 });
  });

  it("counts milestones and completed items", () => {
    const items = [
      item({ id: "m", projectId: "p", start: 5 }),
      item({ id: "r", projectId: "p", start: 0, end: 10, progress: 1 }),
      item({ id: "h", projectId: "p", start: 0, end: 10, progress: 0.5 }),
    ];
    const summary = describeRoadmap(items);
    expect(summary).toMatchObject({ milestones: 1, completed: 1 });
  });

  it("counts overdue items from `now`", () => {
    const items = [
      item({ id: "late", projectId: "p", start: 0, end: 10, progress: 0.2 }),
      item({ id: "done", projectId: "p", start: 0, end: 10, progress: 1 }),
      item({ id: "future", projectId: "p", start: 100, end: 200 }),
    ];
    expect(describeRoadmap(items, { now: 50 }).overdue).toBe(1);
  });

  it("tallies items by status", () => {
    const items = [
      item({ id: "a", projectId: "p", start: 0, status: "todo" }),
      item({ id: "b", projectId: "p", start: 0, status: "todo" }),
      item({ id: "c", projectId: "p", start: 0, status: "done" }),
    ];
    expect(describeRoadmap(items).byStatus).toEqual({ todo: 2, done: 1 });
  });

  it("returns zeroed counts for no items", () => {
    expect(describeRoadmap([])).toEqual({
      total: 0,
      projects: 0,
      scheduled: 0,
      unscheduled: 0,
      milestones: 0,
      completed: 0,
      overdue: 0,
      byStatus: {},
    });
  });
});

describe("roadmap integration", () => {
  it("lays out a realistic multi-project window deterministically", () => {
    const items = [
      item({ id: "design", projectId: "site", start: Date.UTC(2026, 0, 5), end: Date.UTC(2026, 0, 20) }),
      item({ id: "build", projectId: "site", start: Date.UTC(2026, 0, 20), end: Date.UTC(2026, 1, 10) }),
      item({ id: "kickoff", projectId: "site", start: Date.UTC(2026, 0, 5) }),
      item({ id: "research", projectId: "labs", start: Date.UTC(2026, 0, 1), end: Date.UTC(2026, 0, 31) }),
    ];
    const result = buildRoadmap(items, {
      from: Date.UTC(2026, 0, 1),
      to: Date.UTC(2026, 2, 1),
      zoom: "month",
    });
    expect(result.lanes.map((l) => l.projectId)).toEqual(["labs", "site"]);
    for (const lane of result.lanes) expect(lanesAreNonOverlapping(lane.rows)).toBe(true);
    expect(result.axis.ticks.map((t) => t.label)).toEqual(["Jan 2026", "Feb 2026"]);
    // "kickoff" overlaps "design" in the same project, so it needs its own lane.
    const site = result.lanes.find((l) => l.projectId === "site")!;
    expect(site.rows.find((r) => r.item.id === "kickoff")!.laneIndex).toBe(1);
  });
});
