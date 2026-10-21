import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * B90 — the page route must apply the guest **read** scope to database pages.
 *
 * The linked-database actions (`src/server/actions/linked-database.ts`) already
 * refuse a database outside a guest's scope. The route
 * (`src/app/w/[slug]/[pageId]/page.tsx`) is the second way in: it renders the
 * database page itself (schema + rows) and hands the database list to the
 * sidebar. Both have to follow the same scope, otherwise the guard of the
 * actions is bypassed by simply opening the page.
 *
 * The route is exercised in the idiom of `src/app/invite/invite-pages.render.test.ts`:
 * only the transport edges are mocked (prisma, auth, permissions, queries, the
 * child components) — the real scope computation (`src/lib/guest-access.ts`)
 * and the real route run.
 *
 * Two scopes exist and must not be confused:
 * - the **display** scope (`pageScopeFor`) also contains the *ancestors* of the
 *   shared pages, because the sidebar has to draw the breadcrumb chain down to
 *   a shared child. It stays the scope of every page type but `DATABASE`.
 * - the **read** scope (`guestReadablePageIds`) contains the shared pages and
 *   their whole subtree, never an ancestor — the guest rule of
 *   `src/lib/guest-access.ts` (a grant covers the page's subtree).
 *
 * A database page follows the read scope: a guest who was given a single *row*
 * of a database must not open the database above it, a guest who was given a
 * *parent page* may open the database below it.
 *
 * Deliberately **not** pinned here: the display scope still decides access to
 * the page types other than `DATABASE`, so a guest who was granted a row may
 * still open the *ancestor* page of that row. That asymmetry is pre-existing
 * and outside this change (the route documents it) — this file pins the
 * database rule only, so a later change of the non-database scope cannot break
 * it.
 */

const db = vi.hoisted(() => ({
  pageFindMany: vi.fn(),
  pagePermissionFindMany: vi.fn(),
  teamspaceMemberFindMany: vi.fn(),
  pageFollowFindUnique: vi.fn(),
  pageVersionFindMany: vi.fn(),
}));
const auth = vi.hoisted(() => ({ requireUser: vi.fn() }));
const perm = vi.hoisted(() => ({ getWorkspaceAccess: vi.fn() }));
const queries = vi.hoisted(() => ({
  getPageDetail: vi.fn(),
  getDatabase: vi.fn(),
  getWorkspaceBySlug: vi.fn(),
  getAncestorTrail: vi.fn(),
  getTeamspaces: vi.fn(),
  getUserWorkspaces: vi.fn(),
  getWorkspaceMembers: vi.fn(),
}));
const backlinks = vi.hoisted(() => ({ getPageReferences: vi.fn() }));
const components = vi.hoisted(() => ({
  PageEditor: vi.fn(() => null),
  PageTitle: vi.fn(() => null),
  CommentPanel: vi.fn(() => null),
  Backlinks: vi.fn(() => null),
  VersionHistory: vi.fn(() => null),
  DatabaseView: vi.fn(() => null),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    page: { findMany: db.pageFindMany },
    pagePermission: { findMany: db.pagePermissionFindMany },
    teamspaceMember: { findMany: db.teamspaceMemberFindMany },
    pageFollow: { findUnique: db.pageFollowFindUnique },
    pageVersion: { findMany: db.pageVersionFindMany },
  },
}));
vi.mock("@/lib/auth", () => ({ requireUser: auth.requireUser }));
// The module is mocked partially: the workspace access is the seam of the
// test, everything else stays real — a full mock would answer the role
// questions the route asks with a fixed value.
vi.mock("@/lib/permissions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/permissions")>();
  return { ...actual, getWorkspaceAccess: perm.getWorkspaceAccess };
});
vi.mock("@/server/queries", () => queries);
vi.mock("@/server/backlinks", () => ({ getPageReferences: backlinks.getPageReferences }));
vi.mock("@/server/version-authors", () => ({ loadVersionAuthors: vi.fn(async () => ({})) }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    const error = new Error("NEXT_NOT_FOUND");
    (error as Error & { digest?: string }).digest = "NEXT_NOT_FOUND";
    throw error;
  },
}));
vi.mock("@/components/editor/page-editor", () => ({ PageEditor: components.PageEditor }));
vi.mock("@/components/page-title", () => ({ PageTitle: components.PageTitle }));
vi.mock("@/components/comment-panel", () => ({ CommentPanel: components.CommentPanel }));
vi.mock("@/components/backlinks", () => ({ Backlinks: components.Backlinks }));
vi.mock("@/components/version-history", () => ({ VersionHistory: components.VersionHistory }));
vi.mock("@/components/database/database-view", () => ({ DatabaseView: components.DatabaseView }));

import PageRoute from "./page";

const WORKSPACE_ID = "ws-1";
const GUEST_ID = "guest-1";

type Fixture = {
  id: string;
  parentId: string | null;
  type: "PAGE" | "DATABASE";
  title: string;
};

/**
 * The workspace's tree — the same shape the action test uses
 * (`src/server/actions/linked-database.guest-scope.test.ts`), with one page
 * more: the route reads the whole tree, the action only the database:
 *
 *   parent-1            (an ordinary page)
 *   └── db-3           (a database below it)
 *   db-1                (a database)
 *   ├── row-1           (one of its rows — a page below the database)
 *   └── row-2           (its other row)
 *   db-2                (a database nobody was granted)
 */
const TREE: Fixture[] = [
  { id: "parent-1", parentId: null, type: "PAGE", title: "Parent" },
  { id: "db-3", parentId: "parent-1", type: "DATABASE", title: "Inherited" },
  { id: "db-1", parentId: null, type: "DATABASE", title: "Shared" },
  { id: "row-1", parentId: "db-1", type: "PAGE", title: "Row" },
  { id: "row-2", parentId: "db-1", type: "PAGE", title: "Row 2" },
  { id: "db-2", parentId: null, type: "DATABASE", title: "Private" },
];

/** The guest's page grants: page id → permission levels. */
let grants: Record<string, string[]>;

/** The pages the guest created themselves (empty in these fixtures). */
const ownPages = new Set<string>();

/** The subset of the prisma query arguments these tests rely on. */
type PrismaArgs = {
  where?: {
    type?: string;
    id?: { in?: string[] };
    createdById?: string;
    pageId?: string;
    userId?: string;
  };
  select?: {
    id?: boolean;
    parentId?: boolean;
    teamspaceId?: boolean;
    createdById?: boolean;
    permissions?: { where?: { userId?: string } };
  };
};

/** The calls the route made for the **database list** (`prisma.page.findMany`). */
function databaseListCalls(): PrismaArgs[] {
  return db.pageFindMany.mock.calls
    .map((call) => call[0] as PrismaArgs | undefined)
    .filter((args) => args?.where?.type === "DATABASE") as PrismaArgs[];
}

/** The database list the route received — the rows its sidebar would show. */
async function databaseLists(): Promise<{ id: string; title: string; icon: null }[]> {
  const indexes = db.pageFindMany.mock.calls
    .map((call, index) => ({ args: call[0] as PrismaArgs | undefined, index }))
    .filter(({ args }) => args?.where?.type === "DATABASE")
    .map(({ index }) => index);
  const lists = await Promise.all(
    indexes.map((index) => db.pageFindMany.mock.results[index]?.value),
  );
  return lists.flat() as { id: string; title: string; icon: null }[];
}

/** Every element of `type` inside the tree the route returned. */
function elementsOfType(tree: unknown, type: unknown): { props: Record<string, unknown> }[] {
  const found: { props: Record<string, unknown> }[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (!node || typeof node !== "object") return;
    const element = node as { type?: unknown; props?: Record<string, unknown> };
    if (!element.props) return;
    if (element.type === type) found.push({ props: element.props });
    visit(element.props.children);
  };
  visit(tree);
  return found;
}

/** The page the route loads (`getPageDetail`). */
function pageDetail(id: string, type: "PAGE" | "DATABASE") {
  return {
    id,
    workspaceId: WORKSPACE_ID,
    type,
    title: TREE.find((page) => page.id === id)?.title ?? id,
    icon: null,
    coverUrl: null,
    isFavorite: false,
    fullWidth: false,
    smallText: false,
    font: null,
    lineSpacing: null,
    locked: false,
    schemaLocked: false,
    content: null,
    deletedAt: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    createdBy: { id: "owner-1", name: "Owner", avatarUrl: null },
    versions: [],
    shareLinks: [],
    comments: [],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  grants = {};

  auth.requireUser.mockResolvedValue({ id: GUEST_ID, locale: "en" });
  perm.getWorkspaceAccess.mockResolvedValue({ role: "GUEST" });
  queries.getWorkspaceBySlug.mockResolvedValue({
    id: WORKSPACE_ID,
    name: "Acme",
    slug: "acme",
  });
  queries.getAncestorTrail.mockResolvedValue([]);
  queries.getTeamspaces.mockResolvedValue([]);
  queries.getUserWorkspaces.mockResolvedValue([]);
  queries.getWorkspaceMembers.mockResolvedValue([]);
  queries.getDatabase.mockResolvedValue({
    properties: [],
    views: [],
    rows: [
      {
        id: "row-1",
        title: "Row",
        icon: null,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        updatedAt: new Date("2026-01-01T00:00:00.000Z"),
        createdBy: null,
        propertyValues: [],
      },
    ],
    templates: [],
    relationData: { options: [], valuesByRow: {}, properties: [] },
    lastEditedBy: {},
  });
  backlinks.getPageReferences.mockResolvedValue({ linked: [], unlinked: [] });
  db.teamspaceMemberFindMany.mockResolvedValue([]);
  db.pageFollowFindUnique.mockResolvedValue(null);
  db.pageVersionFindMany.mockResolvedValue([]);

  /**
   * A faithful prisma simulation: every scope query gets the rows it asks for.
   * - the route's database list honours the `id.in` filter,
   * - the display scope (`guestVisiblePageIds`) sees the guest's grants, their
   *   own pages and the whole page tree (it adds the ancestors itself),
   * - the read scope (`guestReadablePageIds`) sees every page with *this*
   *   guest's grants (the relation filter is by `userId`).
   */
  db.pageFindMany.mockImplementation(async (args: PrismaArgs) => {
    const where = args.where ?? {};
    const select = args.select ?? {};

    if (where.type === "DATABASE") {
      const all = TREE.filter((page) => page.type === "DATABASE");
      const ids = where.id?.in;
      const list = ids ? all.filter((page) => ids.includes(page.id)) : all;
      // The route selects `{ id, title, icon }`.
      return list.map((page) => ({ id: page.id, title: page.title, icon: null }));
    }

    if (where.createdById) {
      return TREE.filter((page) => ownPages.has(page.id)).map((page) => ({ id: page.id }));
    }

    const row = (page: Fixture) => ({
      id: page.id,
      parentId: page.parentId,
      teamspaceId: null,
      createdById: ownPages.has(page.id) ? GUEST_ID : "owner-1",
    });

    if (select.permissions) {
      const userId = select.permissions.where?.userId;
      return TREE.map((page) => ({
        ...row(page),
        permissions:
          userId === GUEST_ID ? (grants[page.id] ?? []).map((level) => ({ level })) : [],
      }));
    }

    return TREE.map(row);
  });

  db.pagePermissionFindMany.mockImplementation(async (args: PrismaArgs) => {
    const where = args.where ?? {};
    // The route's own question: "may I edit this page?".
    if (where.pageId) {
      return (grants[where.pageId] ?? []).slice(0, 1).map((level) => ({ level }));
    }
    // The display scope: every page that was shared with this guest.
    return Object.entries(grants)
      .filter(([, levels]) => levels.length > 0)
      .map(([pageId]) => ({ pageId }));
  });
});

const run = (pageId: string) => PageRoute({ params: Promise.resolve({ slug: "acme", pageId }) });

describe("the page route — the guest scope for database pages", () => {
  it("refuses a database whose only shared page is one of its rows", async () => {
    // The core of the finding: the row was shared, the database was not. The
    // database is an *ancestor* of the grant — inheritance runs downwards, so
    // it is not readable.
    grants = { "row-1": ["READ"] };
    queries.getPageDetail.mockResolvedValue(pageDetail("db-1", "DATABASE"));

    // The page is not rendered at all: the route ends in `notFound()`.
    await expect(run("db-1")).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("opens the database that was shared with the guest", async () => {
    grants = { "db-1": ["READ"] };
    queries.getPageDetail.mockResolvedValue(pageDetail("db-1", "DATABASE"));

    const tree = await run("db-1");

    expect(queries.getDatabase).toHaveBeenCalledWith("db-1", expect.any(Set));
    // The database view the route renders carries the database's own rows.
    const [view] = elementsOfType(tree, components.DatabaseView);
    expect(view).toBeDefined();
    expect(view?.props.databasePageId).toBe("db-1");
    expect((view?.props.rows as { id: string }[]).map((row) => row.id)).toEqual(["row-1"]);
  });

  it("opens a database below a shared parent page (inheritance runs downwards)", async () => {
    grants = { "parent-1": ["READ"] };
    queries.getPageDetail.mockResolvedValue(pageDetail("db-3", "DATABASE"));

    await expect(run("db-3")).resolves.toBeDefined();

    expect(queries.getDatabase).toHaveBeenCalledWith("db-3", expect.any(Set));
  });

  it("lists only the databases inside the guest's read scope", async () => {
    grants = { "db-1": ["READ"] };
    queries.getPageDetail.mockResolvedValue(pageDetail("db-1", "DATABASE"));

    await run("db-1");

    const [listCall] = databaseListCalls();
    expect(listCall).toBeDefined();
    const ids = listCall?.where?.id?.in;
    expect(ids).toBeDefined();
    expect(ids).toContain("db-1");
    expect(ids).not.toContain("db-2");
    expect(ids).not.toContain("db-3");
    // The list the route hands to the sidebar carries exactly that database.
    expect(await databaseLists()).toEqual([{ id: "db-1", title: "Shared", icon: null }]);
  });

  it("leaves a member untouched", async () => {
    perm.getWorkspaceAccess.mockResolvedValue({ role: "MEMBER" });
    queries.getPageDetail.mockResolvedValue(pageDetail("db-2", "DATABASE"));

    await expect(run("db-2")).resolves.toBeDefined();

    expect(queries.getDatabase).toHaveBeenCalledWith("db-2", null);
    // A member sees every database of the workspace — no scope filter at all.
    const [listCall] = databaseListCalls();
    expect(listCall?.where?.id).toBeUndefined();
    expect(await databaseLists()).toEqual([
      { id: "db-3", title: "Inherited", icon: null },
      { id: "db-1", title: "Shared", icon: null },
      { id: "db-2", title: "Private", icon: null },
    ]);
  });

  it("reads no row of a database outside the guest's scope", async () => {
    grants = { "row-1": ["READ"] };
    queries.getPageDetail.mockResolvedValue(pageDetail("db-1", "DATABASE"));

    await expect(run("db-1")).rejects.toThrow("NEXT_NOT_FOUND");

    // The page itself is read (its type decides the scope), but neither the
    // rows of the database nor its database list are.
    expect(queries.getPageDetail).toHaveBeenCalled();
    expect(queries.getDatabase).not.toHaveBeenCalled();
    expect(databaseListCalls()).toHaveLength(0);
  });

  it("refuses a database the guest was never granted", async () => {
    grants = {};
    queries.getPageDetail.mockResolvedValue(pageDetail("db-1", "DATABASE"));

    await expect(run("db-1")).rejects.toThrow("NEXT_NOT_FOUND");

    expect(queries.getDatabase).not.toHaveBeenCalled();
  });

  it("still opens the shared row itself", async () => {
    // The grant sits on the row — the row is in the read scope *and* in the
    // display scope, so the route opens it and renders no database view.
    grants = { "row-1": ["READ"] };
    queries.getPageDetail.mockResolvedValue(pageDetail("row-1", "PAGE"));

    const tree = await run("row-1");

    expect(queries.getDatabase).not.toHaveBeenCalled();
    expect(elementsOfType(tree, components.DatabaseView)).toHaveLength(0);
    expect(elementsOfType(tree, components.PageEditor)).toHaveLength(1);
    // The database of that row is above the grant — it is not in the read
    // scope, so the sidebar of this guest carries no database at all.
    expect(await databaseLists()).toEqual([]);
  });
});
