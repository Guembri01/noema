import { describe, expect, it } from "vitest";
import { slugify } from "@/lib/slug";
import {
  RESERVED_SLUGS,
  allocateSlugs,
  reserveSlug,
  uniqueSlug,
} from "@/lib/slug-uniqueness";

describe("uniqueSlug()", () => {
  it("returns the slugified base when nothing collides", () => {
    expect(uniqueSlug("My Page")).toBe("my-page");
    expect(uniqueSlug("Already-Slugged")).toBe("already-slugged");
  });

  it("appends -1, -2 … on collision", () => {
    expect(uniqueSlug("post", ["post"])).toBe("post-1");
    expect(uniqueSlug("post", ["post", "post-1"])).toBe("post-2");
    expect(uniqueSlug("post", ["post", "post-1", "post-2", "post-3"])).toBe("post-4");
  });

  it("fills the first free gap rather than counting upwards blindly", () => {
    expect(uniqueSlug("post", ["post", "post-2"])).toBe("post-1");
  });

  it("collides case-insensitively", () => {
    expect(uniqueSlug("Post", ["POST"])).toBe("post-1");
    expect(uniqueSlug("POST", new Set(["Post", "pOsT-1"]))).toBe("post-2");
  });

  it("accepts a Set or an array of taken slugs", () => {
    expect(uniqueSlug("doc", new Set(["doc"]))).toBe("doc-1");
    expect(uniqueSlug("doc", ["doc"])).toBe("doc-1");
  });

  it("falls back to a default stem for empty or slug-less bases", () => {
    expect(uniqueSlug("")).toBe("workspace");
    expect(uniqueSlug("   ")).toBe("workspace");
    expect(uniqueSlug("!!!")).toBe("workspace");
    expect(uniqueSlug("", ["workspace"])).toBe("workspace-1");
  });

  it("never hands out a reserved route word", () => {
    for (const word of ["new", "settings", "admin"]) {
      expect(RESERVED_SLUGS.has(word)).toBe(true);
      expect(uniqueSlug(word)).toBe(`${word}-1`);
    }
  });

  it("honours an extra reserved list", () => {
    expect(uniqueSlug("draft", [], { reserved: ["draft"] })).toBe("draft-1");
    expect(uniqueSlug("draft", ["draft-1"], { reserved: ["draft"] })).toBe("draft-2");
  });

  it("does not mutate the taken collection", () => {
    const taken = new Set(["post"]);
    uniqueSlug("Post", taken);
    expect([...taken]).toEqual(["post"]);
  });

  it("agrees with slugify for an already-clean base", () => {
    expect(uniqueSlug("Hello, World!")).toBe(slugify("Hello, World!"));
  });
});

describe("allocateSlugs()", () => {
  it("allocates one unique slug per base, preserving order", () => {
    expect(allocateSlugs(["alpha", "beta", "gamma"])).toEqual([
      "alpha",
      "beta",
      "gamma",
    ]);
  });

  it("de-duplicates identical bases within the batch", () => {
    expect(allocateSlugs(["post", "post", "post"])).toEqual([
      "post",
      "post-1",
      "post-2",
    ]);
  });

  it("continues past slugs that are already taken", () => {
    expect(allocateSlugs(["post", "post"], ["post", "post-1"])).toEqual([
      "post-2",
      "post-3",
    ]);
  });

  it("applies reserved words across the whole batch", () => {
    expect(allocateSlugs(["new", "new"])).toEqual(["new-1", "new-2"]);
  });

  it("returns an empty array for an empty batch", () => {
    expect(allocateSlugs([])).toEqual([]);
  });

  it("leaves no batch slug free for a later allocation", () => {
    const batch = allocateSlugs(["note", "note"]);
    expect(uniqueSlug("note", batch)).toBe("note-2");
  });
});

describe("reserveSlug()", () => {
  it("returns a new set containing the normalised slug", () => {
    expect([...reserveSlug("  Intro  ")]).toEqual(["intro"]);
  });

  it("is idempotent and keeps the existing entries", () => {
    const once = reserveSlug("intro", ["draft"]);
    const twice = reserveSlug("INTRO", once);
    expect([...once].sort()).toEqual(["draft", "intro"]);
    expect([...twice].sort()).toEqual(["draft", "intro"]);
  });

  it("does not mutate the input collection", () => {
    const taken = new Set(["draft"]);
    reserveSlug("intro", taken);
    expect([...taken]).toEqual(["draft"]);
  });

  it("rejects an empty slug", () => {
    expect(() => reserveSlug("")).toThrow(/empty/i);
    expect(() => reserveSlug("   ")).toThrow(/empty/i);
  });

  it("feeds uniqueSlug so a reserved slug stays reserved", () => {
    let taken = reserveSlug("intro");
    taken = reserveSlug("intro-1", taken);
    expect(uniqueSlug("Intro", taken)).toBe("intro-2");
  });
});

describe("RESERVED_SLUGS", () => {
  it("lists lower-case route words and excludes the fallback stem", () => {
    expect(RESERVED_SLUGS.size).toBeGreaterThan(0);
    for (const word of RESERVED_SLUGS) expect(word).toBe(word.toLowerCase());
    expect(RESERVED_SLUGS.has("workspace")).toBe(false);
  });
});
