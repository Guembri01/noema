import { describe, expect, it } from "vitest";
import {
  canGuestAccess,
  canInviteGuest,
  createGrant,
  describeGrant,
  expireGrants,
  guestEditablePageIds,
  guestLimitsForPlan,
  isGrantActive,
  isGrantExpired,
  isGrantRevoked,
  isVisibleToGuest,
  normalizeGuestEmail,
  pageScopeFor,
  revokeGrant,
  toGuestSession,
  visiblePageIdsForGuest,
  visiblePagesForGuest,
  withAncestors,
  GuestGrantError,
  type CreateGuestGrantInput,
  type GuestGrant,
  type GuestPage,
  type GuestRole,
} from "./guest-access";

const pages = [
  { id: "root", parentId: null },
  { id: "mid", parentId: "root" },
  { id: "leaf", parentId: "mid" },
  { id: "other", parentId: null },
];

describe("withAncestors", () => {
  it("keeps the given pages and adds every parent up to the root", () => {
    const visible = withAncestors(["leaf"], pages);
    expect([...visible].sort()).toEqual(["leaf", "mid", "root"]);
    expect(visible.has("other")).toBe(false);
  });

  it("does not invent pages for unknown ids", () => {
    expect([...withAncestors(["ghost"], pages)]).toEqual(["ghost"]);
  });

  it("is a no-op for an empty set and tolerates cycles", () => {
    expect(withAncestors([], pages).size).toBe(0);
    const cyclic = [
      { id: "a", parentId: "b" },
      { id: "b", parentId: "a" },
    ];
    expect([...withAncestors(["a"], cyclic)].sort()).toEqual(["a", "b"]);
  });
});

describe("isVisibleToGuest", () => {
  it("is simply membership of the scoped set", () => {
    const visible = withAncestors(["leaf"], pages);
    expect(isVisibleToGuest("leaf", visible)).toBe(true);
    expect(isVisibleToGuest("other", visible)).toBe(false);
  });
});

/**
 * B02 — the scope every API and export route resolves before it queries.
 *
 * `null` means "the whole workspace", so the unknown-role case must never
 * produce it: a role that is not a known workspace role gets an *empty* scope
 * (fail closed) instead of the whole workspace.
 */
describe("pageScopeFor", () => {
  it("gives a full member the whole workspace", async () => {
    await expect(pageScopeFor("u1", "ws1", "OWNER")).resolves.toBeNull();
    await expect(pageScopeFor("u1", "ws1", "ADMIN")).resolves.toBeNull();
    await expect(pageScopeFor("u1", "ws1", "MEMBER")).resolves.toBeNull();
  });

  it("fails closed for an unknown role — never the whole workspace", async () => {
    const scope = await pageScopeFor("u1", "ws1", "SUPERUSER");

    expect(scope).not.toBeNull();
    expect((scope as Set<string>).size).toBe(0);
  });
});

/**
 * Pure, in-memory scoping primitive. Inheritance flows *down*: a page shared
 * with a guest covers its whole subtree, never its ancestors.
 *
 *   root            (shared with g1)
 *   ├── child
 *   │   └── grand   (shared with g3, so g3 reaches grand + deep only)
 *   │       └── deep
 *   └── leaf
 *   private         (shared with g2)
 */
const scoped: GuestPage[] = [
  { id: "root", parentId: null, sharedWithGuestIds: ["g1"] },
  { id: "child", parentId: "root" },
  { id: "grand", parentId: "child", sharedWithGuestIds: ["g3"] },
  { id: "deep", parentId: "grand" },
  { id: "leaf", parentId: "root" },
  { id: "private", parentId: null, sharedWithGuestIds: ["g2"] },
];

describe("visiblePageIdsForGuest", () => {
  it("grants a shared page and every descendant", () => {
    expect([...visiblePageIdsForGuest(scoped, "g1")].sort()).toEqual([
      "child",
      "deep",
      "grand",
      "leaf",
      "root",
    ]);
  });

  it("never grants ancestors of a shared page", () => {
    const visible = visiblePageIdsForGuest(scoped, "g3");
    expect([...visible].sort()).toEqual(["deep", "grand"]);
    expect(visible.has("root")).toBe(false);
    expect(visible.has("child")).toBe(false);
  });

  it("scopes each guest independently", () => {
    expect([...visiblePageIdsForGuest(scoped, "g2")]).toEqual(["private"]);
    expect(visiblePageIdsForGuest(scoped, "g9").size).toBe(0);
  });

  it("fails closed for a missing/blank guest id and empty input", () => {
    expect(visiblePageIdsForGuest(scoped, "").size).toBe(0);
    expect(visiblePageIdsForGuest([], "g1").size).toBe(0);
  });

  it("tolerates a parent cycle without hanging", () => {
    const cyclic: GuestPage[] = [
      { id: "a", parentId: "b", sharedWithGuestIds: ["g1"] },
      { id: "b", parentId: "a" },
    ];
    expect([...visiblePageIdsForGuest(cyclic, "g1")].sort()).toEqual(["a", "b"]);
  });
});

describe("canGuestAccess", () => {
  it("is true only inside the shared subtree", () => {
    expect(canGuestAccess(scoped, "g1", "root")).toBe(true);
    expect(canGuestAccess(scoped, "g1", "deep")).toBe(true);
    expect(canGuestAccess(scoped, "g1", "private")).toBe(false);
  });

  it("denies ancestors, unknown pages and unknown guests", () => {
    expect(canGuestAccess(scoped, "g3", "root")).toBe(false);
    expect(canGuestAccess(scoped, "g1", "ghost")).toBe(false);
    expect(canGuestAccess(scoped, "nobody", "root")).toBe(false);
    expect(canGuestAccess(scoped, "g1", "")).toBe(false);
  });
});

describe("guestEditablePageIds", () => {
  /**
   *   read-only    (shared with g1)
   *   └── read-child
   *   editable     (editable by g1)          → editable subtree
   *   ├── edit-child
   *   └── under    (also read-shared, already editable via the ancestor)
   *   other        (shared with g2)
   */
  const editable: GuestPage[] = [
    { id: "read-only", parentId: null, sharedWithGuestIds: ["g1"] },
    { id: "read-child", parentId: "read-only" },
    { id: "editable", parentId: null, editableGuestIds: ["g1"] },
    { id: "edit-child", parentId: "editable" },
    { id: "under", parentId: "editable", sharedWithGuestIds: ["g1"] },
    { id: "other", parentId: null, sharedWithGuestIds: ["g2"] },
  ];

  it("keeps read-only pages visible but out of the editable set", () => {
    const edit = guestEditablePageIds(editable, "g1");
    expect(edit.has("read-only")).toBe(false);
    expect(edit.has("read-child")).toBe(false);
    expect(visiblePageIdsForGuest(editable, "g1").has("read-only")).toBe(true);
  });

  it("includes the editable page and its descendants", () => {
    const edit = guestEditablePageIds(editable, "g1");
    expect([...edit].sort()).toEqual(["edit-child", "editable", "under"]);
  });

  it("isolates guests and fails closed", () => {
    expect([...guestEditablePageIds(editable, "g2")]).toEqual([]);
    expect(guestEditablePageIds(editable, "").size).toBe(0);
    expect(guestEditablePageIds([], "g1").size).toBe(0);
  });
});

/* ========================================================================== *
 * Guest grants — plans-licensing §7 (Guests) and §8 (R26.12 guest cap).
 * ========================================================================== */

const GRANT_NOW = Date.parse("2026-06-01T12:00:00.000Z");
const DAY_MS = 86_400_000;

function makeGrant(overrides: Partial<CreateGuestGrantInput> = {}): GuestGrant {
  return createGrant({
    id: "g-1",
    email: "guest@example.com",
    workspaceId: "ws1",
    pageIds: ["root"],
    role: "viewer",
    invitedBy: "owner@example.com",
    now: GRANT_NOW,
    ...overrides,
  });
}

describe("normalizeGuestEmail", () => {
  it("trims and lower-cases the whole address for case-insensitive identity", () => {
    expect(normalizeGuestEmail("  Alice@Example.COM ")).toBe("alice@example.com");
    expect(normalizeGuestEmail("A.Tag+notes@Example.com")).toBe("a.tag+notes@example.com");
  });

  it("returns null for non-strings, blanks and malformed addresses", () => {
    expect(normalizeGuestEmail(undefined)).toBeNull();
    expect(normalizeGuestEmail(42)).toBeNull();
    expect(normalizeGuestEmail("   ")).toBeNull();
    expect(normalizeGuestEmail("no-at-sign")).toBeNull();
    expect(normalizeGuestEmail("a@@b.com")).toBeNull();
    expect(normalizeGuestEmail("a@b")).toBeNull();
    expect(normalizeGuestEmail("a b@example.com")).toBeNull();
  });
});

describe("createGrant", () => {
  it("builds a normalised, deduped grant and stamps the injected clock", () => {
    const g = makeGrant({ email: "  Guest@Example.com ", pageIds: ["p1", "p2", "p1"] });
    expect(g.email).toBe("guest@example.com");
    expect(g.pageIds).toEqual(["p1", "p2"]);
    expect(g.createdAt).toBe(new Date(GRANT_NOW).toISOString());
    expect(g.role).toBe("viewer");
    expect(g.workspaceId).toBe("ws1");
    expect(g.invitedBy).toBe("owner@example.com");
    expect(g.expiresAt).toBeNull();
  });

  it("accepts a Date and an ISO string as the clock", () => {
    expect(makeGrant({ now: new Date(GRANT_NOW) }).createdAt).toBe(
      new Date(GRANT_NOW).toISOString(),
    );
    expect(makeGrant({ now: "2026-06-01T12:00:00.000Z" }).createdAt).toBe(
      new Date(GRANT_NOW).toISOString(),
    );
  });

  it("derives expiresAt from ttlDays without mutating the page list", () => {
    const pages = ["p1", "p1", "p2"];
    const g = makeGrant({ pageIds: pages, ttlDays: 7 });
    expect(g.expiresAt).toBe(new Date(GRANT_NOW + 7 * DAY_MS).toISOString());
    expect(pages).toEqual(["p1", "p1", "p2"]);
    expect(g.pageIds).not.toBe(pages);
  });

  it("mints distinct ids when none is supplied", () => {
    const a = makeGrant({ id: undefined });
    const b = makeGrant({ id: undefined });
    expect(a.id.length).toBeGreaterThan(0);
    expect(a.id).not.toBe(b.id);
  });

  it("rejects invalid construction input with a typed code", () => {
    const codeOf = (fn: () => unknown): string => {
      try {
        fn();
        return "no-throw";
      } catch (err) {
        return err instanceof GuestGrantError ? err.code : "not-a-grant-error";
      }
    };
    expect(codeOf(() => makeGrant({ email: "nope" }))).toBe("invalid_email");
    expect(codeOf(() => makeGrant({ pageIds: [] }))).toBe("invalid_page_ids");
    expect(codeOf(() => makeGrant({ pageIds: ["ok", "  "] }))).toBe("invalid_page_ids");
    expect(codeOf(() => makeGrant({ role: "editor" as GuestRole }))).toBe("invalid_role");
    expect(codeOf(() => makeGrant({ workspaceId: "  " }))).toBe("invalid_workspace");
    expect(codeOf(() => makeGrant({ invitedBy: "" }))).toBe("invalid_inviter");
    expect(codeOf(() => makeGrant({ ttlDays: 0 }))).toBe("invalid_ttl");
    expect(codeOf(() => makeGrant({ ttlDays: Number.NaN }))).toBe("invalid_ttl");
  });
});

describe("canGuestAccess (grant form)", () => {
  it("allows a page inside the grant scope and denies one outside it", () => {
    const g = makeGrant({ pageIds: ["a", "b"] });
    expect(canGuestAccess(g, { pageId: "a", now: GRANT_NOW })).toBe(true);
    expect(canGuestAccess(g, { pageId: "b", now: GRANT_NOW })).toBe(true);
    expect(canGuestAccess(g, { pageId: "z", now: GRANT_NOW })).toBe(false);
  });

  it("treats the expiry boundary instant as expired", () => {
    const g = makeGrant({ ttlDays: 1 });
    const expiry = Date.parse(g.expiresAt as string);
    expect(canGuestAccess(g, { pageId: "root", now: expiry - 1 })).toBe(true);
    expect(canGuestAccess(g, { pageId: "root", now: expiry })).toBe(false);
    expect(canGuestAccess(g, { pageId: "root", now: expiry + 1 })).toBe(false);
  });

  it("never expires a grant without expiresAt", () => {
    const g = makeGrant();
    expect(canGuestAccess(g, { pageId: "root", now: GRANT_NOW + 10_000 * DAY_MS })).toBe(true);
  });

  it("fails closed on a blank page id or a corrupt expiry", () => {
    expect(canGuestAccess(makeGrant(), { pageId: "", now: GRANT_NOW })).toBe(false);
    const corrupt: GuestGrant = { ...makeGrant(), expiresAt: "not-a-date" };
    expect(canGuestAccess(corrupt, { pageId: "root", now: GRANT_NOW })).toBe(false);
  });

  it("denies a revoked grant even inside scope and window", () => {
    const revoked = revokeGrant(makeGrant(), { now: GRANT_NOW, reason: "offboarded" });
    expect(canGuestAccess(revoked, { pageId: "root", now: GRANT_NOW })).toBe(false);
  });

  it("still supports the legacy page-list signature", () => {
    const pages: GuestPage[] = [
      { id: "root", parentId: null, sharedWithGuestIds: ["g1"] },
      { id: "child", parentId: "root" },
    ];
    expect(canGuestAccess(pages, "g1", "child")).toBe(true);
    expect(canGuestAccess(pages, "g1", "ghost")).toBe(false);
  });
});

describe("isGrantExpired / isGrantActive", () => {
  it("flags expiry at the boundary and treats a missing expiry as never", () => {
    const base = makeGrant();
    expect(isGrantExpired({ ...base, expiresAt: "2026-06-02T00:00:00.000Z" }, "2026-06-02T00:00:00.000Z")).toBe(true);
    expect(isGrantExpired({ ...base, expiresAt: "2026-06-03T00:00:00.000Z" }, "2026-06-02T00:00:00.000Z")).toBe(false);
    expect(isGrantExpired(base, "2030-01-01T00:00:00.000Z")).toBe(false);
  });

  it("fails closed on a corrupt expiry or unusable clock", () => {
    const base = makeGrant();
    expect(isGrantExpired({ ...base, expiresAt: "nope" }, GRANT_NOW)).toBe(true);
    expect(isGrantExpired({ ...base, expiresAt: "2026-06-02T00:00:00.000Z" }, "also-nope")).toBe(true);
  });

  it("is active only when neither revoked nor expired", () => {
    expect(isGrantActive(makeGrant(), GRANT_NOW)).toBe(true);
    expect(isGrantActive(revokeGrant(makeGrant(), { now: GRANT_NOW }), GRANT_NOW)).toBe(false);
    expect(isGrantActive(makeGrant({ ttlDays: 1 }), GRANT_NOW + 2 * DAY_MS)).toBe(false);
  });
});

describe("visiblePagesForGuest", () => {
  const tree = [
    { id: "root", parentId: null },
    { id: "child", parentId: "root" },
    { id: "grand", parentId: "child" },
    { id: "sibling", parentId: "root" },
    { id: "private", parentId: null },
  ];

  it("returns the granted page and its whole subtree", () => {
    const g = makeGrant({ email: "g@example.com", pageIds: ["root"] });
    const visible = visiblePagesForGuest(tree, [g], { email: "g@example.com" }, { now: GRANT_NOW });
    expect([...visible].sort()).toEqual(["child", "grand", "root", "sibling"]);
  });

  it("never includes ancestors of a granted page", () => {
    const g = makeGrant({ email: "g@example.com", pageIds: ["grand"] });
    const visible = visiblePagesForGuest(tree, [g], { email: "g@example.com" }, { now: GRANT_NOW });
    expect([...visible]).toEqual(["grand"]);
    expect(visible.has("root")).toBe(false);
    expect(visible.has("child")).toBe(false);
  });

  it("matches the guest by normalised email only", () => {
    const g = makeGrant({ email: "g@example.com", pageIds: ["root"] });
    const visible = visiblePagesForGuest(tree, [g], { email: "  G@Example.COM " }, { now: GRANT_NOW });
    expect(visible.has("root")).toBe(true);
  });

  it("fails closed for an unknown email, no email or no grants", () => {
    const g = makeGrant({ email: "g@example.com", pageIds: ["root"] });
    expect(visiblePagesForGuest(tree, [g], { email: "other@example.com" }, { now: GRANT_NOW }).size).toBe(0);
    expect(visiblePagesForGuest(tree, [g], {}, { now: GRANT_NOW }).size).toBe(0);
    expect(visiblePagesForGuest(tree, [], { email: "g@example.com" }, { now: GRANT_NOW }).size).toBe(0);
  });

  it("is never workspace-wide: unrelated pages stay hidden", () => {
    const g = makeGrant({ email: "g@example.com", pageIds: ["child"] });
    const visible = visiblePagesForGuest(tree, [g], { email: "g@example.com" }, { now: GRANT_NOW });
    expect(visible.has("private")).toBe(false);
    expect(visible.has("sibling")).toBe(false);
    expect(visible.has("root")).toBe(false);
  });

  it("excludes an expired grant once a clock is supplied", () => {
    const g = makeGrant({ email: "g@example.com", pageIds: ["root"], ttlDays: 1 });
    const after = GRANT_NOW + 2 * DAY_MS;
    expect(visiblePagesForGuest(tree, [g], { email: "g@example.com" }, { now: after }).size).toBe(0);
  });

  it("only evaluates expiry when a clock is supplied", () => {
    const g = makeGrant({ email: "g@example.com", pageIds: ["root"], ttlDays: 1 });
    expect(visiblePagesForGuest(tree, [g], { email: "g@example.com" }).has("root")).toBe(true);
  });

  it("excludes a revoked grant and ignores ids absent from the page list", () => {
    const revoked = revokeGrant(makeGrant({ email: "g@example.com", pageIds: ["root"] }), { now: GRANT_NOW });
    expect(visiblePagesForGuest(tree, [revoked], { email: "g@example.com" }, { now: GRANT_NOW }).size).toBe(0);
    const g = makeGrant({ email: "g@example.com", pageIds: ["ghost", "root"] });
    const visible = visiblePagesForGuest(tree, [g], { email: "g@example.com" }, { now: GRANT_NOW });
    expect(visible.has("ghost")).toBe(false);
    expect(visible.has("root")).toBe(true);
  });
});

describe("revokeGrant", () => {
  it("returns a revoked copy without mutating the original", () => {
    const g = makeGrant();
    const revoked = revokeGrant(g, { now: GRANT_NOW, reason: "offboarded" });
    expect(revoked.revokedAt).toBe(new Date(GRANT_NOW).toISOString());
    expect(revoked.reason).toBe("offboarded");
    expect(isGrantRevoked(revoked)).toBe(true);
    expect(isGrantRevoked(g)).toBe(false);
  });

  it("normalises a blank or absent reason to null", () => {
    expect(revokeGrant(makeGrant(), { now: GRANT_NOW, reason: "   " }).reason).toBeNull();
    expect(revokeGrant(makeGrant(), { now: GRANT_NOW }).reason).toBeNull();
  });

  it("throws a typed error on an unusable clock", () => {
    expect(() => revokeGrant(makeGrant(), { now: "nope" })).toThrow(GuestGrantError);
  });
});

describe("expireGrants", () => {
  it("partitions grants at the boundary instant", () => {
    const live = makeGrant({ id: "a", ttlDays: 30 });
    const dead = makeGrant({ id: "b", ttlDays: 1 });
    const forever = makeGrant({ id: "c" });
    const sweep = expireGrants([live, dead, forever], GRANT_NOW + 2 * DAY_MS);
    expect(sweep.expired.map((g) => g.id)).toEqual(["b"]);
    expect(sweep.active.map((g) => g.id).sort()).toEqual(["a", "c"]);
  });

  it("treats the expiry instant itself as expired and handles an empty list", () => {
    const g = makeGrant({ ttlDays: 1 });
    expect(expireGrants([g], Date.parse(g.expiresAt as string)).expired).toHaveLength(1);
    expect(expireGrants([], GRANT_NOW)).toEqual({ active: [], expired: [] });
  });
});

describe("guestLimitsForPlan / canInviteGuest", () => {
  it("maps each plan to its guest ceiling", () => {
    expect(guestLimitsForPlan("free")).toBe(0);
    expect(guestLimitsForPlan("plus")).toBe(25);
    expect(guestLimitsForPlan("business")).toBe(100);
    expect(guestLimitsForPlan("enterprise")).toBe("unlimited");
  });

  it("fails an unknown plan closed to the free ceiling", () => {
    expect(guestLimitsForPlan("platinum")).toBe(0);
    expect(guestLimitsForPlan("")).toBe(0);
  });

  it("admits a new guest below the cap and denies at the cap", () => {
    expect(canInviteGuest("plus", 24)).toBe(true);
    expect(canInviteGuest("plus", 25)).toBe(false);
    expect(canInviteGuest("free", 0)).toBe(false);
  });

  it("is uncapped on enterprise and fails closed on non-finite usage", () => {
    expect(canInviteGuest("enterprise", 100_000)).toBe(true);
    expect(canInviteGuest("plus", Number.NaN)).toBe(false);
    expect(canInviteGuest("plus", Number.POSITIVE_INFINITY)).toBe(false);
  });
});

describe("toGuestSession", () => {
  it("builds a read-only viewer session that can never edit", () => {
    const g = makeGrant({ role: "viewer", pageIds: ["a", "b"] });
    const s = toGuestSession(g);
    expect(s.kind).toBe("guest");
    expect(s.readOnly).toBe(true);
    expect(s.canView).toBe(true);
    expect(s.canComment).toBe(false);
    expect(s.canEdit).toBe(false);
    expect(s.pageIds).toEqual(["a", "b"]);
    expect(s.pageIds).not.toBe(g.pageIds);
  });

  it("unlocks commenting for a commenter but never editing", () => {
    const s = toGuestSession(makeGrant({ role: "commenter" }));
    expect(s.canComment).toBe(true);
    expect(s.canEdit).toBe(false);
    expect(s.readOnly).toBe(false);
  });

  it("reports a null expiry when the grant is perpetual", () => {
    expect(toGuestSession(makeGrant()).expiresAt).toBeNull();
  });
});

describe("describeGrant", () => {
  it("describes a viewer grant with its scope and no expiry", () => {
    const text = describeGrant(makeGrant({ email: "g@example.com", pageIds: ["a", "b"] }));
    expect(text).toContain("viewer guest g@example.com");
    expect(text).toContain("workspace ws1");
    expect(text).toContain("2 pages");
    expect(text).toContain("no expiry");
  });

  it("describes a commenter grant with its expiry and singular page count", () => {
    const g = makeGrant({ role: "commenter", ttlDays: 3 });
    const text = describeGrant(g);
    expect(text).toContain("commenter guest");
    expect(text).toContain(g.expiresAt as string);
    expect(text).toContain("1 page");
  });

  it("marks a revoked grant with its reason", () => {
    const text = describeGrant(revokeGrant(makeGrant(), { now: GRANT_NOW, reason: "offboarded" }));
    expect(text).toContain("revoked");
    expect(text).toContain("offboarded");
  });
});
