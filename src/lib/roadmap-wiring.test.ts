import { describe, expect, it } from "vitest";
import {
  buildRoadmap,
  describeRoadmap,
  milestones,
  projectRollup,
  roadmapAxis,
  type RoadmapItem,
  type RoadmapZoom,
} from "@/lib/roadmap";

/**
 * The roadmap page folds project milestones (zero-duration) and dated tickets
 * into one `RoadmapItem[]` and lays it out with `@/lib/roadmap`. This test
 * mirrors that mapping and pins the resulting cross-project layout, rollup,
 * milestone extraction and axis alignment.
 */

const utc = (value: string) => Date.parse(value);
const DAY = 86_400_000;

function pageItems(): RoadmapItem[] {
  const projects = [
    {
      id: "p1",
      milestones: [
        { id: "m1", name: "Kickoff", dueDate: "2026-02-02T00:00:00.000Z" },
        { id: "m2", name: "No date", dueDate: null },
      ],
    },
    { id: "p2", milestones: [] },
  ];
  const tickets = [
    {
      id: "t1",
      key: "NOE-1",
      title: "Design",
      startDate: "2026-02-01T00:00:00.000Z",
      dueDate: "2026-02-10T00:00:00.000Z",
      completedAt: null,
      status: "in_progress",
      project: { id: "p1" },
    },
    {
      id: "t2",
      key: "NOE-2",
      title: "Build",
      startDate: null,
      dueDate: "2026-02-20T00:00:00.000Z",
      completedAt: "2026-02-21T00:00:00.000Z",
      status: "done",
      project: { id: "p2" },
    },
    {
      id: "t3",
      key: "NOE-3",
      title: "Loose",
      startDate: null,
      dueDate: null,
      completedAt: null,
      status: "todo",
      project: null,
    },
  ];

  const items: RoadmapItem[] = [];
  for (const project of projects) {
    for (const milestone of project.milestones) {
      items.push({
        id: `milestone:${milestone.id}`,
        projectId: project.id,
        title: milestone.name,
        start: milestone.dueDate ? utc(milestone.dueDate) : undefined,
        status: "planned",
        progress: 0,
      });
    }
  }
  for (const ticket of tickets) {
    items.push({
      id: `ticket:${ticket.id}`,
      projectId: ticket.project?.id ?? "unassigned",
      title: `${ticket.key} ${ticket.title}`,
      start: ticket.startDate ? utc(ticket.startDate) : ticket.dueDate ? utc(ticket.dueDate) : undefined,
      end: ticket.dueDate ? utc(ticket.dueDate) : undefined,
      status: ticket.status,
      progress: ticket.completedAt ? 1 : undefined,
    });
  }
  return items;
}

const FROM = utc("2026-01-26T00:00:00.000Z");
const TO = utc("2026-03-01T00:00:00.000Z");
const zoom: RoadmapZoom = "month";

describe("roadmap page layout", () => {
  const items = pageItems();

  it("groups items into per-project lanes and packs overlaps onto separate rows", () => {
    const roadmap = buildRoadmap(items, { from: FROM, to: TO, zoom, now: utc("2026-02-15T00:00:00.000Z") });
    const byProject = new Map(roadmap.lanes.map((lane) => [lane.projectId, lane]));

    expect([...byProject.keys()].sort()).toEqual(["p1", "p2"]);
    // p1: the ticket (Feb 1–10) and the milestone (Feb 2) overlap → two rows.
    expect(byProject.get("p1")?.rows.length).toBe(2);
    // p2: only the dated Build ticket; the undated milestone and ticket are not placed.
    expect(byProject.get("p2")?.rows.length).toBe(1);
  });

  it("renders milestones as zero-width markers and positions bars as fractions", () => {
    const roadmap = buildRoadmap(items, { from: FROM, to: TO, zoom });
    const milestone = roadmap.lanes
      .flatMap((lane) => lane.rows)
      .find((row) => row.item.id === "milestone:m1");
    expect(milestone?.width).toBe(0);
    expect(milestone?.x).toBeGreaterThan(0);
    expect(milestone?.x).toBeLessThan(1);
  });

  it("aggregates progress per project and counts unscheduled work", () => {
    const rollups = projectRollup(items);
    const byProject = new Map(rollups.map((entry) => [entry.projectId, entry]));
    // p1: two milestones (progress 0) tracked, the ticket untracked → 0.
    expect(byProject.get("p1")).toMatchObject({ itemCount: 3, trackedCount: 2, progress: 0 });
    // p2: the completed ticket contributes 1.
    expect(byProject.get("p2")).toMatchObject({ itemCount: 1, trackedCount: 1, progress: 1 });

    const summary = describeRoadmap(items, { now: utc("2026-03-15T00:00:00.000Z") });
    expect(summary.total).toBe(5);
    expect(summary.unscheduled).toBe(2); // m2 + t3
    expect(summary.completed).toBe(1);
    expect(summary.overdue).toBe(2); // m1 (past) + t1 (in progress, ended Feb 10)
  });

  it("extracts zero-duration markers (undated milestones and due-only tickets) in order", () => {
    expect(milestones(items).map((item) => item.id)).toEqual(["milestone:m1", "ticket:t2"]);
  });

  it("aligns the axis to UTC calendar boundaries", () => {
    const axis = roadmapAxis(FROM, TO, "week");
    expect(axis.ticks.length).toBeGreaterThan(0);
    // The first tick is the Monday on or before the window start.
    expect(new Date(axis.ticks[0].start).getUTCDay()).toBe(1);
    expect(axis.ticks[0].start).toBeLessThanOrEqual(FROM);
    for (let i = 1; i < axis.ticks.length; i += 1) {
      expect(axis.ticks[i].start).toBe(axis.ticks[i - 1].end);
    }
    expect(TO - FROM).toBeGreaterThan(0);
    expect(DAY).toBe(86_400_000);
  });
});
