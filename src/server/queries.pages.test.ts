import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * B02 — `getPagesPage` and `getPageTree` must honour the guest scope.
 *
 * The listing was the one page query without a scope parameter, so
 * `GET /api/v1/pages` listed the whole workspace for a guest. The scope is now
 * a *required* argument, so the filter cannot be forgotten, and it lands in
 * the `where` clause as an id restriction. `getPageTree` follows the same rule.
 *
 * Only the Prisma edge is mocked; the query builder runs for real.
 */

const db = vi.hoisted(() => ({ pageFindMany: vi.fn() }));

vi.mock("@/lib/db", () => ({
  prisma: { page: { findMany: db.pageFindMany } },
}));

import { getPageTree, getPagesPage } from "./queries";

/** The `where` clause the query was called with. */
function whereOf(): Record<string, unknown> {
  const [args] = db.pageFindMany.mock.calls[0] as [{ where: Record<string, unknown> }];
  return args.where;
}

beforeEach(() => {
  vi.clearAllMocks();
  db.pageFindMany.mockResolvedValue([]);
});

describe("getPagesPage — guest scope (B02)", () => {
  it("restricts the query to the visible page ids", async () => {
    await getPagesPage("ws-1", new Set(["p1", "p2"]));

    expect(whereOf()).toEqual({
      workspaceId: "ws-1",
      deletedAt: null,
      id: { in: ["p1", "p2"] },
    });
  });

  it("returns the whole workspace for a null scope (a full member)", async () => {
    await getPagesPage("ws-1", null);

    expect(whereOf()).toEqual({ workspaceId: "ws-1", deletedAt: null });
  });

  it("restricts the query to nothing for an empty scope", async () => {
    await getPagesPage("ws-1", new Set<string>());

    expect(whereOf()).toEqual({ workspaceId: "ws-1", deletedAt: null, id: { in: [] } });
  });
});

/**
 * `getPageTree` takes its scope as a **required** argument: the scope used to
 * be optional, so two call sites (the library page and the move page) loaded
 * the whole workspace for a guest. The filter itself was already there — the
 * required argument is what makes it unforgettable.
 */
describe("getPageTree — guest scope (B02)", () => {
  it("restricts the query to the visible page ids", async () => {
    await getPageTree("ws-1", new Set(["p1", "p2"]));

    expect(whereOf()).toEqual({
      workspaceId: "ws-1",
      deletedAt: null,
      id: { in: ["p1", "p2"] },
    });
  });

  it("returns the whole workspace for a null scope (a full member)", async () => {
    await getPageTree("ws-1", null);

    expect(whereOf()).toEqual({ workspaceId: "ws-1", deletedAt: null });
  });
});
