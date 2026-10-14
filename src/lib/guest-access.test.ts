import { describe, expect, it } from "vitest";
import { isVisibleToGuest, withAncestors } from "./guest-access";

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
