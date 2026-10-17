import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";

/**
 * B54 — the page route must not hand a guest the workspace's teamspace names.
 *
 * The layout scopes the shell's teamspaces, but the page route is the surface
 * a guest actually works in: it serialises the teamspace list into the
 * payload of the client `PageTitle`. A guest may see the teamspace their own
 * page hangs under (the sidebar draws the branch under that name) and nothing
 * else — the workspace's other teamspaces must not travel.
 *
 * The test renders the route exactly as the router does and reads the props
 * that reach the client boundary: that object *is* the payload.
 */

const db = vi.hoisted(() => ({
  workspaceFindUnique: vi.fn(),
  workspaceFindMany: vi.fn(),
  workspaceMemberFindUnique: vi.fn(),
  workspaceMemberFindMany: vi.fn(),
  pageFindMany: vi.fn(),
  pageFindUnique: vi.fn(),
  pagePermissionFindMany: vi.fn(),
  pageFollowFindUnique: vi.fn(),
  pageVersionFindMany: vi.fn(),
  teamspaceFindMany: vi.fn(),
  teamspaceMemberFindMany: vi.fn(),
}));

const auth = vi.hoisted(() => ({ requireUser: vi.fn() }));

vi.mock("@/lib/db", () => ({
  prisma: {
    workspace: { findUnique: db.workspaceFindUnique, findMany: db.workspaceFindMany },
    workspaceMember: {
      findUnique: db.workspaceMemberFindUnique,
      findMany: db.workspaceMemberFindMany,
    },
    page: { findMany: db.pageFindMany, findUnique: db.pageFindUnique },
    pagePermission: { findMany: db.pagePermissionFindMany },
    pageFollow: { findUnique: db.pageFollowFindUnique },
    pageVersion: { findMany: db.pageVersionFindMany },
    teamspace: { findMany: db.teamspaceFindMany },
    teamspaceMember: { findMany: db.teamspaceMemberFindMany },
  },
}));

vi.mock("@/lib/auth", () => ({ requireUser: auth.requireUser }));

vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => {
    throw new Error("NOT_FOUND");
  }),
}));

vi.mock("@/server/backlinks", () => ({
  getPageReferences: vi.fn(async () => ({ linked: [], unlinked: [] })),
}));

vi.mock("@/server/version-authors", () => ({
  loadVersionAuthors: vi.fn(async () => []),
}));

// The client components are stubbed: the props they are handed *are* the
// payload, so the stubs keep the test off the whole client tree.
vi.mock("@/components/page-title", () => ({ PageTitle: () => null }));
vi.mock("@/components/editor/page-editor", () => ({ PageEditor: () => null }));
vi.mock("@/components/database/database-view", () => ({ DatabaseView: () => null }));
vi.mock("@/components/comment-panel", () => ({ CommentPanel: () => null }));
vi.mock("@/components/backlinks", () => ({ Backlinks: () => null }));
vi.mock("@/components/version-history", () => ({ VersionHistory: () => null }));

import PageRoute from "./page";
import { PageTitle } from "@/components/page-title";

const GUEST = {
  id: "user-guest",
  email: "guest@example.test",
  name: "Guest",
  avatarUrl: null,
  theme: "light",
  locale: "en",
};

const WORKSPACE = {
  id: "ws1",
  name: "Acme",
  slug: "acme",
  icon: null,
  ownerId: "user-owner",
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
};

/** The page that was shared with the guest. */
const PAGE = {
  id: "shared-page",
  workspaceId: "ws1",
  parentId: "ts-root",
  teamspaceId: "teamspace-1",
  title: "Shared with the guest",
  icon: null,
  coverUrl: null,
  fullWidth: false,
  smallText: false,
  font: "default",
  lineSpacing: "normal",
  locked: false,
  schemaLocked: false,
  content: null,
  position: 0,
  isFavorite: false,
  isArchived: false,
  deletedAt: null,
  createdById: "user-owner",
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-02T00:00:00.000Z"),
  createdBy: { id: "user-owner", name: "Owner", avatarUrl: null },
  versions: [],
  shareLinks: [],
  comments: [],
};

/** The teamspace the shared page hangs under — the guest may see it. */
const TEAMSPACE = { id: "teamspace-1", name: "Marketing", icon: "📣" };

/** Another teamspace of the workspace — the guest has no business seeing it. */
const OTHER_TEAMSPACE = { id: "teamspace-2", name: "SECRET-TEAMSPACE-NAME", icon: null };

/** Find the element of a given type in a rendered tree. */
function findElement(
  node: unknown,
  type: unknown,
): { props: Record<string, unknown> } | null {
  if (!node || typeof node !== "object") return null;
  const element = node as ReactElement<{ children?: unknown }>;
  if ((element.type as unknown) === type) {
    return element as unknown as { props: Record<string, unknown> };
  }
  const children = element.props?.children;
  const list = Array.isArray(children) ? children : [children];
  for (const child of list) {
    const found = findElement(child, type);
    if (found) return found;
  }
  return null;
}

/** Render the page route and read back the props that reach the client. */
async function renderPage(): Promise<{ props: Record<string, unknown> } | null> {
  const element = await PageRoute({
    params: Promise.resolve({ slug: "acme", pageId: "shared-page" }),
  });
  return findElement(element, PageTitle);
}

beforeEach(() => {
  vi.clearAllMocks();
  auth.requireUser.mockResolvedValue(GUEST);
  db.workspaceFindUnique.mockResolvedValue(WORKSPACE);
  db.workspaceFindMany.mockResolvedValue([WORKSPACE]);
  db.workspaceMemberFindUnique.mockResolvedValue({ role: "GUEST" });
  db.workspaceMemberFindMany.mockResolvedValue([]);
  db.pageFindUnique.mockImplementation(
    async (args: { select?: Record<string, boolean> }) => {
      // The ancestor trail reads the parent chain only.
      if (args?.select?.parentId && !args.select.title) return { parentId: null };
      return PAGE;
    },
  );
  db.pageFindMany.mockImplementation(async (args: { select?: Record<string, boolean> }) => {
    const select = args?.select ?? {};
    // The guest scope: every page of the workspace.
    if (select.teamspaceId) {
      return [
        { id: "ts-root", parentId: null, teamspaceId: "teamspace-1" },
        { id: "shared-page", parentId: "ts-root", teamspaceId: "teamspace-1" },
      ];
    }
    return [];
  });
  db.pagePermissionFindMany.mockImplementation(async (args: { select?: Record<string, boolean> }) => {
    // The scope reads the shared pages, the route reads the page's own level.
    if (args?.select?.pageId) return [{ pageId: "shared-page" }];
    return [];
  });
  db.teamspaceMemberFindMany.mockResolvedValue([]);
  db.teamspaceFindMany.mockResolvedValue([TEAMSPACE, OTHER_TEAMSPACE]);
  db.pageFollowFindUnique.mockResolvedValue(null);
  db.pageVersionFindMany.mockResolvedValue([]);
});

describe("the page route — the payload a guest receives", () => {
  it("carries the teamspaces of the guest's own pages — and only those", async () => {
    const title = await renderPage();

    expect(title).not.toBeNull();
    expect(title?.props.teamspaces).toEqual([
      { id: "teamspace-1", name: "Marketing", icon: "📣" },
    ]);
    expect(JSON.stringify(title?.props)).not.toContain("SECRET-TEAMSPACE-NAME");
  });

  it("queries the teamspaces with the guest's scope", async () => {
    await renderPage();

    const [args] = db.teamspaceFindMany.mock.calls[0] as [
      { where: { id?: { in: string[] } } },
    ];
    expect(args.where.id).toEqual({ in: ["teamspace-1"] });
  });
});

describe("the page route — the payload a member receives", () => {
  beforeEach(() => {
    db.workspaceMemberFindUnique.mockResolvedValue({ role: "MEMBER" });
  });

  it("still carries every teamspace of the workspace", async () => {
    const title = await renderPage();

    expect(title?.props.teamspaces).toEqual([
      { id: "teamspace-1", name: "Marketing", icon: "📣" },
      { id: "teamspace-2", name: "SECRET-TEAMSPACE-NAME", icon: null },
    ]);
  });
});
