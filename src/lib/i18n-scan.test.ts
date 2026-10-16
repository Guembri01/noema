import { describe, expect, it } from "vitest";
import {
  buildExtractionReport,
  diffCatalog,
  findHardcodedStrings,
  mergeIntoCatalog,
  suggestKey,
} from "./i18n-scan";
import type { Catalog, CatalogEntry } from "./i18n-scan";

/**
 * Gap #15 / §16 - i18n string extraction.
 *
 * These tests pin the *analyser*, not the catalogue: what counts as a
 * user-facing hard-coded string, how a stable key is proposed for it, how a
 * batch of findings maps onto a report, how new keys merge into the five-locale
 * catalogue without disturbing order or duplicates, and how two catalogue
 * revisions diff per locale.
 *
 * Red-first: written before `i18n-scan.ts` existed, so the import failed and
 * every case below was red. The implementation lands to make them green.
 *
 * The analyser is deliberately conservative - it would rather miss an
 * ambiguous single word than flag `className`, a URL, a CSS unit or a string
 * that already flows through `t(locale, key)`.
 */

const PATH = "src/components/database-view.tsx";

describe("findHardcodedStrings - JSX text nodes", () => {
  it("flags user-facing text between tags, with a 1-based line number", () => {
    const source = ['<button className="primary">', "  Save changes", "</button>"].join(
      "\n",
    );
    expect(findHardcodedStrings(source, { filePath: PATH })).toEqual([
      { text: "Save changes", line: 2, kind: "text" },
    ]);
  });

  it("collapses multi-line text into one single-spaced node", () => {
    const source = "<p>\n  Please confirm\n  your email\n</p>";
    expect(findHardcodedStrings(source, { filePath: PATH })).toEqual([
      { text: "Please confirm your email", line: 2, kind: "text" },
    ]);
  });

  it("reports every text node in source order", () => {
    const source = [
      "<div>",
      "  First string here",
      "  <span>Second string here</span>",
      "</div>",
    ].join("\n");
    expect(findHardcodedStrings(source, { filePath: PATH })).toEqual([
      { text: "First string here", line: 2, kind: "text" },
      { text: "Second string here", line: 3, kind: "text" },
    ]);
  });

  it("finds text nested in a JSX fragment", () => {
    const source = "<>{/* note */}\n  Nothing to see here\n</>";
    // The comment is masked; the visible text is a single node.
    expect(findHardcodedStrings(source, { filePath: PATH })).toEqual([
      { text: "Nothing to see here", line: 2, kind: "text" },
    ]);
  });

  it("ignores text produced by an expression container", () => {
    const source = '<span>{"expression text"}</span>';
    expect(findHardcodedStrings(source, { filePath: PATH })).toEqual([]);
  });
});

describe("findHardcodedStrings - quoted user-facing attributes", () => {
  it("flags a multi-word placeholder and records the attribute name", () => {
    const source = '<input placeholder="Search all pages" />';
    expect(findHardcodedStrings(source, { filePath: PATH })).toEqual([
      { text: "Search all pages", line: 1, kind: "attribute", attribute: "placeholder" },
    ]);
  });

  it("flags title, label and alt (allow-listed, user-facing)", () => {
    const source = [
      '<a title="Open this page">link</a>',
      '<label label="Choose a colour"></label>',
      '<img alt="A photo of the team" />',
    ].join("\n");
    expect(
      findHardcodedStrings(source, { filePath: PATH }).map((hit) => hit.attribute),
    ).toEqual(["title", "label", "alt"]);
  });

  it("matches attribute names case-insensitively", () => {
    const source = '<Field Placeholder="Enter a value" />';
    expect(findHardcodedStrings(source, { filePath: PATH })).toEqual([
      { text: "Enter a value", line: 1, kind: "attribute", attribute: "Placeholder" },
    ]);
  });

  it("keeps line numbers for attributes on later lines", () => {
    const source = '<input\n  type="text"\n  title="Pick a due date"\n/>';
    expect(findHardcodedStrings(source, { filePath: PATH })).toEqual([
      { text: "Pick a due date", line: 3, kind: "attribute", attribute: "title" },
    ]);
  });
});

describe("findHardcodedStrings - false-positive suppression", () => {
  it("skips import and require module paths", () => {
    const source = [
      'import { t } from "./i18n";',
      'import "server-only";',
      'const fs = require("node:fs");',
    ].join("\n");
    expect(findHardcodedStrings(source, { filePath: PATH })).toEqual([]);
  });

  it("skips className and other styling attributes", () => {
    const source = [
      '<div className="flex items-center gap-2">ok</div>',
      '<div class="grid grid-cols-2"></div>',
      '<div style="display: flex"></div>',
    ].join("\n");
    expect(findHardcodedStrings(source, { filePath: PATH })).toEqual([]);
  });

  it("skips data-* and aria-* technical attributes", () => {
    const source = [
      '<button data-testid="save dialog button" aria-label="Close dialog here"></button>',
      '<div data-state="open menu"></div>',
    ].join("\n");
    expect(findHardcodedStrings(source, { filePath: PATH })).toEqual([]);
  });

  it("skips urls, mail links and relative paths", () => {
    const source = [
      '<a href="https://example.com/some/page">x</a>',
      '<a href="mailto:help@example.com"></a>',
      '<img src="/assets/team photo.png" />',
      '<img src="./local image.png" />',
    ].join("\n");
    expect(findHardcodedStrings(source, { filePath: PATH })).toEqual([]);
  });

  it("skips CSS units and bare numbers", () => {
    const source = [
      '<div width="10px" height="1.5rem"></div>',
      '<span>42</span>',
      '<span>1,000</span>',
    ].join("\n");
    expect(findHardcodedStrings(source, { filePath: PATH })).toEqual([]);
  });

  it("skips single words without a space", () => {
    const source = [
      "<button>Save</button>",
      '<input placeholder="Search" />',
      "<span>Cancel</span>",
    ].join("\n");
    expect(findHardcodedStrings(source, { filePath: PATH })).toEqual([]);
  });

  it("skips code identifiers and kebab/snake tokens", () => {
    const source = [
      "<div>camelCaseIdentifier</div>",
      "<div>snake_case_name</div>",
      "<div>kebab-case-name</div>",
    ].join("\n");
    expect(findHardcodedStrings(source, { filePath: PATH })).toEqual([]);
  });

  it("skips strings already routed through t(locale, key)", () => {
    const source = [
      '<button title={t(locale, "openSidePeek")}>Open side peek</button>',
      '<span>{t(locale, "somethingWentWrong")}</span>',
    ].join("\n");
    // Only the raw text node survives; both t() keys are already translated.
    expect(findHardcodedStrings(source, { filePath: PATH })).toEqual([
      { text: "Open side peek", line: 1, kind: "text" },
    ]);
  });

  it("skips a value that is already a catalogue key", () => {
    const source = "<span>Save changes</span>";
    expect(
      findHardcodedStrings(source, { filePath: PATH, catalogKeys: ["Save changes"] }),
    ).toEqual([]);
  });

  it("ignores strings inside comments", () => {
    const source = [
      "// TODO: replace this hardcoded string",
      "/* a block comment with words */",
      "<div>Real text here</div>",
    ].join("\n");
    expect(findHardcodedStrings(source, { filePath: PATH })).toEqual([
      { text: "Real text here", line: 3, kind: "text" },
    ]);
  });

  it("ignores interpolated template literal text", () => {
    const source = "<span>{`${count} items selected`}</span>";
    expect(findHardcodedStrings(source, { filePath: PATH })).toEqual([]);
  });
});

describe("suggestKey - stable camelCase catalogue keys", () => {
  it("camel-cases a plain sentence", () => {
    expect(suggestKey("Open side peek")).toBe("openSidePeek");
  });

  it("drops punctuation and hyphens", () => {
    expect(suggestKey("Two-factor authentication")).toBe("twoFactorAuthentication");
  });

  it("keeps digits attached to the previous word", () => {
    expect(suggestKey("Heading 1")).toBe("heading1");
  });

  it("prefixes a leading digit so the key is a valid identifier", () => {
    expect(suggestKey("2FA setup")).toBe("key2FaSetup");
  });

  it("namespaces with the surface when given", () => {
    expect(suggestKey("Open side peek", { surface: "database" })).toBe(
      "databaseOpenSidePeek",
    );
  });

  it("normalises the surface too", () => {
    expect(suggestKey("Search", { surface: "row menu" })).toBe("rowMenuSearch");
  });

  it("is idempotent - its own output is a fixed point", () => {
    const once = suggestKey("Something went wrong");
    expect(suggestKey(once)).toBe(once);
  });

  it("is stable across whitespace and quote variants", () => {
    expect(suggestKey("  Something   went wrong  ")).toBe(
      suggestKey('"Something went wrong"'),
    );
  });

  it("falls back to a usable key for punctuation-only input", () => {
    expect(suggestKey("!!!")).toBe("key");
    expect(suggestKey("")).toBe("key");
  });
});

describe("buildExtractionReport", () => {
  const source = [
    'import { t } from "./i18n";',
    '<div>',
    '  <span title="Close this panel">Save changes</span>',
    '  <span>{t(locale, "home")}</span>',
    "</div>",
  ].join("\n");

  it("reports per-file findings with a surface-qualified suggestion", () => {
    const report = buildExtractionReport([
      { path: "src/components/database-view.tsx", source },
    ]);
    expect(report.files).toEqual([
      {
        file: "src/components/database-view.tsx",
        found: [
          {
            text: "Close this panel",
            line: 3,
            suggestion: "databaseViewCloseThisPanel",
          },
          { text: "Save changes", line: 3, suggestion: "databaseViewSaveChanges" },
        ],
        existingKeysUsed: ["home"],
        coverage: 1 / 3,
      },
    ]);
  });

  it("summarises totals across files", () => {
    const report = buildExtractionReport([
      { path: "src/a.tsx", source: '<div>One two three</div>\n{t(locale, "x")}' },
      { path: "src/b.tsx", source: '<div>Four five</div>' },
    ]);
    expect(report.totals).toEqual({
      found: 2,
      existingKeysUsed: 1,
      coverage: 1 / 3,
    });
  });

  it("counts a file with nothing to do as fully covered", () => {
    const report = buildExtractionReport([
      { path: "src/clean.tsx", source: 'import "x";\nconst n = 1;' },
    ]);
    expect(report.files[0]).toEqual({
      file: "src/clean.tsx",
      found: [],
      existingKeysUsed: [],
      coverage: 1,
    });
  });

  it("keeps files independent and in input order", () => {
    const report = buildExtractionReport([
      { path: "src/second.tsx", source: "<div>Second file text</div>" },
      { path: "src/first.tsx", source: "<div>First file text</div>" },
    ]);
    expect(report.files.map((entry) => entry.file)).toEqual([
      "src/second.tsx",
      "src/first.tsx",
    ]);
  });
});

describe("mergeIntoCatalog", () => {
  const base: Catalog = {
    en: { search: "Search", home: "Home" },
    fr: { search: "Rechercher", home: "Accueil" },
  };

  const entries: CatalogEntry[] = [
    { key: "openSidePeek", values: { en: "Open side peek", fr: "Ouvrir l'apercu" } },
    { key: "noFrench", values: { en: "No French", de: "Kein Franzosisch" } },
  ];

  it("appends per-locale entries preserving catalogue order", () => {
    const { catalog } = mergeIntoCatalog(base, entries, ["en", "fr", "de"]);
    expect(Object.keys(catalog.en)).toEqual(["search", "home", "openSidePeek", "noFrench"]);
    expect(Object.keys(catalog.fr)).toEqual(["search", "home", "openSidePeek", "noFrench"]);
  });

  it("falls back to English for a missing translation", () => {
    const { catalog } = mergeIntoCatalog(base, entries, ["en", "fr", "de"]);
    expect(catalog.fr.noFrench).toBe("No French");
    expect(catalog.de.openSidePeek).toBe("Open side peek");
    expect(catalog.de.noFrench).toBe("Kein Franzosisch");
  });

  it("creates a locale block that did not exist yet", () => {
    const { catalog } = mergeIntoCatalog(base, entries, ["en", "fr", "de"]);
    expect(catalog.de).toEqual({
      openSidePeek: "Open side peek",
      noFrench: "Kein Franzosisch",
    });
  });

  it("does not mutate the input catalogue", () => {
    const before = JSON.stringify(base);
    mergeIntoCatalog(base, entries, ["en", "fr", "de"]);
    expect(JSON.stringify(base)).toBe(before);
  });

  it("reports the added keys in insertion order", () => {
    const { added } = mergeIntoCatalog(base, entries, ["en", "fr", "de"]);
    expect(added).toEqual(["openSidePeek", "noFrench"]);
  });

  it("guards against a duplicate key already in the catalogue", () => {
    const dupe: CatalogEntry[] = [
      { key: "search", values: { en: "Search again" } },
      { key: "fresh", values: { en: "Fresh value" } },
    ];
    const { catalog, added, duplicates } = mergeIntoCatalog(base, dupe, ["en", "fr"]);
    expect(duplicates).toEqual(["search"]);
    expect(added).toEqual(["fresh"]);
    // The original value is untouched - no silent overwrite.
    expect(catalog.en.search).toBe("Search");
    expect(Object.keys(catalog.en)).toEqual(["search", "home", "fresh"]);
  });

  it("collapses duplicates within the same entry batch", () => {
    const dupes: CatalogEntry[] = [
      { key: "twice", values: { en: "First" } },
      { key: "twice", values: { en: "Second" } },
    ];
    const { catalog, added, duplicates } = mergeIntoCatalog(base, dupes, ["en"]);
    expect(added).toEqual(["twice"]);
    expect(duplicates).toEqual(["twice"]);
    expect(catalog.en.twice).toBe("First");
  });
});

describe("diffCatalog", () => {
  it("reports missing and extra keys per locale", () => {
    const a: Catalog = { en: { home: "Home", search: "Search" }, fr: { home: "Accueil" } };
    const b: Catalog = { en: { home: "Home", inbox: "Inbox" }, de: { inbox: "Postfach" } };
    expect(diffCatalog(a, b)).toEqual({
      en: { missing: ["search"], extra: ["inbox"] },
      fr: { missing: ["home"], extra: [] },
      de: { missing: [], extra: ["inbox"] },
    });
  });

  it("returns empty deltas for identical catalogues", () => {
    const a: Catalog = { en: { home: "Home" } };
    expect(diffCatalog(a, a)).toEqual({ en: { missing: [], extra: [] } });
  });

  it("handles locales present on only one side", () => {
    expect(diffCatalog({ en: { a: "A" } }, {})).toEqual({
      en: { missing: ["a"], extra: [] },
    });
    expect(diffCatalog({}, { ar: { b: "B" } })).toEqual({
      ar: { missing: [], extra: ["b"] },
    });
  });
});
