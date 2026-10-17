import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ProjectCard } from "@/components/projects-board";

/**
 * Projects board — the pure mappings (status → badge tone, milestone progress,
 * due-chip tone) and a static render of one project card plus the board's
 * loading/empty states. Next router/link and the server action are stubbed so
 * the client component renders through `react-dom/server` without a runtime.
 */

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
}));

vi.mock("next/link", async () => {
  const { createElement: h } = await import("react");
  return {
    default: ({ href, children, ...rest }: { href: string; children?: unknown }) =>
      h("a", { href, ...rest }, children as never),
  };
});

vi.mock("@/server/actions/projects", () => ({
  createProjectAction: vi.fn(async () => ({ ok: true, id: "p2", slug: "ws" })),
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const {
  DUE_SOON_DAYS,
  ProjectCardTile,
  ProjectsBoard,
  dueTone,
  healthTone,
  isOverdue,
  milestoneProgress,
  progressTone,
  projectStatusTone,
} = await import("@/components/projects-board");

const h = createElement;

const project: ProjectCard = {
  id: "p1",
  name: "Apollo",
  summary: "Land on the moon",
  description: "A very large project",
  status: "active",
  color: "blue",
  icon: "🚀",
  dueDate: "2020-01-01T00:00:00.000Z",
  pageCount: 3,
  milestones: [
    { id: "m1", name: "Spec", status: "done", dueDate: "2020-01-01T00:00:00.000Z" },
    { id: "m2", name: "Build", status: "planned", dueDate: "2020-02-01T00:00:00.000Z" },
  ],
  members: [
    { id: "u1", name: "Ada Lovelace" },
    { id: "u2", name: "Bob" },
  ],
};

const NOW = new Date("2026-01-01T00:00:00.000Z");

describe("status → badge tone", () => {
  it("maps every known status and falls back to neutral", () => {
    expect(projectStatusTone("active")).toBe("success");
    expect(projectStatusTone("paused")).toBe("warning");
    expect(projectStatusTone("done")).toBe("accent");
    expect(projectStatusTone("archived")).toBe("neutral");
    expect(projectStatusTone("mystery")).toBe("neutral");
  });

  it("maps ticket health grades onto tones", () => {
    expect(healthTone("done")).toBe("success");
    expect(healthTone("on-track")).toBe("accent");
    expect(healthTone("at-risk")).toBe("warning");
    expect(healthTone("off-track")).toBe("danger");
  });
});

describe("milestone progress maths", () => {
  it("counts done milestones out of the total", () => {
    expect(milestoneProgress(project.milestones)).toEqual({ total: 2, done: 1, percent: 50 });
  });

  it("never divides by zero and rounds to a whole percent", () => {
    expect(milestoneProgress([])).toEqual({ total: 0, done: 0, percent: 0 });
    expect(milestoneProgress([{ status: "done" }, { status: "planned" }, { status: "done" }]))
      .toEqual({ total: 3, done: 2, percent: 67 });
  });

  it("switches to the success tone only when fully done", () => {
    expect(progressTone(99)).toBe("accent");
    expect(progressTone(100)).toBe("success");
  });
});

describe("due chip tone", () => {
  it("is danger once overdue, warning when due soon, neutral otherwise", () => {
    expect(isOverdue("2020-01-01", NOW)).toBe(true);
    expect(dueTone("2020-01-01", NOW)).toBe("danger");
    expect(dueTone("2026-01-02", NOW)).toBe("warning");
    expect(dueTone("2026-06-01", NOW)).toBe("neutral");
    expect(dueTone(null, NOW)).toBe("neutral");
    expect(dueTone("not-a-date", NOW)).toBe("neutral");
    expect(DUE_SOON_DAYS).toBeGreaterThan(0);
  });
});

describe("renderToStaticMarkup — project card", () => {
  it("renders a Badge, a Progress bar, a danger due chip, avatars and hover lift", () => {
    const html = renderToStaticMarkup(h(ProjectCardTile, { project, slug: "ws", locale: "en", now: NOW }));
    expect(html).toContain('data-testid="project-card"');
    expect(html).toContain('data-status="active"');
    // Status badge carries the success tone.
    expect(html).toContain('data-testid="project-status-badge"');
    expect(html).toContain('data-tone="success"');
    // Milestone progress is 50% and rendered as a progressbar.
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-valuenow="50"');
    // Due date is in the past → danger chip.
    expect(html).toContain('data-testid="project-due-chip"');
    expect(html).toContain('data-overdue="true"');
    expect(html).toContain('data-tone="danger"');
    // Member avatar stack.
    expect(html).toContain('data-testid="project-avatar-stack"');
    expect(html).toContain("Ada Lovelace");
    // Hover lift comes from the interactive Card variant.
    expect(html).toContain("u-interactive");
    expect(html).toContain("shadow-1");
  });

  it("hides the due chip when there is no due date", () => {
    const html = renderToStaticMarkup(
      h(ProjectCardTile, { project: { ...project, dueDate: null }, slug: "ws", locale: "en", now: NOW }),
    );
    expect(html).not.toContain('data-testid="project-due-chip"');
  });
});

describe("renderToStaticMarkup — board states", () => {
  const base = { workspaceId: "w1", slug: "ws", locale: "en" };

  it("renders a skeleton grid while loading", () => {
    const html = renderToStaticMarkup(h(ProjectsBoard, { ...base, projects: [], loading: true }));
    expect(html).toContain('data-testid="projects-skeleton"');
    expect(html).toContain('data-skeleton="card"');
  });

  it("renders an actionable empty state", () => {
    const html = renderToStaticMarkup(h(ProjectsBoard, { ...base, projects: [] }));
    expect(html).toContain('data-testid="projects-empty"');
    expect(html).toContain("No projects yet");
    expect(html).toContain("New project");
  });

  it("renders an error state with a retry action", () => {
    const html = renderToStaticMarkup(
      h(ProjectsBoard, { ...base, projects: [], error: "Boom", onRetry: () => {} }),
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain("Boom");
    expect(html).toContain("Retry");
  });

  it("renders one card per project", () => {
    const html = renderToStaticMarkup(h(ProjectsBoard, { ...base, projects: [project] }));
    expect(html.match(/data-testid="project-card"/g)).toHaveLength(1);
  });
});
