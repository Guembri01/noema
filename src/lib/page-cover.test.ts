import { describe, expect, it } from "vitest";
import {
  ALLOWED_UNSPLASH_HOSTS,
  COVER_TYPES,
  GRADIENTS,
  coverCss,
  coverKey,
  isCoverEmpty,
  resolveCoverUrl,
  validateCover,
  type CoverValue,
} from "./page-cover";

/**
 * B9 — Page cover model
 * (docs/MISSING_FEATURES.md §1 "Editor & blocks", row "Page cover":
 * "Banner image on a page."; row "Cover reposition" builds on this value).
 *
 * Written RED-first against a missing module, then implemented. Coverage pins:
 * - the gradient preset catalog (ids → CSS) and the three cover types,
 * - tolerant validation (image = http(s), gradient = known id, unsplash =
 *   allow-listed host; anything else fails closed with a reason),
 * - CSS emission that never renders an invalid/injected value,
 * - resolved URLs (image passes through; unsplash gets the width transform),
 * - the emptiness predicate used to toggle the "Add cover" affordance,
 * - pure helpers: callers keep their own objects (no mutation).
 */

const IMAGE: CoverValue = { type: "image", url: "https://cdn.example.com/a.png" };
const UNSPLASH: CoverValue = {
  type: "unsplash",
  url: "https://images.unsplash.com/photo-1234567890",
};
const GRADIENT: CoverValue = { type: "gradient", gradientId: "ocean" };

describe("GRADIENTS catalog", () => {
  it("exposes the three cover types", () => {
    expect(COVER_TYPES).toEqual(["image", "gradient", "unsplash"]);
  });

  it("maps each preset id to a linear-gradient CSS value", () => {
    const ids = Object.keys(GRADIENTS);
    expect(ids.length).toBeGreaterThanOrEqual(8);
    for (const id of ids) {
      expect(GRADIENTS[id as keyof typeof GRADIENTS]).toMatch(/^linear-gradient\(/);
    }
  });

  it("includes the default 'ocean' preset", () => {
    expect(GRADIENTS.ocean).toContain("#66a6ff");
  });
});

describe("validateCover", () => {
  it("accepts a well-formed value of each type", () => {
    expect(validateCover(IMAGE).valid).toBe(true);
    expect(validateCover(GRADIENT).valid).toBe(true);
    expect(validateCover(UNSPLASH).valid).toBe(true);
  });

  it("rejects a nullish or non-object cover with a reason", () => {
    expect(validateCover(null).valid).toBe(false);
    expect(validateCover(undefined).valid).toBe(false);
    expect(validateCover("nope").valid).toBe(false);
    expect(validateCover(null).errors).toContain("missing-cover");
  });

  it("rejects an unknown type", () => {
    const result = validateCover({ type: "video", url: "https://x/y.mp4" });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("unknown-type");
  });

  it("requires an http(s) URL for an image cover", () => {
    expect(validateCover({ type: "image" }).errors).toContain("missing-url");
    expect(validateCover({ type: "image", url: "javascript:alert(1)" }).errors).toContain(
      "invalid-url",
    );
    expect(validateCover({ type: "image", url: "/uploads/a.png" }).errors).toContain("invalid-url");
    expect(validateCover({ type: "image", url: "http://cdn.example.com/a.png" }).valid).toBe(true);
  });

  it("requires a known gradient id", () => {
    expect(validateCover({ type: "gradient" }).errors).toContain("missing-gradient");
    expect(validateCover({ type: "gradient", gradientId: "nope" }).errors).toContain(
      "unknown-gradient",
    );
  });

  it("requires an unsplash URL from an allowed host", () => {
    expect(ALLOWED_UNSPLASH_HOSTS).toContain("images.unsplash.com");
    const foreign = validateCover({ type: "unsplash", url: "https://evil.example.com/p.jpg" });
    expect(foreign.valid).toBe(false);
    expect(foreign.errors).toContain("host-not-allowed");
    expect(validateCover({ type: "unsplash" }).errors).toContain("missing-url");
  });

  it("never throws on hostile input", () => {
    expect(() => validateCover({ type: "image", url: "ht tp://x" })).not.toThrow();
    expect(validateCover({ type: "image", url: "ht tp://x" }).valid).toBe(false);
  });
});

describe("coverCss", () => {
  it("emits a background-image value per type", () => {
    expect(coverCss(GRADIENT)).toBe(GRADIENTS.ocean);
    expect(coverCss(IMAGE)).toBe('url("https://cdn.example.com/a.png")');
    expect(coverCss(UNSPLASH)).toBe('url("https://images.unsplash.com/photo-1234567890")');
  });

  it("emits nothing for an empty or invalid cover (no injection)", () => {
    expect(coverCss(null)).toBe("");
    expect(coverCss(undefined)).toBe("");
    expect(coverCss({ type: "gradient", gradientId: "nope" })).toBe("");
    expect(coverCss({ type: "image", url: 'javascript:alert(1)"' })).toBe("");
  });
});

describe("resolveCoverUrl", () => {
  it("returns the image URL unchanged", () => {
    expect(resolveCoverUrl(IMAGE)).toBe("https://cdn.example.com/a.png");
    expect(resolveCoverUrl(IMAGE, { width: 800 })).toBe("https://cdn.example.com/a.png");
  });

  it("applies the width transform to an unsplash URL", () => {
    const resolved = resolveCoverUrl(UNSPLASH, { width: 1200 });
    expect(resolved).not.toBeNull();
    const url = new URL(resolved as string);
    expect(url.hostname).toBe("images.unsplash.com");
    expect(url.searchParams.get("w")).toBe("1200");
    expect(url.searchParams.get("fit")).toBe("crop");
    expect(url.searchParams.get("auto")).toBe("format");
  });

  it("ignores a nonsense width and returns null for a gradient", () => {
    expect(resolveCoverUrl(UNSPLASH, { width: -5 })).toBe("https://images.unsplash.com/photo-1234567890");
    expect(resolveCoverUrl(UNSPLASH, { width: Number.NaN })).toBe(
      "https://images.unsplash.com/photo-1234567890",
    );
    expect(resolveCoverUrl(GRADIENT)).toBeNull();
    expect(resolveCoverUrl(null)).toBeNull();
  });
});

describe("isCoverEmpty", () => {
  it("is true when nothing would render", () => {
    expect(isCoverEmpty(null)).toBe(true);
    expect(isCoverEmpty(undefined)).toBe(true);
    expect(isCoverEmpty({ type: "gradient" })).toBe(true);
    expect(isCoverEmpty({ type: "gradient", gradientId: "nope" })).toBe(true);
    expect(isCoverEmpty({ type: "image" })).toBe(true);
    expect(isCoverEmpty({ type: "image", url: "not-a-url" })).toBe(true);
  });

  it("is false for a renderable cover", () => {
    expect(isCoverEmpty(IMAGE)).toBe(false);
    expect(isCoverEmpty(GRADIENT)).toBe(false);
    expect(isCoverEmpty(UNSPLASH)).toBe(false);
  });
});

/**
 * The crossfade key: "same cover" must be decided by what the cover *is*, not by the
 * identity of the object a fresh parse produced — otherwise repositioning a cover
 * would replay its entrance animation.
 */
describe("coverKey", () => {
  it("distinguishes covers by type and its identifying field", () => {
    expect(coverKey({ type: "image", url: "https://cdn.example.com/a.png" })).toBe("image:https://cdn.example.com/a.png");
    expect(coverKey({ type: "gradient", gradientId: "ocean" })).toBe("gradient:ocean");
    expect(coverKey({ type: "image", url: "https://cdn.example.com/a.png" })).not.toBe(
      coverKey({ type: "gradient", gradientId: "ocean" }),
    );
  });

  it("is stable across equal values that are different objects", () => {
    const a = { type: "image" as const, url: "https://cdn.example.com/a.png" };
    expect(coverKey({ ...a })).toBe(coverKey(a));
  });

  it("is empty for a missing or empty cover", () => {
    expect(coverKey(null)).toBe("");
    expect(coverKey(undefined)).toBe("");
    expect(coverKey({ type: "image", url: "" })).toBe("");
  });
});
