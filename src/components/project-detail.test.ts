import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ProjectDetailData } from "@/components/project-detail";

/**
 * Project detail — the milestone reorder/status/progress mappings plus a static
 * render of the four `Section`s (Overview / Milestones / Tickets / Activity)
 * with a `Checkbox` status, an inline `DatePicker` and ticket `Tag`s. Server
 * actions, the router and links are stubbed (no Next runtime, no DOM).
 */

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

vi.mock("next/link", async () => {
  const { createElement: h } = await import("react");
  return {
    default: ({ href, children, ...rest }: { href: string; children?: unknown }) =>
      h("a", { href, ...rest }, children as never),
  };
});

vi.mock("@/server/actions/projects", () => ({
  addMilestoneAction: vi.fn(async () => ({ ok: true, id: "m3" })),
  deleteMilestoneAction: vi.fn(async () => ({ ok: true })),
  deleteProjectAction: vi.fn(async () => ({ ok: true })),
  updateMilestoneAction: vi.fn(async () => ({ ok: true })),
  updateProjectAction: vi.fn(async () => ({ ok: true })),
}));

vi.mock("@/server/actions/workspaces", () => ({
  listProjectRolesAction: vi.fn(async () => ({
    members: [],
    roles: [],
    canManage: false,
  })),
  removeProjectRoleAction: vi.fn(async () => ({ ok: true })),
  setProjectRoleAction: vi.fn(async () => ({ ok: true })),
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const {
  ProjectDetail,
  milestoneProgress,
  milestoneStatusTone,
  moveMilestone,
} = await import("@/components/project-detail");
const h = createElement;

const project: ProjectDetailData = {
  id: "p1",
  name: "Apollo",
  summary: "Land on the moon",
  description: "A very large project",
  status: "active",
  icon: "🚀",
  startDate: "2026-01-01T00:00:00.000Z",
  dueDate: "2026-06-01T00:00:00.000Z",
  milestones: [
    {
      id: "m1",
      name: "Spec",
      description: null,
      status: "done",
      dueDate: "2026-02-01T00:00:00.000Z",
      completedAt: "2026-02-01T00:00:00.000Z",
    },
    { id: "m2", name: "Build", description: null, status: "planned", dueDate: null, completedAt: null },
  ],
  pages: [{ id: "pg1", title: "Notes", icon: "📄", type: "DOC" }],
  tickets: [
    {
      id: "t1",
      key: "NOE-1",
      title: "First ticket",
      status: "todo",
      priority: "high",
      estimate: 3,
      estimateUnit: "points",
      labels: [{ id: "l1", name: "bug", color: "red" }],
    },
  ],
  activity: [
    { id: "a1", actor: "Ada", action: "created the project", at: "2026-01-01T10:00:00.000Z", depth: 0 },
    { id: "a2", actor: "Bob", action: "completed Spec", at: "2026-02-01T10:00:00.000Z", depth: 1 },
  ],
};

describe("milestone reorder", () => {
  it("moves an item by one place and clamps at the ends", () => {
    expect(moveMilestone(["a", "b", "c"], 0, 1)).toEqual(["b", "a", "c"]);
    expect(moveMilestone(["a", "b", "c"], 2, -1)).toEqual(["a", "c", "b"]);
    expect(moveMilestone(["a", "b", "c"], 0, -1)).toEqual(["a", "b", "c"]);
    expect(moveMilestone(["a", "b", "c"], 2, 1)).toEqual(["a", "b", "c"]);
  });

  it("returns a fresh array without mutating the input", () => {
    const input = ["a", "b", "c"];
    const out = moveMilestone(input, 1, -1);
    expect(out).not.toBe(input);
    expect(input).toEqual(["a", "b", "c"]);
  });
});

describe("milestone status + progress", () => {
  it("maps status onto a badge tone", () => {
    expect(milestoneStatusTone("planned")).toBe("neutral");
    expect(milestoneStatusTone("in_progress")).toBe("accent");
    expect(milestoneStatusTone("done")).toBe("success");
    expect(milestoneStatusTone("??")).toBe("neutral");
  });

  it("computes done / total / percent", () => {
    expect(milestoneProgress(project.milestones)).toEqual({ total: 2, done: 1, percent: 50 });
    expect(milestoneProgress([])).toEqual({ total: 0, done: 0, percent: 0 });
  });
});

describe("renderToStaticMarkup — project detail", () => {
  const html = renderToStaticMarkup(h(ProjectDetail, { project, slug: "ws", locale: "en" }));

  it("renders the four sections", () => {
    expect(html).toContain("Overview");
    expect(html).toContain("Milestones");
    expect(html).toContain("Tickets");
    expect(html).toContain("Activity");
  });

  it("renders milestones as advance-status rows with an inline date picker", () => {
    expect(html.match(/data-testid="milestone-row"/g)).toHaveLength(2);
    // The status control cycles planned → in progress → done.
    expect(html).toContain('aria-label="Advance Spec"');
    expect(html).toContain('aria-label="Advance Build"');
    expect(html).toContain('data-testid="milestone-status"');
    expect(html).toContain('data-testid="date-picker-trigger"');
  });

  it("renders ticket rows with hue tags", () => {
    expect(html).toContain('data-testid="ticket-row"');
    expect(html).toContain("NOE-1");
    expect(html).toContain("tag-red");
    expect(html).toContain("tag-blue");
  });

  it("renders the activity timeline with indent guides", () => {
    expect(html.match(/data-testid="activity-row"/g)).toHaveLength(2);
    expect(html).toContain("border-s");
    expect(html).toContain("Ada");
  });

  it("shows an empty state when there are no milestones", () => {
    const empty = renderToStaticMarkup(
      h(ProjectDetail, { project: { ...project, milestones: [] }, slug: "ws", locale: "en" }),
    );
    expect(empty).toContain('data-testid="milestones-empty"');
  });
});
