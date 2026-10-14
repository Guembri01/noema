import { describe, expect, it } from "vitest";
import { common, createLowlight } from "lowlight";
import {
  CODE_LANGUAGES,
  codeLanguageLabel,
  findCodeLanguage,
  lowlightNameFor,
  searchCodeLanguages,
} from "@/lib/code-languages";

describe("code-languages", () => {
  it("lists at least 25 languages with labels", () => {
    expect(CODE_LANGUAGES.length).toBeGreaterThanOrEqual(25);
    for (const entry of CODE_LANGUAGES) {
      expect(entry.value).toBeTruthy();
      expect(entry.label).toBeTruthy();
      // Values must be lowercase slugs so they round-trip through markdown fences.
      expect(entry.value).toBe(entry.value.toLowerCase());
    }
    // A few well-known languages the Notion picker must offer.
    const values = CODE_LANGUAGES.map((l) => l.value);
    expect(values).toContain("typescript");
    expect(values).toContain("python");
    expect(values).toContain("plaintext");
  });

  it("maps every language to a registered lowlight grammar name", () => {
    const lowlight = createLowlight(common);
    const registered = lowlight.listLanguages();
    for (const entry of CODE_LANGUAGES) {
      expect(
        registered,
        `${entry.value} -> ${entry.lowlight} must be a lowlight common grammar`,
      ).toContain(entry.lowlight);
      // And the grammar must actually highlight, not just be listed.
      expect(() => lowlight.highlight(entry.lowlight, "let x = 1;")).not.toThrow();
    }
  });

  it("resolves stored values (incl. markdown-fence aliases) to grammar names", () => {
    expect(lowlightNameFor("typescript")).toBe("typescript");
    expect(lowlightNameFor("ts")).toBe("typescript");
    expect(lowlightNameFor("py")).toBe("python");
    expect(lowlightNameFor("js")).toBe("javascript");
    expect(lowlightNameFor("html")).toBe("xml");
    expect(lowlightNameFor(null)).toBeNull();
    expect(lowlightNameFor("")).toBeNull();
    expect(lowlightNameFor("definitely-not-a-language")).toBeNull();

    expect(findCodeLanguage("TS")?.label).toBe("TypeScript");
    expect(findCodeLanguage(null)).toBeUndefined();
  });

  it("labels unknown languages with their raw value and falls back to Plain text", () => {
    expect(codeLanguageLabel(null)).toBe("Plain text");
    expect(codeLanguageLabel("")).toBe("Plain text");
    expect(codeLanguageLabel("typescript")).toBe("TypeScript");
    // A fence lang outside the registry still shows something sane.
    expect(codeLanguageLabel("dart")).toBe("dart");
  });

  it("exposes a searchable label list", () => {
    // Empty query returns everything, in registry order.
    expect(searchCodeLanguages("")).toHaveLength(CODE_LANGUAGES.length);
    expect(searchCodeLanguages("   ")).toHaveLength(CODE_LANGUAGES.length);

    const byLabel = searchCodeLanguages("type");
    expect(byLabel.some((l) => l.value === "typescript")).toBe(true);

    // Case-insensitive substring over label…
    expect(searchCodeLanguages("PYTHON").map((l) => l.value)).toContain("python");
    // …over aliases too.
    expect(searchCodeLanguages("sh").map((l) => l.value)).toContain("shell");
    expect(searchCodeLanguages("jsx").map((l) => l.value)).toContain("javascript");

    // No matches yields an empty list, never a crash.
    expect(searchCodeLanguages("zzz-nope")).toEqual([]);
  });
});
