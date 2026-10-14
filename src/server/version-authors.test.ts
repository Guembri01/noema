import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * B67 - the shared version-authorship resolver (R30.11-lite of
 * docs/specs/version-history-v2.md): ONE resolver, used by both the page
 * history panel (`page.tsx`) and the ...-menu timeline (`page-menu.ts`), that
 * looks up the `User` row for `PageVersion.createdById` regardless of current
 * workspace membership - the exact divergence the spec audits
 * (`page.tsx:198` members-only vs `page-menu.ts:155-172` User lookup).
 *
 * Red-first: written before `src/server/version-authors.ts` existed.
 */

const db = vi.hoisted(() => ({ userFindMany: vi.fn() }));

vi.mock("@/lib/db", () => ({
  prisma: { user: { findMany: db.userFindMany } },
}));

import { loadVersionAuthors } from "./version-authors";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("loadVersionAuthors (R30.11 lite - one resolver, both surfaces)", () => {
  it("resolves authors from User rows, membership-independent, one query", async () => {
    db.userFindMany.mockResolvedValue([
      { id: "u1", name: "Ada Lovelace", email: "ada@example.test" },
    ]);
    const resolve = await loadVersionAuthors(["u1", "u2", "u1", null]);

    expect(db.userFindMany).toHaveBeenCalledTimes(1);
    // Deduped + null-filtered id list.
    expect(db.userFindMany.mock.calls[0][0].where.id.in).toEqual(["u1", "u2"]);
    expect(resolve("u1")).toEqual({ id: "u1", name: "Ada Lovelace", email: "ada@example.test" });
    // Author id with no surviving User row -> null (caller renders its label).
    expect(resolve("u2")).toBeNull();
    expect(resolve(null)).toBeNull();
  });

  it("skips the query entirely when no version carries an author id", async () => {
    const resolve = await loadVersionAuthors([null, null, undefined]);
    expect(db.userFindMany).not.toHaveBeenCalled();
    expect(resolve(null)).toBeNull();
  });
});
