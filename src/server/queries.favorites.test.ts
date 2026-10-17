import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * B54 — the guest scope of `getFavorites` is a **required** argument.
 *
 * The scope defaults to "no scope" — the widest option — so a second caller
 * that omits it would silently get the whole workspace's favourites. The
 * sibling queries (`getPageTree`, `getPagesPage`, `getTrash`) made the scope
 * required for the same reason, and this one follows.
 *
 * `Function.length` counts the parameters *before* the first default: a
 * parameter with a default is not counted, a required one is. The arity
 * assertion below therefore pins "the scope has no default" at runtime.
 */

const db = vi.hoisted(() => ({
  favoriteFindMany: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    favorite: { findMany: db.favoriteFindMany },
  },
}));

import { getFavorites } from "./queries";

beforeEach(() => {
  vi.clearAllMocks();
  db.favoriteFindMany.mockResolvedValue([]);
});

describe("getFavorites — the scope is a required argument", () => {
  it("has no default value, so a caller cannot forget the filter", () => {
    expect(getFavorites.length).toBe(3);
  });

  it("narrows the query to the scope", async () => {
    await getFavorites("user-1", "ws1", new Set(["p1", "p2"]));

    const [args] = db.favoriteFindMany.mock.calls[0] as [
      { where: { page: { id?: { in: string[] } } } },
    ];
    expect(args.where.page.id).toEqual({ in: ["p1", "p2"] });
  });

  it("returns every favourite of the workspace when the scope is null", async () => {
    await getFavorites("user-1", "ws1", null);

    const [args] = db.favoriteFindMany.mock.calls[0] as [
      { where: { page: { id?: { in: string[] } } } },
    ];
    expect(args.where.page.id).toBeUndefined();
  });
});
