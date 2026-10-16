import { describe, expect, it } from "vitest";
import {
  BADGE_EXCLUDED_PROPERTY_TYPES,
  COVER_IMAGE_PROPERTY_TYPES,
  DEFAULT_PREVIEW_MAX_CHARS,
  describePreview,
  excerpt,
  extractFirstImage,
  parsePreviewConfig,
  resolveCardPreview,
  validatePreviewConfig,
} from "./gallery-preview";
import type {
  GalleryPropertyLike,
  GalleryRowLike,
  PreviewConfig,
} from "./gallery-preview";

/**
 * Gallery card preview resolution (docs/specs/database-deep.md R89.9, §3
 * "Gallery previews"): a `PreviewConfig` picks the cover property, the text
 * excerpt and the badge properties of a gallery card.
 *
 * Red-first: `src/lib/gallery-preview.ts` did not exist when this file was
 * written, so the suite fails on the missing module until the helpers land.
 * Everything here is pure - no DB, no routes, no React - and covers the
 * cover-eligible selection order, word-boundary excerpt clipping, badge type
 * filtering, the unset-config fallback and URL safety (http/https only).
 */

const properties: GalleryPropertyLike[] = [
  { id: "title", name: "Name", type: "title" },
  { id: "cover", name: "Cover", type: "FILES" },
  { id: "shot", name: "Shot", type: "media" },
  { id: "link", name: "Link", type: "url" },
  { id: "body", name: "Body", type: "text" },
  { id: "status", name: "Status", type: "select" },
  { id: "owner", name: "Owner", type: "person" },
  { id: "done", name: "Done", type: "checkbox" },
  { id: "points", name: "Points", type: "number" },
];

const row = (
  values: Record<string, unknown> = {},
  overrides: Partial<GalleryRowLike> = {},
): GalleryRowLike => ({
  id: "r1",
  title: "Row one",
  icon: null,
  propertyValues: Object.entries(values).map(([propertyId, value]) => ({
    propertyId,
    value,
  })),
  ...overrides,
});

describe("parsePreviewConfig", () => {
  it("accepts a full object", () => {
    const config: PreviewConfig = {
      coverPropertyId: "cover",
      contentPropertyId: "body",
      fit: "contain",
      aspect: 1.5,
      showTitle: false,
      showProperties: ["status", "owner"],
    };
    expect(parsePreviewConfig(config)).toEqual({ ok: true, config });
  });

  it("defaults fit to cover", () => {
    expect(parsePreviewConfig({})).toEqual({ ok: true, config: { fit: "cover" } });
  });

  it("decodes a JSON string", () => {
    expect(parsePreviewConfig('{"fit":"contain"}')).toEqual({
      ok: true,
      config: { fit: "contain" },
    });
  });

  it("rejects malformed JSON", () => {
    expect(parsePreviewConfig("{not json").ok).toBe(false);
  });

  it("rejects a non-object", () => {
    expect(parsePreviewConfig(42).ok).toBe(false);
    expect(parsePreviewConfig(null).ok).toBe(false);
    expect(parsePreviewConfig(undefined).ok).toBe(false);
  });

  it("rejects an unknown fit", () => {
    expect(parsePreviewConfig({ fit: "stretch" }).ok).toBe(false);
  });

  it("rejects a non-positive aspect", () => {
    expect(parsePreviewConfig({ aspect: 0 }).ok).toBe(false);
    expect(parsePreviewConfig({ aspect: -2 }).ok).toBe(false);
    expect(parsePreviewConfig({ aspect: "wide" }).ok).toBe(false);
    expect(parsePreviewConfig({ aspect: Number.POSITIVE_INFINITY }).ok).toBe(false);
  });

  it("rejects a non-boolean showTitle", () => {
    expect(parsePreviewConfig({ showTitle: "yes" }).ok).toBe(false);
  });

  it("rejects non-string showProperties entries", () => {
    expect(parsePreviewConfig({ showProperties: [1] }).ok).toBe(false);
    expect(parsePreviewConfig({ showProperties: "status" }).ok).toBe(false);
  });

  it("trims ids and drops blanks and duplicates", () => {
    expect(
      parsePreviewConfig({
        coverPropertyId: "  cover  ",
        showProperties: [" status ", "", "status", "owner"],
      }),
    ).toEqual({
      ok: true,
      config: {
        coverPropertyId: "cover",
        fit: "cover",
        showProperties: ["status", "owner"],
      },
    });
  });
});

describe("extractFirstImage", () => {
  it("returns a plain url", () => {
    expect(extractFirstImage("https://cdn.test/a.png")).toBe("https://cdn.test/a.png");
  });

  it("returns an http url", () => {
    expect(extractFirstImage("http://cdn.test/a.png")).toBe("http://cdn.test/a.png");
  });

  it("trims whitespace", () => {
    expect(extractFirstImage("  https://cdn.test/a.png  ")).toBe("https://cdn.test/a.png");
  });

  it("picks the first safe url from an array", () => {
    expect(
      extractFirstImage([
        { url: "data:image/png;base64,AAAA" },
        { url: "https://cdn.test/b.png" },
      ]),
    ).toBe("https://cdn.test/b.png");
  });

  it("reads url/src/href from an object", () => {
    expect(extractFirstImage({ src: "https://cdn.test/c.png" })).toBe(
      "https://cdn.test/c.png",
    );
    expect(extractFirstImage({ href: "https://cdn.test/d.png" })).toBe(
      "https://cdn.test/d.png",
    );
  });

  it("reads a FILES value", () => {
    expect(
      extractFirstImage({ files: [{ name: "a", url: "https://cdn.test/file.png" }] }),
    ).toBe("https://cdn.test/file.png");
  });

  it("rejects unsafe or relative urls", () => {
    for (const bad of [
      "javascript:alert(1)",
      "data:image/png;base64,AAAA",
      "ftp://cdn.test/a.png",
      "/uploads/a.png",
      "//cdn.test/a.png",
      "",
      "   ",
    ]) {
      expect(extractFirstImage(bad)).toBeUndefined();
    }
    expect(extractFirstImage({ url: "javascript:alert(1)" })).toBeUndefined();
    expect(extractFirstImage({ files: [{ url: "/relative.png" }] })).toBeUndefined();
  });

  it("returns undefined for non-image values", () => {
    expect(extractFirstImage(42)).toBeUndefined();
    expect(extractFirstImage(null)).toBeUndefined();
    expect(extractFirstImage(["not a url"])).toBeUndefined();
  });
});

describe("excerpt", () => {
  it("returns short text unchanged", () => {
    expect(excerpt("Short note")).toEqual({ text: "Short note", truncated: false });
  });

  it("clips on a word boundary", () => {
    expect(excerpt("the quick brown fox jumps", { maxChars: 10 })).toEqual({
      text: "the quick",
      truncated: true,
    });
  });

  it("hard-cuts when there is no boundary", () => {
    expect(excerpt("supercalifragilistic", { maxChars: 5 })).toEqual({
      text: "super",
      truncated: true,
    });
  });

  it("uses the 256-char default", () => {
    const text = "word ".repeat(100).trim();
    const result = excerpt(text);
    expect(DEFAULT_PREVIEW_MAX_CHARS).toBe(256);
    expect(result.truncated).toBe(true);
    expect(result.text.length).toBeLessThanOrEqual(256);
    expect(text.startsWith(result.text)).toBe(true);
  });

  it("collapses whitespace", () => {
    expect(excerpt("  hello\n\n  world  ")).toEqual({
      text: "hello world",
      truncated: false,
    });
  });

  it("reports truncation for a zero limit", () => {
    expect(excerpt("hello", { maxChars: 0 })).toEqual({ text: "", truncated: true });
    expect(excerpt("", { maxChars: 10 })).toEqual({ text: "", truncated: false });
  });
});

describe("resolveCardPreview", () => {
  it("uses the configured cover and propagates fit and aspect", () => {
    const preview = resolveCardPreview(
      row({ cover: "https://cdn.test/cover.png" }),
      { coverPropertyId: "cover", fit: "contain", aspect: 1.5 },
      { properties },
    );
    expect(preview.cover).toEqual({
      url: "https://cdn.test/cover.png",
      fit: "contain",
      aspect: 1.5,
    });
    expect(preview.badges).toEqual([]);
  });

  it("auto-selects the first cover-eligible property when unset", () => {
    const preview = resolveCardPreview(
      row({ body: "text first", shot: "https://cdn.test/shot.png" }),
      {},
      { properties },
    );
    expect(preview.cover).toEqual({ url: "https://cdn.test/shot.png", fit: "cover" });
  });

  it("matches media types case-insensitively", () => {
    const preview = resolveCardPreview(
      row({ cover: "https://cdn.test/cover.png" }),
      {},
      { properties },
    );
    expect(preview.cover?.url).toBe("https://cdn.test/cover.png");
  });

  it("skips an ineligible configured cover and falls back", () => {
    const preview = resolveCardPreview(
      row({ body: "plain text", cover: "https://cdn.test/cover.png" }),
      { coverPropertyId: "body" },
      { properties },
    );
    expect(preview.cover?.url).toBe("https://cdn.test/cover.png");
  });

  it("falls back to the first eligible image when the chosen cover is empty", () => {
    const preview = resolveCardPreview(
      row({ shot: "https://cdn.test/shot.png" }),
      { coverPropertyId: "cover" },
      { properties },
    );
    expect(preview.cover?.url).toBe("https://cdn.test/shot.png");
  });

  it("returns no cover when nothing yields a safe image", () => {
    const preview = resolveCardPreview(
      row({ cover: { files: [{ url: "/uploads/a.png" }] } }),
      { coverPropertyId: "cover" },
      { properties },
    );
    expect(preview.cover).toBeUndefined();
  });

  it("rejects an unsafe cover url", () => {
    const preview = resolveCardPreview(
      row({ cover: "javascript:alert(1)" }),
      { coverPropertyId: "cover" },
      { properties },
    );
    expect(preview.cover).toBeUndefined();
  });

  it("builds badges from showProperties, filtering by type", () => {
    const preview = resolveCardPreview(
      row({
        title: "ignored",
        cover: "https://cdn.test/cover.png",
        status: { optionId: "In progress" },
        owner: { names: ["Ada", "Grace"] },
        done: { checked: false },
        points: { number: 7 },
      }),
      { showProperties: ["cover", "title", "status", "owner", "done", "points", "missing"] },
      { properties },
    );
    expect(preview.badges).toEqual([
      { propertyId: "status", value: "In progress" },
      { propertyId: "owner", value: "Ada, Grace" },
      { propertyId: "done", value: "No" },
      { propertyId: "points", value: "7" },
    ]);
  });

  it("defaults badges to schema order and skips empty cells", () => {
    const preview = resolveCardPreview(
      row({ link: "https://cdn.test/site", status: { optionId: "Todo" } }),
      {},
      { properties },
    );
    expect(preview.badges).toEqual([
      { propertyId: "link", value: "https://cdn.test/site" },
      { propertyId: "status", value: "Todo" },
    ]);
  });

  it("resolves the excerpt from row content with the 256 limit", () => {
    const preview = resolveCardPreview(
      row({}, { content: "x".repeat(300) }),
      {},
      { properties },
    );
    expect(preview.excerpt?.truncated).toBe(true);
    expect(preview.excerpt?.text.length).toBeLessThanOrEqual(256);
  });

  it("prefers an explicit content property over row content", () => {
    const preview = resolveCardPreview(
      row({ body: "from the body" }, { content: "from the page" }),
      { contentPropertyId: "body" },
      { properties },
    );
    expect(preview.excerpt).toEqual({ text: "from the body", truncated: false });
  });

  it("omits the excerpt when there is no content", () => {
    const preview = resolveCardPreview(row({}), {}, { properties });
    expect(preview.excerpt).toBeUndefined();
    expect(preview.cover).toBeUndefined();
  });

  it("does not mutate the row", () => {
    const values = [{ propertyId: "cover", value: "https://cdn.test/x.png" }];
    const target = row({}, { propertyValues: values, content: "note" });
    const snapshot = JSON.parse(JSON.stringify(target));
    resolveCardPreview(
      target,
      { coverPropertyId: "cover", showProperties: ["status"] },
      { properties },
    );
    expect(target).toEqual(snapshot);
    expect(values).toEqual([{ propertyId: "cover", value: "https://cdn.test/x.png" }]);
  });
});

describe("validatePreviewConfig", () => {
  it("accepts a valid config", () => {
    expect(
      validatePreviewConfig(
        {
          coverPropertyId: "cover",
          contentPropertyId: "body",
          fit: "contain",
          aspect: 4 / 3,
          showProperties: ["status"],
        },
        { properties },
      ),
    ).toEqual([]);
  });

  it("flags an unknown cover property", () => {
    const issues = validatePreviewConfig({ coverPropertyId: "ghost" }, { properties });
    expect(issues.map((issue) => issue.code)).toContain("UNKNOWN_COVER_PROPERTY");
  });

  it("flags a cover property that is not media", () => {
    const issues = validatePreviewConfig({ coverPropertyId: "body" }, { properties });
    expect(issues.map((issue) => issue.code)).toContain("COVER_NOT_MEDIA");
  });

  it("flags an unknown content property", () => {
    const issues = validatePreviewConfig({ contentPropertyId: "ghost" }, { properties });
    expect(issues.map((issue) => issue.code)).toContain("UNKNOWN_CONTENT_PROPERTY");
  });

  it("flags an invalid fit and aspect", () => {
    const codes = validatePreviewConfig(
      { fit: "stretch", aspect: -1 },
      { properties },
    ).map((issue) => issue.code);
    expect(codes).toContain("INVALID_FIT");
    expect(codes).toContain("INVALID_ASPECT");
  });

  it("flags unknown showProperties ids", () => {
    const issues = validatePreviewConfig(
      { showProperties: ["status", "ghost"] },
      { properties },
    );
    expect(issues.map((issue) => issue.code)).toContain("UNKNOWN_SHOW_PROPERTY");
  });

  it("never throws on garbage", () => {
    expect(() => validatePreviewConfig("nonsense", { properties })).not.toThrow();
    expect(validatePreviewConfig("nonsense", { properties })[0]?.code).toBe(
      "INVALID_CONFIG",
    );
  });
});

describe("describePreview", () => {
  it("describes the defaults", () => {
    expect(describePreview({})).toBe(
      "Gallery preview: cover auto, content auto, fit cover, title shown, no badges",
    );
  });

  it("describes a fully configured card", () => {
    expect(
      describePreview({
        coverPropertyId: "cover",
        contentPropertyId: "body",
        fit: "contain",
        aspect: 1.5,
        showTitle: false,
        showProperties: ["status", "owner"],
      }),
    ).toBe(
      'Gallery preview: cover "cover", content "body", fit contain, aspect 1.5, title hidden, badges status, owner',
    );
  });

  it("is fail-safe on unreadable input", () => {
    expect(() => describePreview("{oops")).not.toThrow();
    expect(describePreview("{oops")).toBe(
      "Gallery preview: cover auto, content auto, fit cover, title shown, no badges",
    );
    expect(describePreview(null)).toContain("cover auto");
  });
});

describe("preview type constants", () => {
  it("exposes the cover-eligible types", () => {
    expect([...COVER_IMAGE_PROPERTY_TYPES]).toEqual(["files", "media", "url"]);
  });

  it("excludes media and title types from badges", () => {
    expect([...BADGE_EXCLUDED_PROPERTY_TYPES]).toEqual(["files", "media", "title"]);
  });
});
