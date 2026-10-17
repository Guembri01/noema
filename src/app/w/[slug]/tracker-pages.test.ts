import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * B02 — the tracker pages refuse a guest.
 *
 * The tracker is not page-scoped: `GET /api/tickets` answers 403 for a
 * `GUEST` and every ticket/cycle/project action refuses one too (they ask
 * `canEditContent`). The pages were the bypass — they asked only "is a
 * workspace member", which is also true for a guest — so the workspace's
 * tickets, cycles, milestones and roadmap were readable at `/w/<slug>/tickets`
 * and its siblings.
 *
 * Each page now answers 404 for a guest, exactly like the routes answer 403,
 * and the query behind it is never reached.
 *
 * The real role predicate (`canEditContent`) runs; only the transport edges
 * (auth, the workspace access, the queries) are mocked.
 */

const h = vi.hoisted(() => ({
  requireUser: vi.fn(),
  getWorkspaceAccess: vi.fn(),
  getWorkspaceBySlug: vi.fn(),
  getTicketsPage: vi.fn(),
  getLabels: vi.fn(),
  getWorkspaceMembers: vi.fn(),
  getProjects: vi.fn(),
  getTicketViews: vi.fn(),
  getCycles: vi.fn(),
  getTickets: vi.fn(),
  getArchivedTickets: vi.fn(),
  getProjectDetail: vi.fn(),
  getProjectTickets: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ requireUser: h.requireUser }));
vi.mock("@/lib/permissions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/permissions")>();
  return { ...actual, getWorkspaceAccess: h.getWorkspaceAccess };
});
vi.mock("@/server/queries", () => ({
  getWorkspaceBySlug: h.getWorkspaceBySlug,
  getTicketsPage: h.getTicketsPage,
  getLabels: h.getLabels,
  getWorkspaceMembers: h.getWorkspaceMembers,
  getProjects: h.getProjects,
  getTicketViews: h.getTicketViews,
  getCycles: h.getCycles,
  getTickets: h.getTickets,
  getProjectDetail: h.getProjectDetail,
  getProjectTickets: h.getProjectTickets,
}));
vi.mock("@/server/ticket-archive", () => ({ getArchivedTickets: h.getArchivedTickets }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));

import TicketsPage from "./tickets/page";
import TicketArchivePage from "./tickets/archive/page";
import CyclesPage from "./cycles/page";
import RoadmapPage from "./roadmap/page";
import ProjectsPage from "./projects/page";
import ProjectPage from "./projects/[projectId]/page";

/** The 404 the page answers for a guest. */
async function expectNotFound(run: () => Promise<unknown>): Promise<void> {
  await expect(run()).rejects.toThrow("NOT_FOUND");
}

beforeEach(() => {
  vi.clearAllMocks();
  h.requireUser.mockResolvedValue({ id: "u1", locale: "en" });
  h.getWorkspaceAccess.mockResolvedValue({ role: "GUEST" });
  h.getWorkspaceBySlug.mockResolvedValue({ id: "ws1", name: "Acme", slug: "acme" });
  h.getTicketsPage.mockResolvedValue({
    tickets: [
      {
        id: "t1",
        key: "ACME-1",
        title: "Offsite budget",
        description: null,
        type: "TASK",
        status: "todo",
        priority: "medium",
        estimate: null,
        estimateUnit: "POINTS",
        startDate: null,
        dueDate: null,
        parentId: null,
        cycleId: null,
        project: null,
        milestone: null,
        assignee: null,
        labels: [],
        _count: { children: 0, comments: 0 },
      },
    ],
    nextCursor: null,
  });
  h.getLabels.mockResolvedValue([]);
  h.getWorkspaceMembers.mockResolvedValue([{ id: "m1", name: "Ada", email: "ada@example.com" }]);
  h.getProjects.mockResolvedValue([]);
  h.getTicketViews.mockResolvedValue([]);
  h.getCycles.mockResolvedValue([]);
  h.getTickets.mockResolvedValue([]);
  h.getArchivedTickets.mockResolvedValue([]);
  h.getProjectDetail.mockResolvedValue({ id: "p1", name: "Roadmap", milestones: [], members: [] });
  h.getProjectTickets.mockResolvedValue([]);
});

describe("the tracker pages refuse a guest", () => {
  it("refuses the tickets page and never reads the tracker or the roster", async () => {
    await expectNotFound(() =>
      TicketsPage({
        params: Promise.resolve({ slug: "acme" }),
        searchParams: Promise.resolve({}),
      }),
    );

    expect(h.getTicketsPage).not.toHaveBeenCalled();
    expect(h.getWorkspaceMembers).not.toHaveBeenCalled();
  });

  it("refuses the archived-tickets page and never reads the archive", async () => {
    await expectNotFound(() =>
      TicketArchivePage({ params: Promise.resolve({ slug: "acme" }) }),
    );

    expect(h.getArchivedTickets).not.toHaveBeenCalled();
  });

  it("refuses the cycles page and never reads the cycles", async () => {
    await expectNotFound(() => CyclesPage({ params: Promise.resolve({ slug: "acme" }) }));

    expect(h.getCycles).not.toHaveBeenCalled();
  });

  it("refuses the roadmap page and never reads the tickets", async () => {
    await expectNotFound(() =>
      RoadmapPage({
        params: Promise.resolve({ slug: "acme" }),
        searchParams: Promise.resolve({}),
      }),
    );

    expect(h.getTickets).not.toHaveBeenCalled();
    expect(h.getProjects).not.toHaveBeenCalled();
  });

  it("refuses the projects page and never reads the projects", async () => {
    await expectNotFound(() => ProjectsPage({ params: Promise.resolve({ slug: "acme" }) }));

    expect(h.getProjects).not.toHaveBeenCalled();
  });

  it("refuses the project detail page and never reads the project", async () => {
    await expectNotFound(() =>
      ProjectPage({ params: Promise.resolve({ slug: "acme", projectId: "p1" }) }),
    );

    expect(h.getProjectDetail).not.toHaveBeenCalled();
    expect(h.getProjectTickets).not.toHaveBeenCalled();
  });
});

describe("a full member still sees the tracker", () => {
  it("serves the tickets page and its roster", async () => {
    h.getWorkspaceAccess.mockResolvedValue({ role: "MEMBER" });

    await TicketsPage({
      params: Promise.resolve({ slug: "acme" }),
      searchParams: Promise.resolve({}),
    });

    expect(h.getTicketsPage).toHaveBeenCalledTimes(1);
    expect(h.getWorkspaceMembers).toHaveBeenCalledTimes(1);
  });

  it("serves the cycles page", async () => {
    h.getWorkspaceAccess.mockResolvedValue({ role: "MEMBER" });

    await CyclesPage({ params: Promise.resolve({ slug: "acme" }) });

    expect(h.getCycles).toHaveBeenCalledTimes(1);
  });
});
