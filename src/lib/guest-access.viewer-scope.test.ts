import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * B54 — the scope of a guest: the pages they may see and the teamspaces whose
 * names they may see.
 *
 * The two halves come from the same rule. A guest's page scope is built from
 * the explicit `PagePermission` rows, the pages they created and the pages of
 * the teamspaces they belong to — plus the ancestors of all of those. The
 * teamspace scope follows from it: the teamspaces the guest is a member of and
 * the teamspaces their *visible* pages live in. A page that was shared with
 * them contributes its own teamspace and the teamspace of the root it hangs
 * under (that root is an ancestor of the shared page, so it is part of the page
 * scope as well) — without those names the sidebar would drop the branch the
 * guest is allowed to see. The workspace's other teamspaces are in neither set.
 */

const db = vi.hoisted(() => ({
  pagePermissionFindMany: vi.fn(),
  teamspaceMemberFindMany: vi.fn(),
  pageFindMany: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    pagePermission: { findMany: db.pagePermissionFindMany },
    teamspaceMember: { findMany: db.teamspaceMemberFindMany },
    page: { findMany: db.pageFindMany },
  },
}));

import { guestScope, viewerScopeFor } from "./guest-access";

/** The pages of the workspace. */
const PAGES = [
  { id: "ts-root", parentId: null, teamspaceId: "teamspace-1" },
  { id: "shared-page", parentId: "ts-root", teamspaceId: "teamspace-1" },
  { id: "ops-page", parentId: null, teamspaceId: "teamspace-3" },
  { id: "other-page", parentId: null, teamspaceId: "teamspace-2" },
  { id: "private-page", parentId: null, teamspaceId: null },
];

beforeEach(() => {
  vi.clearAllMocks();
  // The page that was shared with the guest.
  db.pagePermissionFindMany.mockResolvedValue([{ pageId: "shared-page" }]);
  // The guest is a member of "Operations" (teamspace-3) and of nothing else.
  db.teamspaceMemberFindMany.mockResolvedValue([{ teamspaceId: "teamspace-3" }]);
  db.pageFindMany.mockImplementation(async (args: { select?: Record<string, boolean> }) => {
    const select = args?.select ?? {};
    // The pages the guest created — none.
    if (!select.teamspaceId) return [];
    return PAGES;
  });
});

describe("guestScope — the pages a guest may see", () => {
  it("grants the shared page, its ancestors and the guest's own teamspace pages", async () => {
    const scope = await guestScope("user-guest", "ws1");

    expect([...scope.pageIds].sort()).toEqual([
      "ops-page",
      "shared-page",
      "ts-root",
    ]);
  });
});

describe("guestScope — the teamspaces a guest may see", () => {
  it("names the guest's own teamspaces and the ones their pages live in", async () => {
    const scope = await guestScope("user-guest", "ws1");

    expect([...scope.teamspaceIds].sort()).toEqual(["teamspace-1", "teamspace-3"]);
  });

  it("leaves out the teamspaces the guest has no business seeing", async () => {
    const scope = await guestScope("user-guest", "ws1");

    // "teamspace-2" holds "other-page", which is in nobody's scope.
    expect(scope.teamspaceIds.has("teamspace-2")).toBe(false);
  });

  it("is empty for a guest who may see nothing", async () => {
    db.pagePermissionFindMany.mockResolvedValue([]);
    db.teamspaceMemberFindMany.mockResolvedValue([]);

    const scope = await guestScope("user-guest", "ws1");

    expect(scope.pageIds.size).toBe(0);
    expect(scope.teamspaceIds.size).toBe(0);
  });
});

describe("viewerScopeFor", () => {
  it("is null for everybody but a guest", async () => {
    expect(await viewerScopeFor("user-owner", "ws1", "MEMBER")).toBeNull();
    expect(await viewerScopeFor("user-owner", "ws1", "ADMIN")).toBeNull();
  });

  it("is the guest scope for a guest", async () => {
    const scope = await viewerScopeFor("user-guest", "ws1", "GUEST");

    expect(scope).not.toBeNull();
    expect(scope?.pageIds.has("shared-page")).toBe(true);
    expect(scope?.teamspaceIds.has("teamspace-1")).toBe(true);
  });
});
