import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AvatarStack, toAvatarUsers } from "./avatar-stack";

/**
 * Wiring proof for `src/lib/avatars.ts` → the topbar avatar stack.
 *
 * The engine itself is covered by `src/lib/avatars.test.ts` (47 tests). These
 * assertions lock the *adapter*: the member-row → `AvatarUser` narrowing (the
 * only new pure mapping) and the fact that the rendered stack is actually
 * driven by `stackPlan` / `presenceLabel` / `avatarSrcSet` rather than a copy.
 */

const render = (props: Parameters<typeof AvatarStack>[0]): string =>
  renderToStaticMarkup(createElement(AvatarStack, props));

describe("toAvatarUsers", () => {
  it("trims ids and preserves the fields the engine reads", () => {
    const users = toAvatarUsers([
      { id: " u1 ", name: "Ada Lovelace", email: "ada@example.com" },
      { id: "u2", name: "Bob", avatarUrl: "https://example.com/bob.png" },
    ]);
    expect(users).toEqual([
      {
        id: "u1",
        name: "Ada Lovelace",
        avatarUrl: null,
        email: "ada@example.com",
      },
      {
        id: "u2",
        name: "Bob",
        avatarUrl: "https://example.com/bob.png",
        email: null,
      },
    ]);
  });

  it("drops blank/unkeyable rows and tolerates junk input", () => {
    expect(toAvatarUsers([{ id: "  ", name: "ghost" }])).toEqual([]);
    expect(toAvatarUsers(null)).toEqual([]);
    expect(toAvatarUsers(undefined)).toEqual([]);
    // A member missing a name still resolves through the engine (initials "?").
    expect(toAvatarUsers([{ id: "u3", name: "" }])).toHaveLength(1);
  });
});

describe("AvatarStack render", () => {
  it("announces the room with the engine's presence sentence", () => {
    const users = toAvatarUsers([
      { id: "u1", name: "Ada Lovelace" },
      { id: "u2", name: "Bob" },
    ]);
    const html = render({ users });
    expect(html).toContain('data-testid="topbar-avatar-stack"');
    expect(html).toContain('aria-label="Ada Lovelace and Bob"');
    // Ids ascend, so Ada (u1) is listed first.
    expect(html.indexOf("Ada")).toBeLessThan(html.indexOf("Bob"));
  });

  it("collapses the overflow into a +N chip from stackPlan", () => {
    const users = toAvatarUsers([
      { id: "u1", name: "Patch" },
      { id: "u2", name: "Nine" },
      { id: "u3", name: "Kai" },
    ]);
    const html = render({ users, max: 2 });
    expect(html).toContain("+1");
    // Three names but only two faces: the third is hidden behind the chip.
    expect(html).toContain('aria-label="Patch, Nine and 1 other"');
  });

  it("renders a photo avatar with a density srcSet from avatarSrcSet", () => {
    const users = toAvatarUsers([
      { id: "u1", name: "Photo", avatarUrl: "https://example.com/p.png" },
    ]);
    const html = render({ users });
    expect(html).toContain('src="https://example.com/p.png"');
    expect(html).toContain("https://example.com/p.png 1x");
    expect(html).toContain("https://example.com/p.png 2x");
  });

  it("renders nothing when no viewer resolves", () => {
    expect(render({ users: [] })).toBe("");
    expect(render({ users: toAvatarUsers([{ id: "", name: "x" }]) })).toBe("");
  });
});
