import { describe, expect, it } from "vitest";
import {
  NONE_PAGE_ICON,
  PAGE_ICON_EMOJI,
  isEmoji,
  isImageIcon,
  normalizePageIcon,
  pageIconToCss,
  parsePageIcon,
  randomEmoji,
  type PageIcon,
} from "./page-icon";

/**
 * G1 — page icon model (red-first).
 *
 * `src/lib/page-icon.ts` did not exist when this file was written, so the whole
 * suite fails on the missing module until the helpers land. They are the pure,
 * view-facing layer over `Page.icon` (a `String?` column that has so far stored
 * a raw emoji and rendered as plain text): classify a stored value
 * (`parsePageIcon`), recognise the two icon families (`isEmoji`,
 * `isImageIcon`), repair a stale/mismatched record (`normalizePageIcon`), pick
 * a placeholder (`randomEmoji`) and hand the renderer its CSS
 * (`pageIconToCss`).
 *
 * Everything is deterministic: `randomEmoji` takes an injected `rand`, and no
 * helper mutates its input.
 */

describe("parsePageIcon", () => {
  it("fails closed to the empty icon for non-string / blank input", () => {
    expect(parsePageIcon(null)).toEqual({ kind: "none", value: "" });
    expect(parsePageIcon(42)).toEqual({ kind: "none", value: "" });
    expect(parsePageIcon("")).toEqual({ kind: "none", value: "" });
    expect(parsePageIcon("   ")).toEqual({ kind: "none", value: "" });
  });

  it("reads an emoji, trimming surrounding whitespace", () => {
    expect(parsePageIcon("🙂")).toEqual({ kind: "emoji", value: "🙂" });
    expect(parsePageIcon("  🎉  ")).toEqual({ kind: "emoji", value: "🎉" });
  });

  it("reads an http(s) URL as an image icon", () => {
    expect(parsePageIcon("https://cdn.test/a.png")).toEqual({
      kind: "image",
      value: "https://cdn.test/a.png",
    });
    expect(parsePageIcon("http://cdn.test/a.png")).toEqual({
      kind: "image",
      value: "http://cdn.test/a.png",
    });
  });

  it("fails closed on junk and unsafe schemes", () => {
    expect(parsePageIcon("javascript:alert(1)")).toEqual({
      kind: "none",
      value: "",
    });
    expect(parsePageIcon("not an icon")).toEqual({ kind: "none", value: "" });
  });

  it("exposes the frozen canonical empty icon", () => {
    expect(NONE_PAGE_ICON).toEqual({ kind: "none", value: "" });
    expect(Object.isFrozen(NONE_PAGE_ICON)).toBe(true);
  });
});

describe("isEmoji", () => {
  it("accepts single emoji and composed sequences", () => {
    expect(isEmoji("🙂")).toBe(true);
    expect(isEmoji("❤️")).toBe(true);
    expect(isEmoji("👨👩👧👦")).toBe(true);
  });

  it("rejects blank, text, mixed and non-string values", () => {
    expect(isEmoji("")).toBe(false);
    expect(isEmoji("hello")).toBe(false);
    expect(isEmoji("🙂 hi")).toBe(false);
    expect(isEmoji(42)).toBe(false);
  });

  it("rejects an over-long run of emoji (roughly one grapheme only)", () => {
    expect(isEmoji("🙂".repeat(20))).toBe(false);
  });
});

describe("isImageIcon", () => {
  it("accepts http and https URLs, case-insensitively", () => {
    expect(isImageIcon("https://cdn.test/a.png")).toBe(true);
    expect(isImageIcon("HTTPS://CDN.TEST/A.PNG")).toBe(true);
  });

  it("rejects other schemes, relative paths and non-strings", () => {
    expect(isImageIcon("ftp://cdn.test/a.png")).toBe(false);
    expect(isImageIcon("//cdn.test/a.png")).toBe(false);
    expect(isImageIcon(42)).toBe(false);
  });
});

describe("normalizePageIcon", () => {
  it("derives the kind from a raw string value", () => {
    expect(normalizePageIcon("🙂")).toEqual({ kind: "emoji", value: "🙂" });
    expect(normalizePageIcon("https://cdn.test/a.png")).toEqual({
      kind: "image",
      value: "https://cdn.test/a.png",
    });
  });

  it("corrects a stale kind using the stored value as source of truth", () => {
    expect(normalizePageIcon({ kind: "image", value: "🙂" })).toEqual({
      kind: "emoji",
      value: "🙂",
    });
    expect(
      normalizePageIcon({ kind: "emoji", value: "https://cdn.test/a.png" }),
    ).toEqual({ kind: "image", value: "https://cdn.test/a.png" });
  });

  it("fails closed on malformed records", () => {
    expect(normalizePageIcon({ kind: "emoji", value: "nope" })).toEqual({
      kind: "none",
      value: "",
    });
    expect(normalizePageIcon({})).toEqual({ kind: "none", value: "" });
  });

  it("never mutates its input", () => {
    const input: PageIcon = { kind: "image", value: "🙂" };
    const before = { ...input };
    normalizePageIcon(input);
    expect(input).toEqual(before);
  });
});

describe("randomEmoji", () => {
  it("maps a zero draw to the first curated emoji and a full draw to the last", () => {
    expect(randomEmoji(() => 0)).toBe(PAGE_ICON_EMOJI[0]);
    expect(randomEmoji(() => 0.999999)).toBe(
      PAGE_ICON_EMOJI[PAGE_ICON_EMOJI.length - 1],
    );
  });

  it("is deterministic for a given stream", () => {
    const rand = () => 0.5;
    expect(randomEmoji(rand)).toBe(
      PAGE_ICON_EMOJI[Math.floor(0.5 * PAGE_ICON_EMOJI.length)],
    );
  });

  it("always returns a curated, valid emoji", () => {
    const emoji = randomEmoji(() => Math.random());
    expect(PAGE_ICON_EMOJI).toContain(emoji);
    expect(isEmoji(emoji)).toBe(true);
  });

  it("clamps out-of-range draws and lists no duplicates", () => {
    expect(randomEmoji(() => -1)).toBe(PAGE_ICON_EMOJI[0]);
    expect(new Set(PAGE_ICON_EMOJI).size).toBe(PAGE_ICON_EMOJI.length);
  });
});

describe("pageIconToCss", () => {
  it("exposes an image icon as a background layer", () => {
    expect(
      pageIconToCss({ kind: "image", value: "https://cdn.test/a.png" }),
    ).toEqual({ backgroundImage: 'url("https://cdn.test/a.png")' });
  });

  it("adds no CSS for emoji or none", () => {
    expect(pageIconToCss({ kind: "emoji", value: "🙂" })).toEqual({});
    expect(pageIconToCss(NONE_PAGE_ICON)).toEqual({});
  });

  it("escapes quotes and backslashes in the URL", () => {
    expect(
      pageIconToCss({ kind: "image", value: 'https://cdn.test/a"b.png' }),
    ).toEqual({
      backgroundImage: String.raw`url("https://cdn.test/a\"b.png")`,
    });
    expect(
      pageIconToCss({ kind: "image", value: "https://cdn.test/a\\b.png" }),
    ).toEqual({
      backgroundImage: String.raw`url("https://cdn.test/a\\b.png")`,
    });
  });
});
