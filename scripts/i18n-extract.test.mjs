// Production-caller test for `scripts/i18n-extract.ts` — the i18n extraction
// workflow layered on the pure `src/lib/i18n-scan.ts` analyser. It pins the
// locale canonicalisation, the catalogue parser, the scan→merge→diff pipeline
// and the heap-ranked "files with the most work" list, without touching the
// filesystem or the real catalogue.
import { describe, expect, it } from "vitest";
import {
  buildExtractionWorkflow,
  formatWorkflowReport,
  normalizeLocales,
  parseCatalog,
  topFilesByGaps,
} from "./i18n-extract.ts";

const CATALOG_SOURCE = `const en = {
  save: "Save",
  cancel: "Cancel",
};

const DICTS = {
  en,
  fr: {
    save: "Enregistrer",
    cancel: "Annuler",
  },
};
`;

const PNG_FILE = {
  path: "components/example.tsx",
  source: [
    "export function Example() {",
    "  return <button title=\"Save changes now\">Delete this row</button>;",
    "}",
  ].join("\n"),
};

describe("normalizeLocales", () => {
  it("canonicalises and de-duplicates tags", () => {
    expect(normalizeLocales(["EN-us", "fr", "en-US", "zh-hans"])).toEqual([
      "en-US",
      "fr",
      "zh-Hans",
    ]);
  });

  it("rejects a malformed tag", () => {
    expect(() => normalizeLocales(["not a locale!"])).toThrow(/invalid BCP-47/);
  });
});

describe("parseCatalog", () => {
  it("reads each locale block's key/value pairs", () => {
    const catalog = parseCatalog(CATALOG_SOURCE, ["en", "fr"]);
    expect(Object.keys(catalog.en)).toEqual(["save", "cancel"]);
    expect(catalog.en.save).toBe("Save");
    expect(catalog.fr.cancel).toBe("Annuler");
  });

  it("throws when a requested locale block is absent", () => {
    expect(() => parseCatalog(CATALOG_SOURCE, ["en", "de"])).toThrow(/locale de/);
  });
});

describe("buildExtractionWorkflow", () => {
  it("proposes keys, merges them and reports the per-locale delta", () => {
    const workflow = buildExtractionWorkflow({
      files: [PNG_FILE],
      catalog: parseCatalog(CATALOG_SOURCE, ["en", "fr"]),
      locales: ["en", "fr"],
    });

    expect(workflow.report.totals.found).toBeGreaterThanOrEqual(1);
    // The two hard-coded strings each yield a suggestion, none of which exist.
    expect(workflow.proposals.length).toBe(workflow.report.totals.found);
    expect(workflow.added.length).toBe(workflow.proposals.length);
    expect(workflow.duplicates).toEqual([]);
    // `mergeIntoCatalog` appends new keys to every locale, so each locale's
    // `extra` set is exactly the added keys (the existing ones are unchanged).
    expect(workflow.diff.en.extra).toEqual(workflow.added);
    expect(workflow.diff.fr.extra).toEqual(workflow.added);
    expect(workflow.diff.en.missing).toEqual([]);

    const text = formatWorkflowReport(workflow, ["en", "fr"]);
    expect(text).toContain("coverage:");
    expect(text).toContain("components/example.tsx");
  });

  it("skips strings already covered by a catalogue key", () => {
    const covered = {
      path: "components/covered.tsx",
      source: 'export function C() { return <span title="Save changes now">x</span>; }',
    };
    const workflow = buildExtractionWorkflow({
      files: [covered],
      catalog: { en: { "Save changes now": "Save changes now" } },
      locales: ["en"],
    });
    expect(workflow.report.totals.found).toBe(0);
    expect(workflow.added).toEqual([]);
  });
});

describe("topFilesByGaps", () => {
  it("ranks files by un-translated string count, best-first", () => {
    const workflow = buildExtractionWorkflow({
      files: [
        { path: "a.tsx", source: '<a title="Alpha row here">one two three</a>' },
        { path: "b.tsx", source: "<a/>" },
        { path: "c.tsx", source: '<a title="Charlie row here">gamma delta epsilon</a>' },
      ],
      catalog: { en: {} },
      locales: ["en"],
    });
    const top = topFilesByGaps(workflow.report, 2);
    expect(top).toHaveLength(2);
    expect(top.every((file) => file.found.length > 0)).toBe(true);
    expect(top[0].found.length).toBeGreaterThanOrEqual(top[1].found.length);
    // b.tsx has no work and must not outrank the others.
    expect(top.map((file) => file.file)).not.toContain("b.tsx");
  });
});
