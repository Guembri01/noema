import { describe, expect, it } from "vitest";
import {
  AVATAR_PALETTE,
  AVATAR_SIZES,
  avatarSrcSet,
  colourFor,
  dedupeUsers,
  initialsOf,
  placeholderAvatar,
  presenceLabel,
  resolveAvatar,
  stackPlan,
  type AvatarUser,
} from "./avatars";

/**
 * Avatar resolution & presence-stack model (§7 Avatars).
 *
 * Red-first: `src/lib/avatars.ts` did not exist when this file was written, so
 * the suite fails on the missing module until the helper lands. These are the
 * pure, deterministic pieces behind an avatar surface: how a user becomes an
 * image-or-initials avatar, which initials and colour stand in for a missing
 * photo, how a row of faces collapses into a `+N` stack, and how a room full
 * of names reads as one sentence — all provable without a DOM or a network.
 */

const u = (id: string, over: Partial<AvatarUser> = {}): AvatarUser => ({
  id,
  name: id.toUpperCase(),
  ...over,
});

describe("initialsOf", () => {
  it("uses the first and last word of a multi-word name", () => {
    expect(initialsOf("Ada Lovelace")).toBe("AL");
    expect(initialsOf("Ada Byron King Lovelace")).toBe("AL");
  });

  it("uses up to two letters of a single-word name", () => {
    expect(initialsOf("Ada")).toBe("AD");
  });

  it("uppercases mixed-case names", () => {
    expect(initialsOf("ada lovelace")).toBe("AL");
  });

  it("trims and collapses internal whitespace", () => {
    expect(initialsOf("   Ada    Lovelace  ")).toBe("AL");
  });

  it("falls back to ? for a blank or missing name", () => {
    expect(initialsOf("   ")).toBe("?");
    expect(initialsOf("")).toBe("?");
    expect(initialsOf(null)).toBe("?");
    expect(initialsOf(undefined)).toBe("?");
  });

  it("is CJK-aware for spaced and unspaced names", () => {
    expect(initialsOf("李雷")).toBe("李雷");
    expect(initialsOf("李 雷")).toBe("李雷");
    expect(initialsOf("山田 太郎")).toBe("山太");
  });

  it("splits hyphenated names", () => {
    expect(initialsOf("Jean-Luc Picard")).toBe("JP");
    expect(initialsOf("Jean-Luc")).toBe("JL");
  });

  it("ignores tokens that carry no letters or numbers", () => {
    expect(initialsOf("Ada 👍 Lovelace")).toBe("AL");
    expect(initialsOf("👍")).toBe("?");
  });

  it("never splits a surrogate pair", () => {
    expect(initialsOf("𝔘𝔫𝔦")).toBe("𝔘𝔫");
  });

  it("never returns more than two characters", () => {
    for (const name of ["Ada", "Ada Lovelace", "李雷", "Jean-Luc Picard", "𝔘𝔫𝔦"]) {
      expect(Array.from(initialsOf(name)).length).toBeLessThanOrEqual(2);
    }
  });
});

describe("colourFor", () => {
  it("is deterministic for a seed", () => {
    expect(colourFor("user-1")).toBe(colourFor("user-1"));
    expect(colourFor("")).toBe(colourFor(""));
  });

  it("always returns a colour from the palette", () => {
    for (const seed of ["", "a", "user-1234567", "🙂", "z".repeat(200)]) {
      expect(AVATAR_PALETTE).toContain(colourFor(seed));
    }
  });

  it("spreads a sample of ids across more than one colour", () => {
    const seeds = ["alice", "bob", "carol", "dave", "erin", "frank", "grace", "heidi"];
    expect(new Set(seeds.map(colourFor)).size).toBeGreaterThan(1);
  });
});

describe("resolveAvatar", () => {
  it("derives an initials avatar when no image is available", () => {
    const avatar = resolveAvatar(u("u1", { name: "Ada Lovelace" }));
    expect(avatar.kind).toBe("initials");
    expect(avatar.src).toBeUndefined();
    expect(avatar.initials).toBe("AL");
    // The colour is keyed by the user id, not the display name.
    expect(avatar.background).toBe(colourFor("u1"));
    expect(["#ffffff", "#18181b"]).toContain(avatar.foreground);
  });

  it("uses an absolute http avatar url", () => {
    const avatar = resolveAvatar(u("u1", { name: "Ada", avatarUrl: "https://cdn.example/a.png" }));
    expect(avatar.kind).toBe("image");
    expect(avatar.src).toBe("https://cdn.example/a.png");
    expect(avatar.initials).toBe("AD");
  });

  it("falls back to initials for a blank or non-http url", () => {
    expect(resolveAvatar(u("u1", { avatarUrl: "   " })).kind).toBe("initials");
    expect(resolveAvatar(u("u1", { avatarUrl: "javascript:alert(1)" })).kind).toBe("initials");
  });

  it("sizes a gravatar url to the requested box", () => {
    const avatar = resolveAvatar(
      u("u1", { avatarUrl: "https://www.gravatar.com/avatar/abc123" }),
      { size: 64 },
    );
    expect(avatar.kind).toBe("image");
    expect(avatar.src).toContain("s=64");
  });

  it("defaults the gravatar size to 32", () => {
    const avatar = resolveAvatar(u("u1", { avatarUrl: "https://gravatar.com/avatar/abc" }));
    expect(avatar.src).toContain("s=32");
  });

  it("honours allowGravatar: false by falling back to initials", () => {
    const avatar = resolveAvatar(
      u("u1", { name: "Ada", avatarUrl: "https://www.gravatar.com/avatar/abc" }),
      { allowGravatar: false },
    );
    expect(avatar.kind).toBe("initials");
  });

  it("does not rewrite a non-gravatar url", () => {
    const avatar = resolveAvatar(u("u1", { avatarUrl: "https://cdn.example/a.png?x=1" }));
    expect(avatar.src).toBe("https://cdn.example/a.png?x=1");
  });

  it("uses the email local part when the name is blank", () => {
    const avatar = resolveAvatar(u("u1", { name: "", email: "ada@example.com" }));
    expect(avatar.initials).toBe("AD");
  });

  it("handles a missing user", () => {
    const avatar = resolveAvatar(null);
    expect(avatar.kind).toBe("initials");
    expect(avatar.initials).toBe("?");
    expect(AVATAR_PALETTE).toContain(avatar.background);
  });
});

describe("stackPlan", () => {
  const users = ["a", "b", "c", "d", "e", "f", "g"].map((id) => u(id, { name: id.toUpperCase() }));

  it("shows everyone when the roster fits", () => {
    const plan = stackPlan(users.slice(0, 3), { max: 5, size: 24 });
    expect(plan.visible.map((entry) => entry.id)).toEqual(["a", "b", "c"]);
    expect(plan.overflow).toBe(0);
    expect(plan.overflowLabel).toBe("");
  });

  it("caps the visible avatars and reports the overflow", () => {
    const plan = stackPlan(users, { max: 5, size: 24 });
    expect(plan.visible.map((entry) => entry.id)).toEqual(["a", "b", "c", "d", "e"]);
    expect(plan.overflow).toBe(2);
    expect(plan.overflowLabel).toBe("+2");
  });

  it("does not overflow when the roster exactly fills max", () => {
    const plan = stackPlan(users.slice(0, 5), { max: 5, size: 24 });
    expect(plan.overflow).toBe(0);
    expect(plan.overflowLabel).toBe("");
  });

  it("orders deterministically by id regardless of input order", () => {
    const scrambled = [users[2], users[0], users[1]];
    expect(stackPlan(scrambled, { max: 3, size: 16 }).visible.map((entry) => entry.id)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("dedupes users before slicing", () => {
    const dupes = [users[0], users[1], users[0], users[2], users[1]];
    const plan = stackPlan(dupes, { max: 5, size: 24 });
    expect(plan.visible.map((entry) => entry.id)).toEqual(["a", "b", "c"]);
    expect(plan.overflow).toBe(0);
  });

  it("resolves each visible avatar at the requested size", () => {
    const plan = stackPlan(
      [u("a", { avatarUrl: "https://www.gravatar.com/avatar/x" })],
      { max: 1, size: 128 },
    );
    expect(plan.visible[0].avatar.kind).toBe("image");
    expect(plan.visible[0].avatar.src).toContain("s=128");
  });

  it("shows nothing when max is zero", () => {
    const plan = stackPlan(users.slice(0, 3), { max: 0, size: 24 });
    expect(plan.visible).toEqual([]);
    expect(plan.overflow).toBe(3);
    expect(plan.overflowLabel).toBe("+3");
  });

  it("defaults to max 5 and size 24", () => {
    const plan = stackPlan(users);
    expect(plan.visible).toHaveLength(5);
    expect(plan.overflow).toBe(2);
  });
});

describe("presenceLabel", () => {
  it("names a single person", () => {
    expect(presenceLabel([u("a", { name: "Ada" })])).toBe("Ada");
  });

  it("joins two people with 'and'", () => {
    expect(presenceLabel([u("a", { name: "Ada" }), u("b", { name: "Bob" })])).toBe("Ada and Bob");
  });

  it("collapses three or more with a count", () => {
    const three = [u("a", { name: "Ada" }), u("b", { name: "Bob" }), u("c", { name: "Cy" })];
    expect(presenceLabel(three)).toBe("Ada, Bob and 1 other");
    const five = [...three, u("d", { name: "Dee" }), u("e", { name: "Eve" })];
    expect(presenceLabel(five)).toBe("Ada, Bob and 3 others");
  });

  it("orders names deterministically by id", () => {
    expect(presenceLabel([u("b", { name: "Bob" }), u("a", { name: "Ada" })])).toBe("Ada and Bob");
  });

  it("excludes the viewer when selfId is given", () => {
    const list = [u("a", { name: "Ada" }), u("b", { name: "Bob" }), u("c", { name: "Cy" })];
    expect(presenceLabel(list, { selfId: "b" })).toBe("Ada and Cy");
    expect(presenceLabel(list, { selfId: "a" })).toBe("Bob and Cy");
  });

  it("says Only you when the viewer is alone", () => {
    expect(presenceLabel([u("a", { name: "Ada" })], { selfId: "a" })).toBe("Only you");
  });

  it("says No one when there is nobody and no viewer", () => {
    expect(presenceLabel([])).toBe("No one");
  });

  it("falls back to Anonymous for a blank name", () => {
    expect(presenceLabel([u("a", { name: "   " })])).toBe("Anonymous");
  });
});

describe("dedupeUsers", () => {
  it("keeps the first occurrence of each id", () => {
    const list = [u("a", { name: "First" }), u("b"), u("a", { name: "Second" })];
    const out = dedupeUsers(list);
    expect(out.map((entry) => entry.id)).toEqual(["a", "b"]);
    expect(out[0].name).toBe("First");
  });

  it("drops entries without a usable id", () => {
    const out = dedupeUsers([u("", { name: "Ghost" }), u("  ", { name: "Space" }), u("a")]);
    expect(out.map((entry) => entry.id)).toEqual(["a"]);
  });

  it("returns a new array and leaves the input untouched", () => {
    const list = [u("a"), u("a")];
    const snapshot = [...list];
    const out = dedupeUsers(list);
    expect(out).not.toBe(list);
    expect(list).toEqual(snapshot);
  });
});

describe("avatarSrcSet", () => {
  const image = resolveAvatar(u("u1", { avatarUrl: "https://cdn.example/a.png" }));

  it("returns an empty srcset for an initials avatar", () => {
    expect(avatarSrcSet(resolveAvatar(u("u1", { name: "Ada" })))).toBe("");
  });

  it("builds 1x/2x descriptors for an image", () => {
    expect(avatarSrcSet(image, { dpr: 2 })).toBe(
      "https://cdn.example/a.png 1x, https://cdn.example/a.png 2x",
    );
  });

  it("defaults to 2x and clamps the dpr range", () => {
    expect(avatarSrcSet(image)).toBe(
      "https://cdn.example/a.png 1x, https://cdn.example/a.png 2x",
    );
    expect(avatarSrcSet(image, { dpr: 0 })).toBe("https://cdn.example/a.png 1x");
    expect(avatarSrcSet(image, { dpr: 9 })).toBe(
      "https://cdn.example/a.png 1x, https://cdn.example/a.png 2x, https://cdn.example/a.png 3x, https://cdn.example/a.png 4x",
    );
  });

  it("returns an empty srcset for a missing avatar", () => {
    expect(avatarSrcSet(null)).toBe("");
  });
});

describe("placeholderAvatar", () => {
  it("builds a deterministic initials avatar from a seed", () => {
    const a = placeholderAvatar("Ada Lovelace");
    const b = placeholderAvatar("Ada Lovelace");
    expect(a).toEqual(b);
    expect(a.kind).toBe("initials");
    expect(a.src).toBeUndefined();
    expect(a.initials).toBe("AL");
    expect(a.background).toBe(colourFor("Ada Lovelace"));
  });

  it("advertises the fixed size ladder", () => {
    expect([...AVATAR_SIZES]).toContain(64);
    expect([...AVATAR_SIZES]).toContain(16);
  });
});
