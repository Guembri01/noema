import { describe, expect, it } from "vitest";
import {
  SUPPORTED_LOCALES,
  isValidLanguageTag,
  matchLanguage,
  normalizeLanguageTag,
  parseLanguageTag,
} from "@/lib/language-tag";

/* BCP-47 tags here are deliberately mixed-case / reordered on input: the whole
   point of the module is to funnel everything through the platform canonical
   form, so expectations record what that form *is* rather than what was typed. */

describe("parseLanguageTag", () => {
  it("parses a bare language subtag", () => {
    expect(parseLanguageTag("en")).toEqual({ language: "en", variants: [] });
  });

  it("parses language + region", () => {
    expect(parseLanguageTag("en-US")).toEqual({
      language: "en",
      region: "US",
      variants: [],
    });
  });

  it("parses language + script", () => {
    expect(parseLanguageTag("zh-Hant")).toEqual({
      language: "zh",
      script: "Hant",
      variants: [],
    });
  });

  it("parses language + script + region", () => {
    expect(parseLanguageTag("zh-Hant-TW")).toEqual({
      language: "zh",
      script: "Hant",
      region: "TW",
      variants: [],
    });
  });

  it("parses numeric and alphanumeric variants", () => {
    expect(parseLanguageTag("de-DE-1901-1996")).toEqual({
      language: "de",
      region: "DE",
      variants: ["1901", "1996"],
    });
  });

  it("applies BCP-47 canonical ordering to variants", () => {
    expect(parseLanguageTag("sl-rozaj-biske-1994")).toEqual({
      language: "sl",
      variants: ["1994", "biske", "rozaj"],
    });
  });

  it("canonicalises casing before parsing", () => {
    expect(parseLanguageTag("EN-us")).toEqual({
      language: "en",
      region: "US",
      variants: [],
    });
  });

  it("maps deprecated language subtags to their preferred form", () => {
    expect(parseLanguageTag("iw")).toEqual({ language: "he", variants: [] });
  });

  it("stops before extension and private-use subtags", () => {
    expect(parseLanguageTag("en-US-u-ca-gregory")).toEqual({
      language: "en",
      region: "US",
      variants: [],
    });
  });

  it("returns null for malformed tags", () => {
    expect(parseLanguageTag("")).toBeNull();
    expect(parseLanguageTag("en_US")).toBeNull();
    expect(parseLanguageTag("en-")).toBeNull();
    expect(parseLanguageTag("not a tag")).toBeNull();
  });
});

describe("isValidLanguageTag", () => {
  it("accepts structurally valid BCP-47 tags", () => {
    expect(isValidLanguageTag("en")).toBe(true);
    expect(isValidLanguageTag("en-US")).toBe(true);
    expect(isValidLanguageTag("zh-Hant-TW")).toBe(true);
    expect(isValidLanguageTag("de-DE-1901")).toBe(true);
    // Structurally sound even though no one speaks "en-XZ".
    expect(isValidLanguageTag("en-XZ")).toBe(true);
  });

  it("rejects malformed tags", () => {
    expect(isValidLanguageTag("")).toBe(false);
    expect(isValidLanguageTag("en_US")).toBe(false);
    expect(isValidLanguageTag("-en")).toBe(false);
    expect(isValidLanguageTag("en-")).toBe(false);
    expect(isValidLanguageTag("123")).toBe(false);
  });
});

describe("normalizeLanguageTag", () => {
  it("returns the canonical casing and subtag order", () => {
    expect(normalizeLanguageTag("EN-us")).toBe("en-US");
    expect(normalizeLanguageTag("zh-hant-tw")).toBe("zh-Hant-TW");
    expect(normalizeLanguageTag("sl-rozaj-biske")).toBe("sl-biske-rozaj");
  });

  it("rewrites deprecated subtags", () => {
    expect(normalizeLanguageTag("iw")).toBe("he");
    expect(normalizeLanguageTag("in")).toBe("id");
  });

  it("returns null for malformed tags", () => {
    expect(normalizeLanguageTag("en_US")).toBeNull();
    expect(normalizeLanguageTag("")).toBeNull();
  });
});

describe("SUPPORTED_LOCALES", () => {
  it("is a non-empty list of unique, valid tags", () => {
    expect(SUPPORTED_LOCALES.length).toBeGreaterThanOrEqual(5);
    expect(new Set(SUPPORTED_LOCALES).size).toBe(SUPPORTED_LOCALES.length);
    for (const locale of SUPPORTED_LOCALES) {
      expect(isValidLanguageTag(locale)).toBe(true);
    }
  });

  it("covers the base UI languages", () => {
    expect(SUPPORTED_LOCALES).toContain("en");
    expect(SUPPORTED_LOCALES).toContain("fr");
  });
});

describe("matchLanguage", () => {
  it("prefers an exact tag match", () => {
    expect(matchLanguage(["en-US"], ["en-GB", "en-US"])).toBe("en-US");
  });

  it("matches case-insensitively via canonicalisation", () => {
    expect(matchLanguage(["EN-us"], ["en-US"])).toBe("en-US");
  });

  it("uses the region as the tie-breaker", () => {
    expect(matchLanguage(["en-GB"], ["en-US", "en-GB"])).toBe("en-GB");
  });

  it("falls back to language when the region is missing", () => {
    expect(matchLanguage(["en-GB"], ["en-US"])).toBe("en-US");
  });

  it("matches a region-less preference against any region", () => {
    expect(matchLanguage(["en"], ["en-GB", "en-US"])).toBe("en-GB");
  });

  it("honours the preference order", () => {
    expect(matchLanguage(["fr", "en"], ["en-US", "fr-FR"])).toBe("fr-FR");
  });

  it("returns the canonical form of the matched locale", () => {
    expect(matchLanguage(["zh-hant"], ["zh-Hant-TW"])).toBe("zh-Hant-TW");
  });

  it("skips invalid entries on both sides", () => {
    expect(matchLanguage(["en_US", "en"], ["not a tag", "en-GB"])).toBe("en-GB");
  });

  it("returns null when nothing matches", () => {
    expect(matchLanguage(["ja"], ["en-US", "fr-FR"])).toBeNull();
    expect(matchLanguage([], ["en"])).toBeNull();
    expect(matchLanguage(["en"], [])).toBeNull();
  });
});
