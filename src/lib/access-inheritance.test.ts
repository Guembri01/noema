import { describe, expect, it } from "vitest";
import type { SharePermission, WorkspaceRole } from "@prisma/client";
import {
  describeAccess,
  effectiveAccess,
  type AccessUser,
  type LinkShare,
  type PageGrant,
} from "./access-inheritance";

/**
 * Red-first suite for MISSING_FEATURES §8 (Sharing & permissions):
 * permission inheritance, per-page permissions and the access audit view.
 *
 * The rule under test is fail-closed, matching `permissions.ts`: no grant +
 * no inheritance + no link share means NO access — never an implicit allow.
 * Access levels are the repo's existing `SharePermission` enum; `null` is the
 * only "no access" marker (there is no parallel enum).
 *
 * The page tree used throughout:
 *
 *   root  (no parent)
 *    └─ mid      (ancestry of leaf: ["mid", "root"], nearest first)
 *         └─ leaf
 */

const PAGE = { id: "leaf" } as const;
const ANCESTRY = ["mid", "root"] as const;

const user = (id: string, role: WorkspaceRole | null): AccessUser => ({ id, role });
const grant = (pageId: string, userId: string, level: SharePermission): PageGrant => ({
  pageId,
  userId,
  level,
});
const link = (pageId: string, permission: SharePermission, expiresAt?: Date): LinkShare => ({
  pageId,
  permission,
  expiresAt,
});

describe("effectiveAccess — explicit grants", () => {
  it("resolves a direct grant on the page itself", () => {
    expect(
      effectiveAccess({
        user: user("u1", "MEMBER"),
        page: PAGE,
        ancestry: ANCESTRY,
        grants: [grant("leaf", "u1", "EDIT")],
      }),
    ).toBe("EDIT");
  });

  it("resolves a grant inherited from the immediate parent", () => {
    expect(
      effectiveAccess({
        user: user("u1", "MEMBER"),
        page: PAGE,
        ancestry: ANCESTRY,
        grants: [grant("mid", "u1", "COMMENT")],
      }),
    ).toBe("COMMENT");
  });

  it("resolves a grant inherited from a grandparent", () => {
    expect(
      effectiveAccess({
        user: user("u1", "MEMBER"),
        page: PAGE,
        ancestry: ANCESTRY,
        grants: [grant("root", "u1", "READ")],
      }),
    ).toBe("READ");
  });

  it("ignores grants that belong to other users or other pages", () => {
    expect(
      effectiveAccess({
        user: user("u1", "MEMBER"),
        page: PAGE,
        ancestry: ANCESTRY,
        grants: [grant("leaf", "u2", "FULL"), grant("elsewhere", "u1", "FULL")],
      }),
    ).toBe(null);
  });

  it("ignores grants when the viewer is anonymous (links are the anonymous vehicle)", () => {
    expect(
      effectiveAccess({
        user: null,
        page: PAGE,
        ancestry: ANCESTRY,
        grants: [grant("leaf", "u1", "FULL")],
      }),
    ).toBe(null);
  });
});

describe("effectiveAccess — nearest grant wins", () => {
  it("prefers the page grant over a parent grant", () => {
    expect(
      effectiveAccess({
        user: user("u1", "MEMBER"),
        page: PAGE,
        ancestry: ANCESTRY,
        grants: [grant("leaf", "u1", "READ"), grant("mid", "u1", "FULL")],
      }),
    ).toBe("READ");
  });

  it("prefers the nearest ancestor grant over a more distant one", () => {
    expect(
      effectiveAccess({
        user: user("u1", "MEMBER"),
        page: PAGE,
        ancestry: ANCESTRY,
        grants: [grant("mid", "u1", "READ"), grant("root", "u1", "EDIT")],
      }),
    ).toBe("READ");
  });
});

describe("effectiveAccess — link shares", () => {
  it("grants the link permission to any user, even anonymous", () => {
    expect(
      effectiveAccess({
        user: null,
        page: PAGE,
        ancestry: ANCESTRY,
        linkShares: [link("leaf", "READ")],
      }),
    ).toBe("READ");
  });

  it("ignores a link that points at a different page", () => {
    expect(
      effectiveAccess({
        user: null,
        page: PAGE,
        ancestry: ANCESTRY,
        linkShares: [link("mid", "READ")],
      }),
    ).toBe(null);
  });

  it("ignores an expired link, including one that expires exactly now (fail closed)", () => {
    const now = new Date("2026-01-10T00:00:00Z");
    expect(
      effectiveAccess({
        user: null,
        page: PAGE,
        ancestry: ANCESTRY,
        linkShares: [link("leaf", "READ", new Date("2026-01-01T00:00:00Z"))],
        now,
      }),
    ).toBe(null);
    expect(
      effectiveAccess({
        user: null,
        page: PAGE,
        ancestry: ANCESTRY,
        linkShares: [link("leaf", "READ", now)],
        now,
      }),
    ).toBe(null);
  });

  it("keeps a still-valid link open", () => {
    const now = new Date("2026-01-10T00:00:00Z");
    expect(
      effectiveAccess({
        user: null,
        page: PAGE,
        ancestry: ANCESTRY,
        linkShares: [link("leaf", "READ", new Date("2026-01-11T00:00:00Z"))],
        now,
      }),
    ).toBe("READ");
  });

  it("takes the strongest link when several exist", () => {
    expect(
      effectiveAccess({
        user: null,
        page: PAGE,
        ancestry: ANCESTRY,
        linkShares: [link("leaf", "READ"), link("leaf", "COMMENT")],
      }),
    ).toBe("COMMENT");
  });
});

describe("effectiveAccess — workspace role baseline", () => {
  it("gives the owner full access with no grants at all", () => {
    expect(effectiveAccess({ user: user("u1", "OWNER"), page: PAGE, ancestry: ANCESTRY })).toBe(
      "FULL",
    );
  });

  it("gives an admin full access with no grants at all", () => {
    expect(effectiveAccess({ user: user("u1", "ADMIN"), page: PAGE, ancestry: ANCESTRY })).toBe(
      "FULL",
    );
  });

  it("gives a member and a guest no implicit access (fail closed)", () => {
    expect(effectiveAccess({ user: user("u1", "MEMBER"), page: PAGE, ancestry: ANCESTRY })).toBe(
      null,
    );
    expect(effectiveAccess({ user: user("u1", "GUEST"), page: PAGE, ancestry: ANCESTRY })).toBe(
      null,
    );
  });

  it("denies a non-member (role null) and an anonymous viewer", () => {
    expect(effectiveAccess({ user: user("u1", null), page: PAGE, ancestry: ANCESTRY })).toBe(null);
    expect(effectiveAccess({ user: null, page: PAGE, ancestry: ANCESTRY })).toBe(null);
  });

  it("denies a forged/unknown role value", () => {
    expect(
      effectiveAccess({
        user: { id: "u1", role: "SUPERADMIN" as unknown as WorkspaceRole },
        page: PAGE,
        ancestry: ANCESTRY,
      }),
    ).toBe(null);
  });
});

describe("effectiveAccess — combining sources", () => {
  it("keeps the stronger of an inherited grant and a weaker link share", () => {
    expect(
      effectiveAccess({
        user: user("u1", "MEMBER"),
        page: PAGE,
        ancestry: ANCESTRY,
        grants: [grant("mid", "u1", "EDIT")],
        linkShares: [link("leaf", "READ")],
      }),
    ).toBe("EDIT");
  });

  it("does not let a page grant downgrade the owner/admin role baseline", () => {
    expect(
      effectiveAccess({
        user: user("u1", "ADMIN"),
        page: PAGE,
        ancestry: ANCESTRY,
        grants: [grant("leaf", "u1", "READ")],
      }),
    ).toBe("FULL");
  });

  it("lets a direct FULL grant beat an inherited READ grant", () => {
    expect(
      effectiveAccess({
        user: user("u1", "MEMBER"),
        page: PAGE,
        ancestry: ANCESTRY,
        grants: [grant("leaf", "u1", "FULL"), grant("root", "u1", "READ")],
      }),
    ).toBe("FULL");
  });

  it("grants a guest access only through an explicit grant", () => {
    expect(
      effectiveAccess({
        user: user("u1", "GUEST"),
        page: PAGE,
        ancestry: ANCESTRY,
        grants: [grant("mid", "u1", "READ")],
      }),
    ).toBe("READ");
  });
});

describe("effectiveAccess — fail-closed negatives", () => {
  it("denies everything when there is no grant, no inheritance and no link", () => {
    expect(effectiveAccess({ user: user("u1", "MEMBER"), page: PAGE, ancestry: ANCESTRY })).toBe(
      null,
    );
    expect(effectiveAccess({ user: user("u1", "GUEST"), page: PAGE, ancestry: ANCESTRY })).toBe(
      null,
    );
    expect(effectiveAccess({ user: user("u1", null), page: PAGE, ancestry: ANCESTRY })).toBe(null);
    expect(effectiveAccess({ user: null, page: PAGE, ancestry: ANCESTRY })).toBe(null);
  });

  it("ignores a grant whose level is forged/unknown", () => {
    expect(
      effectiveAccess({
        user: user("u1", "MEMBER"),
        page: PAGE,
        ancestry: ANCESTRY,
        grants: [grant("leaf", "u1", "OWN" as unknown as SharePermission)],
      }),
    ).toBe(null);
  });

  it("ignores a link whose permission is forged/unknown", () => {
    expect(
      effectiveAccess({
        user: null,
        page: PAGE,
        ancestry: ANCESTRY,
        linkShares: [link("leaf", "ADMIN" as unknown as SharePermission)],
      }),
    ).toBe(null);
  });
});

describe("describeAccess — who can access this page", () => {
  /** Full roster, including the workspace owner (role baseline applies). */
  const roster: AccessUser[] = [
    user("owner", "OWNER"),
    user("member", "MEMBER"),
    user("outsider", "MEMBER"),
    user("guest", "GUEST"),
  ];
  /** Same roster without the owner, so negative cases stay empty. */
  const membersOnly: AccessUser[] = roster.filter((entry) => entry.id !== "owner");

  it("lists role-based and direct access and omits users with none", () => {
    const entries = describeAccess({
      page: PAGE,
      ancestry: ANCESTRY,
      users: roster,
      grants: [grant("leaf", "member", "EDIT"), grant("root", "member", "READ")],
    });
    expect(entries).toEqual([
      { userId: "owner", level: "FULL", source: "role" },
      { userId: "member", level: "EDIT", source: "direct" },
    ]);
  });

  it("marks inherited access for a grant living on an ancestor", () => {
    const entries = describeAccess({
      page: PAGE,
      ancestry: ANCESTRY,
      users: membersOnly,
      grants: [grant("mid", "guest", "COMMENT")],
    });
    expect(entries).toEqual([{ userId: "guest", level: "COMMENT", source: "inherited" }]);
  });

  it("surfaces a stale grant for a user who is no longer in the roster", () => {
    const entries = describeAccess({
      page: PAGE,
      ancestry: ANCESTRY,
      users: membersOnly,
      grants: [grant("leaf", "revoked-user", "EDIT")],
    });
    expect(entries).toContainEqual({ userId: "revoked-user", level: "EDIT", source: "direct" });
  });

  it("ignores stale grants that point at pages outside this chain", () => {
    const entries = describeAccess({
      page: PAGE,
      ancestry: ANCESTRY,
      users: membersOnly,
      grants: [grant("elsewhere", "revoked-user", "EDIT")],
    });
    expect(entries).toEqual([]);
  });

  it("appends a single anonymous entry for a public link share", () => {
    const entries = describeAccess({
      page: PAGE,
      ancestry: ANCESTRY,
      users: membersOnly,
      grants: [],
      linkShares: [link("leaf", "READ"), link("leaf", "EDIT")],
    });
    expect(entries).toEqual([{ userId: null, level: "EDIT", source: "link" }]);
  });

  it("omits the link entry when the link is expired or belongs elsewhere", () => {
    const now = new Date("2026-01-10T00:00:00Z");
    expect(
      describeAccess({
        page: PAGE,
        ancestry: ANCESTRY,
        users: membersOnly,
        grants: [],
        linkShares: [link("leaf", "READ", new Date("2026-01-01T00:00:00Z"))],
        now,
      }),
    ).toEqual([]);
    expect(
      describeAccess({
        page: PAGE,
        ancestry: ANCESTRY,
        users: membersOnly,
        grants: [],
        linkShares: [link("mid", "READ")],
        now,
      }),
    ).toEqual([]);
  });

  it("deduplicates a repeated user in the roster", () => {
    const entries = describeAccess({
      page: PAGE,
      ancestry: ANCESTRY,
      users: [...membersOnly, user("member", "MEMBER")],
      grants: [grant("leaf", "member", "EDIT")],
    });
    expect(entries.filter((entry) => entry.userId === "member")).toHaveLength(1);
  });

  it("returns an empty list for a page nobody can access (fail closed)", () => {
    expect(describeAccess({ page: PAGE, ancestry: ANCESTRY, users: membersOnly, grants: [] })).toEqual(
      [],
    );
  });
});
