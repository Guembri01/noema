import { describe, expect, it } from "vitest";
import {
  canGuestAccess,
  guestEditablePageIds,
  isVisibleToGuest,
  visiblePageIdsForGuest,
  withAncestors,
  type GuestPage,
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
