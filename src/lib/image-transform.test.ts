import { describe, expect, it } from "vitest";
import {
  buildTransformQuery,
  parseTransformQuery,
  stripTransform,
  MAX_DIMENSION,
  MAX_QUALITY,
  type Fit,
  type Format,
  type TransformOptions,
} from "./image-transform";

/**
 * Image transform URL params — the pure query-string contract for a
 * resize/format CDN (FEATURE_MATRIX "Image transform").
 *
 * Written RED-first against a missing module, then implemented. Coverage pins:
 * - canonical param names (`w`,`h`,`fit`,`format`,`q`) in a fixed order,
 * - single-slash baseUrl/path joining, and no `?` when nothing is set,
 * - range validation: positive numbers are rounded and clamped, while
 *   wrong-typed, non-finite, non-positive and unknown-enum values are ignored,
 * - dedupe: transform params already on the path are replaced, unrelated query
 *   params survive; duplicate keys parse with the first valid occurrence,
 * - parse/strip round-trips, hash handling and absolute URLs.
 */

describe("buildTransformQuery — signed-free URL from options + target", () => {
  it("emits transform params in canonical order w,h,fit,format,q", () => {
    expect(
      buildTransformQuery(
        { quality: 80, format: "webp", fit: "cover", h: 480, w: 640 },
        { baseUrl: "/img", path: "photos/cat.png" },
      ),
    ).toBe("/img/photos/cat.png?w=640&h=480&fit=cover&format=webp&q=80");
  });

  it("joins baseUrl/path with a single slash and emits only supplied params", () => {
    expect(
      buildTransformQuery({ w: 120 }, { baseUrl: "/img/", path: "/a/b.png" }),
    ).toBe("/img/a/b.png?w=120");
    expect(
      buildTransformQuery({ format: "auto" }, { baseUrl: "https://cdn.example.com/", path: "a.png" }),
    ).toBe("https://cdn.example.com/a.png?format=auto");
  });

  it("omits the query entirely when nothing is set", () => {
    expect(buildTransformQuery({}, { baseUrl: "/img", path: "a.png" })).toBe("/img/a.png");
  });

  it("ignores wrong-typed, non-finite and unknown-enum values", () => {
    expect(
      buildTransformQuery(
        { w: -4, h: Number.NaN, fit: "stretch" as Fit, format: "gif" as Format, quality: 0 },
        { baseUrl: "/img", path: "a.png" },
      ),
    ).toBe("/img/a.png");
  });

  it("rounds and clamps dimensions/quality into their ranges", () => {
    expect(
      buildTransformQuery(
        { w: 999_999, h: 20_000, quality: 150 },
        { baseUrl: "/i", path: "a.png" },
      ),
    ).toBe(`/i/a.png?w=${MAX_DIMENSION}&h=${MAX_DIMENSION}&q=${MAX_QUALITY}`);
    expect(
      buildTransformQuery({ w: 100.6, quality: 74.4 }, { baseUrl: "/i", path: "a.png" }),
    ).toBe("/i/a.png?w=101&q=74");
  });

  it("replaces transform params already on the path (dedupe) and keeps unrelated ones", () => {
    expect(
      buildTransformQuery(
        { w: 800 },
        { baseUrl: "/img", path: "a.png?w=100&v=2&w=300&fit=contain" },
      ),
    ).toBe("/img/a.png?v=2&w=800");
  });

  it("does not mutate the options or target it is given", () => {
    const options: TransformOptions = Object.freeze({ w: 640, quality: 50 });
    const target = Object.freeze({ baseUrl: "/img", path: "a.png" });
    expect(buildTransformQuery(options, target)).toBe("/img/a.png?w=640&q=50");
  });
});

describe("parseTransformQuery — normalised options from a URL", () => {
  it("parses every supported param into normalised options", () => {
    expect(
      parseTransformQuery("/img/a.png?w=640&h=480&fit=contain&format=webp&q=60"),
    ).toEqual({ w: 640, h: 480, fit: "contain", format: "webp", quality: 60 });
  });

  it("ignores unknown params and invalid values, clamping numbers", () => {
    expect(
      parseTransformQuery("/a.png?w=-1&h=abc&fit=stretch&format=gif&q=999&x=1"),
    ).toEqual({ quality: MAX_QUALITY });
  });

  it("dedupes duplicate keys with the first valid occurrence winning", () => {
    expect(parseTransformQuery("/a.png?w=100&w=300")).toEqual({ w: 100 });
    expect(parseTransformQuery("/a.png?w=abc&w=300")).toEqual({ w: 300 });
  });

  it("returns an empty object when there is no query or no transform params", () => {
    expect(parseTransformQuery("/a.png")).toEqual({});
    expect(parseTransformQuery("/a.png?v=2#frag")).toEqual({});
    expect(parseTransformQuery("")).toEqual({});
  });

  it("ignores the hash and handles absolute URLs", () => {
    expect(parseTransformQuery("https://cdn.example.com/a.png?w=5#frag")).toEqual({ w: 5 });
  });

  it("round-trips through buildTransformQuery", () => {
    const options: TransformOptions = {
      w: 640,
      h: 480,
      fit: "cover",
      format: "auto",
      quality: 75,
    };
    expect(parseTransformQuery(buildTransformQuery(options, { baseUrl: "/i", path: "a.png" }))).toEqual(
      options,
    );
  });
});

describe("stripTransform — remove transform params, keep everything else", () => {
  it("removes only transform params, preserving unrelated ones", () => {
    expect(stripTransform("/img/a.png?w=100&v=2&q=70")).toBe("/img/a.png?v=2");
  });

  it("drops the query entirely when only transform params were present", () => {
    expect(stripTransform("/img/a.png?w=100&fit=cover")).toBe("/img/a.png");
  });

  it("is a no-op for URLs without transform params", () => {
    expect(stripTransform("/img/a.png?v=2")).toBe("/img/a.png?v=2");
    expect(stripTransform("/img/a.png")).toBe("/img/a.png");
  });

  it("preserves the hash and is idempotent", () => {
    expect(stripTransform("/a.png?w=1&v=2#frag")).toBe("/a.png?v=2#frag");
    expect(stripTransform(stripTransform("/a.png?w=1&v=2#frag"))).toBe("/a.png?v=2#frag");
    expect(stripTransform("https://cdn.example.com/a.png?q=50")).toBe("https://cdn.example.com/a.png");
  });
});
